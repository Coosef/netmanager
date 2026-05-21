# Post-mortem — Prometheus multiproc tmpfs saturation → backend SIGBUS restart loop

> **Date:** 2026-05-21
> **Severity:** Production-down (~1 hour of degraded service before detection, fully restored after intervention)
> **Resolved by:** T9 hotfix commit (this branch)

---

## 1. Summary

At ~08:35 UTC the production backend on `netmanager.systrack.app`
entered a restart loop that lasted until manual intervention at ~09:34
UTC. Symptoms: API down, "veriler gözükmüyor" reported by the user;
backend container in `Restarting (135)` state with `RestartCount = 56`;
all three Celery worker containers marked `unhealthy` with healthcheck
output `Bus error (core dumped)`.

Root cause: the shared `prom_multiproc` tmpfs volume (64 MB) had been
saturated by 17,183 stale `.db` files left behind by forked Celery
worker children whose PIDs respawn over the container's lifetime. Once
the tmpfs hit 100 % usage every new `mmap` write returned **SIGBUS**;
both the application processes and the `/health/live` healthcheck
probe crashed with the same signal, so the unless-stopped restart
policy kept re-spawning a container that could not finish booting.

## 2. Timeline (Türkiye saati ≈ UTC + 3)

| Time | Event |
|---|---|
| ~07:30 UTC | Backend bridge listener started cleanly after a Faz 9 #6 retry-connector boot. |
| 07:30 – 08:35 UTC | Normal operation; `agent-relay` requests, agent reconnects, OUI backfill. |
| ~08:35 UTC | First SIGBUS recorded on a Celery worker child during a routine respawn — tmpfs already saturated by accumulated stale `.db` files. |
| 08:35 – 09:30 UTC | Worker + backend both repeatedly crash with `Bus error (core dumped)`; healthcheck probe (`python3 -c "import urllib.request, sys; …"`) also crashes mid-stack with SIGBUS, so the container never reaches a healthy state. Docker's `unless-stopped` policy respawns; each fresh boot fails the same way. `RestartCount` reaches 56. |
| 09:34 UTC | User reports "veriler gözükmüyor". Investigation begins via SSH. |
| 09:34 UTC | Diagnosis: `docker exec celery_default_worker df -h /tmp/prom_multiproc` → `tmpfs 64M 64M 0 100% /tmp/prom_multiproc`. Stale file count: 17,183 across three worker subdirs. |
| ~09:34 UTC | Hot fix: `rm -rf /var/lib/docker/volumes/netmanager_prom_multiproc/_data/celery_*/*` (17,183 files deleted) + `docker compose restart backend celery_worker celery_default_worker celery_agent_worker`. |
| 09:34:21 UTC | Backend `Up 36 seconds (healthy)`, `RestartCount = 0`, `/health/ready` → 200. Workers `health: starting` (start_period grace), then healthy. |

## 3. Why the existing safeguards didn't catch it

The repo's `docker-compose.yml` already prefaces every Python service
command with a self-targeting `rm -rf /tmp/prom_multiproc/<service>`
on container start — backend, all three Celery workers, celery_beat
and the event_consumer. That cleanup is what kept the **start-of-boot**
state clean. The accumulation happened **after** boot:

  * Each Celery worker container runs with `--concurrency=8` or `16`,
    so a parent worker process forks several child workers.
  * Each child process registers itself with `prometheus_client` in
    multiproc mode, which creates per-PID files like
    `gauge_all_<pid>.db`, `counter_<pid>.db`, etc. inside the
    container's subdir.
  * Children are recycled over time (failed task / occasional crash /
    `worker_max_tasks_per_child` if set). The container's parent stays
    alive, so the per-PID files left by dead children stay on disk.
  * The forensic data showed the most recent file
    `gauge_all_60247.db` (PID 60247) — i.e. ~60k child fork-and-exits
    over the container's ~2-day uptime, well above the budget the
    64 MB tmpfs and the start-only cleanup were sized for.

Once tmpfs hit 100 %, every subsequent `mmap` write — including the
ones the healthcheck Python probe needed to import its modules — got
SIGBUS. The restart policy kept retrying because Docker's
`unless-stopped` only stops if `exit 0`; SIGBUS exits with 135.

## 4. Fix (this commit)

**B — Headroom.** `prom_multiproc` tmpfs bumped from `size=64m` to
`size=256m`. Multiplies the time-to-saturation by 4× under the same
respawn rate; not a real fix on its own but a safety buffer while the
real fix takes effect.

**C — Per-child cleanup.** Added a `worker_process_shutdown` Celery
signal handler in `backend/app/workers/signals.py` that calls
`prometheus_client.multiprocess.mark_process_dead(os.getpid())` on
every forked-worker exit. `mark_process_dead` is the standard
prometheus_client API for exactly this scenario: it removes the dead
PID's `.db` files from the multiproc dir. With the hook installed,
stale files stop accumulating across child respawns — the underlying
mechanism for the original saturation is closed.

