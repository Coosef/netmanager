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