**A — Already present.** The `rm -rf /tmp/prom_multiproc/<service>`
preface in every service command was already in `docker-compose.yml`
when the incident occurred. Investigation showed it works correctly at
container boot; it is not — and was never — a runtime cleanup. No
change needed.

## 5. Verification

  * Local stack down + volume rm + up:
      - `tmpfs 256M 76K 256M 1% /tmp/prom_multiproc` (was 64M)
      - All 11 containers `(healthy)`
      - `pytest -q` → **600 / 600 passed**
      - `/health/ready` → 200 `{db,redis,timescaledb} = ok`
      - `/metrics` → 200
  * AST + Python import of `app.workers.signals` clean; the existing
    Faz 5C task lifecycle hooks unaffected.

## 6. What we'll watch in production

After deploy:
  * `tmpfs` usage on `/tmp/prom_multiproc` should stay near zero (the
    cleanup hook keeps it bounded by the live child count, not
    cumulative).
  * No `Bus error (core dumped)` lines in any container healthcheck
    output (`docker inspect <c> --format '{{json .State.Health.Log}}'`).
  * Container `RestartCount` stays at the value it has post-deploy
    (i.e. does not climb on its own).

## 7. Carry-forward (not in this hotfix)

  * `worker_max_tasks_per_child` is currently unset; a high respawn
    rate suggests either a slow leak or a celery default. Worth a
    follow-up to set an explicit value and tune.
  * The healthcheck command runs a fresh Python interpreter every
    30 s in every container — cheap, but the failure mode here was
    "healthcheck itself crashes with SIGBUS because tmpfs is full",
    which made the visible symptom (`Bus error (core dumped)`) appear
    in the healthcheck log rather than the application log. Worth
    pinning down whether a lighter healthcheck (e.g. a long-lived
    sidecar curl) would have surfaced the underlying SIGBUS sooner.
  * The 64 MB tmpfs default was sized for a fleet with a single
    backend process and very few worker children — it has been
    inadequate since the move to forked Celery worker pools.
    Documented now; revisit if the worker pool sizes change.

## 8. VPS deploy attempt + rollback (same day)

Within an hour of the SIGBUS recovery the T9 fix was committed,
merged to `main` (`870368b`), and a deploy was attempted on the
VPS. The deploy surfaced a **second, unrelated** failure that had
been masked all along: the VPS Postgres schema was on alembic
revision `d5e6f7a8b9c0` (Faz 6 baseline), while `main` had moved
through Faz 7 + Faz 8 + M6 + Faz 9 since. None of the intervening
migrations had ever been applied.

Concretely: after `git pull && docker compose build && docker compose
up -d`, backend went into a new restart loop with
`asyncpg.exceptions.InvalidPasswordError: password authentication
failed for user "netmgr_app"`. The `netmgr_app` role is created by
a Faz 7 migration; on the un-migrated VPS it doesn't exist and the
backend's default `APP_DB_USER=netmgr_app` could not authenticate.
Naively running `alembic upgrade head` at that point would have
applied M6's destructive `f8a5_drop_legacy_tenant` migration against
live production data — unacceptable without a `pg_dump` snapshot
and a step-by-step plan.

**Rollback executed:**
  * `git reset --hard eb7710a` in `/opt/netmanager` (VPS HEAD pinned
    back to the pre-deploy commit; `main` branch on the VPS is now
    detached relative to `origin/main`).
  * `docker compose build` + `docker compose up -d --force-recreate
    backend celery_worker celery_agent_worker celery_default_worker`.
  * Side benefit: the `prom_multiproc` volume had already been
    recreated at the new `256m` size during the failed T9 attempt,
    and Docker keeps volumes across `compose down`. So the VPS now
    runs the **eb7710a code** (no `mark_process_dead` hook) on the
    **256M tmpfs** — the SIGBUS root cause has not been re-fixed
    but the buffer is 4× larger, extending time-to-saturation
    proportionally.

**Post-rollback state (verified 09:57 UTC):**
  * Backend `Up 36s (healthy)`, RestartCount=0
  * `/health/ready` 200, all checks ok
  * 11 / 11 containers healthy
  * tmpfs 256M

**Hazard for the next deploy:** a routine `git pull` on the VPS will
re-trigger the same failure. The proper deploy chain — Faz 7 M1–M5 →
Faz 7 phase 6 → Faz 8 A–H → M6 destructive → Faz 9 → T9 — has to be
run as a single planned event with backup, per-step verification,
and a documented rollback. Tracked in
[../memory/project_vps_deploy_hazard.md](../memory/project_vps_deploy_hazard.md)
and the M6 deploy template at
[M6_DEPLOY_LOG.md](M6_DEPLOY_LOG.md).
