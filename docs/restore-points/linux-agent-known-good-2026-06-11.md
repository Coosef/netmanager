# Linux Agent Known-Good Restore Point — 2026-06-11

**Snapshot UTC:** 2026-06-11 09:18-09:22Z
**Git tag:** `linux-agent-known-good-2026-06-11`
**Status:** **CREATED**. Restore drill **PENDING** (see §10).
**Off-host durability:** **LOCAL-ONLY** — Mac developer workstation copy is the only off-VPS replica today. Treat as "best-effort recovery", not durable disaster recovery, until a real off-host backend (S3 / dedicated backup VPS / similar) is provisioned.

## §1 Production state pinned at this point

| Item | Value |
|---|---|
| VPS Git HEAD | `9a7bf7a5a4ac540cdf4a40de637d15914caeff65` |
| Main HEAD at snapshot | `a3237652d210da9f12eee1ada4b728128dc48f8a` |
| Note on the gap | VPS deploys via cherry-pick; `9a7bf7a` is the cherry-pick of PR #67's squash merge (`b8c55f3` on main). The tag points at the VPS commit because that is the byte-for-byte production state. |
| Backend image | `sha256:0bd08b79f7796242ee86d03499d8ccdb0b1a159f0d3d2568f7a30b3f548da231` |
| Backend image local ID | `0bd08b79f779` |
| Backend `Created` | 2026-06-10T13:47:54Z |
| Frontend image | `sha256:63b0afc8d99b8b28c11ac3cdb7790554d6a8a74797bc3033fd63547270203972` |
| Frontend image local ID | `63b0afc8d99b` |
| Frontend `Created` | 2026-06-10T21:25:19Z |
| Alembic revision | `f9aeportpol` |
| `docker-compose.yml` SHA-256 | `5a81aaa58291d1275308fdcc73760b9d07633d5b0262638d008c334bca6117b9` |
| Agent script (`backend/agent_script/netmanager_agent.py`) SHA-256 | `7d733e9fd87ef355df276b9b03183c1ac3872cab6ded3baa39a22fc24effd7d2` |
| Agent script version constant | `1.4.1` |
| Linux installer sample SHA-256 (fake inputs) | `66caedb1bd92e519234741637400386afa797fd86359951d244e4b3680de2169` (varies on regeneration — timestamp embedded; use structural checks) |
| `_linux_installer` sample size | 5801 bytes |
| WebSocket endpoint | `/ws/agent` |
| Heartbeat interval | 15 s |
| Auth headers | `X-Agent-ID` + `X-Agent-Key` |

### Service matrix (snapshot)

```
backend                 running   Up 19 hours (healthy)
celery_agent_worker     running   Up 2 days  (healthy)
celery_beat             running   Up 2 days  (healthy)
celery_default_worker   running   Up 2 days  (healthy)
celery_worker           running   Up 2 days  (healthy)
event_consumer          running   Up 2 days  (healthy)
flower                  running   Up 2 days
nginx                   running   Up 2 days  (healthy)
postgres                running   Up 2 days  (healthy)
redis                   running   Up 2 days  (healthy)
frontend                running   Up 12 hours
```

11/11 running. All eligible services report healthy.

### Linux agent live evidence (anonymous)

Snapshot at `2026-06-11 09:03Z`, returned by a single SQL statement against the production `agents` table:

| Metric | Value |
|---|---|
| `active_total` (rows with `is_active = true`) | 6 |
| `online_total` (active + `last_heartbeat < 120s`) | 3 |
| `linux_total` (`platform = 'linux'` OR NULL) | 5 |
| `online_linux_total` (linux + `last_heartbeat < 120s`) | 2 |
| `windows_total` | 0 |
| `other_total` | 1 |
| `latest_linux_hb_age_sec` | 6 |

A live Linux agent had heartbeat-ed within the previous 6 seconds at the time the snapshot was taken — this is the strongest single-line evidence that the Linux agent is the canonical working path at the tagged commit.

## §2 Database safety record

| Item | Value |
|---|---|
| Alembic current | `f9aeportpol` |
| Migration applied during restore point creation | **none** |
| Schema change during restore point creation | **none** |
| Schema-only dump | `/opt/netmanager-backups/network-manager-schema-known-good-20260611.sql.gz` (25 KB, SHA-256 `04334b236e1e57232434531d9acc0542fbc2584f85bc9552b818089ce401c85d`) |
| Full DB backup | **NOT taken in this restore point**. The standing nightly Postgres backup, if configured, remains the canonical full-data recovery source — its last successful run should be verified separately. If no nightly backup exists, that is a gap to address before the next migration-bearing PR. |

### Restoring the schema dump safely

The gzipped dump was produced by `docker compose exec -T postgres pg_dump`
and includes both the `docker compose` deprecation warning (about the
obsolete `version` attribute) and `pg_dump`'s circular foreign-key
warnings (hypertable / chunk / continuous_agg) emitted on stderr that
leaked into the captured stream. The dump itself starts at the
canonical `-- PostgreSQL database dump` marker; strip everything before
that marker before piping to `psql`:

```bash
gunzip -c /opt/netmanager-backups/network-manager-schema-known-good-20260611.sql.gz \
  | sed -n '/^-- PostgreSQL database dump/,$p' \
  | psql -U netmgr -d network_manager_restored
```

`sed -n '/.../,$p'` prints from the first matching line through
end-of-file, dropping the warning preamble without otherwise modifying
the dump.

### Full DB backup gate

```
FULL_DB_BACKUP_REQUIRED_BEFORE_BACKEND_INTEGRATION_DEPLOY=true
```

The schema dump alone is not a substitute for a full-data backup. The
following work items MUST verify a recent successful full DB backup
before they are allowed to proceed beyond a review checkpoint:

- WIN-INTEGRATE backend deploy (the installer integration PR)
- Any PR that introduces an Alembic migration
- Agent model / schema changes
- Enrollment token table introduction
- DPAPI / enrollment backend changes

For PR #76 (WIN-HOST) this gate does **not** apply because that PR
touches neither the backend, nor the DB, nor the migration tree.

## §3 Artifact inventory

### VPS (`/opt/netmanager-backups/`)

| File | Size | SHA-256 |
|---|---|---|
| `backend-known-good-20260611.tar.gz` | 127 MB | `8ec274d174d379e48302ee4f9c3d3b55dbe1a83d4b9ee99423fcbfefea773ff0` |
| `frontend-known-good-20260611.tar.gz` | 30 MB | `a5d5c9ba1362135b635fa388c51e7b45c768edcff66ca1435f24e7319b6aff88` |
| `netmanager-known-good-20260611.bundle` | 6.1 MB | `949986eb294eb5219efa720e18b714ad52ec79a090e2b9d536910b57e351b166` |
| `network-manager-schema-known-good-20260611.sql.gz` | 25 KB | `04334b236e1e57232434531d9acc0542fbc2584f85bc9552b818089ce401c85d` |

`git bundle verify` reports: *"The bundle records a complete history."*

### Mac off-host copy (`/Users/coosef/netmanager-restore-points/2026-06-11/`)

All four files were SCP-copied from VPS at 2026-06-11 09:22Z. SHA-256 verified byte-identical to the VPS originals. Treat as **secondary copy on a developer workstation, not durable DR storage.**

### In-repo artifact (`artifacts/linux-agent-known-good-20260611/`)

| File | Description |
|---|---|
| `netmanager_agent.py` | Byte-for-byte copy of the agent script at this tag |
| `linux-installer-sample.sh` | `_linux_installer` output for `("known-good-fake-id", "REDACTED_FAKE_KEY", "https://netmanager.systrack.app")` |
| `SHA256SUMS` | Per-file hash record + note on the timestamp-dependent sample |
| `MANIFEST.md` | Contract pin (agent version, WS endpoint, heartbeat, etc.) + structural-check recipe for the sample |

## §4 Production `.env` snapshot (no secrets recorded)

| Item | Value |
|---|---|
| File exists | yes |
| Key count | 15 |
| Structural checksum (sha256 of sorted key names, values redacted) | `970b4ed9cec28abaab3af46dd7c91f99aa492784104044cfe37be790c176d0c9` |
| `WINDOWS_AGENT_V2_ENABLED` present | **no** — flag not yet in production `.env` |
| Implied default if read | falsy / unset; downstream code MUST treat absence as "disabled" |

The actual values were not exported, copied, or written anywhere. Only the sorted list of key names was hashed.

## §5 Restore procedure (10 steps, real commands)

Target: ≤ 10 minutes back to a working Linux agent.

```bash
# Step 0 — SSH to the VPS.
ssh root@93.180.133.88
cd /opt/netmanager

# Step 1 — Capture current state BEFORE making any change.
git rev-parse HEAD > /tmp/restore-precheck-git-head.txt
docker compose ps > /tmp/restore-precheck-services.txt
docker image inspect netmanager-backend:latest --format '{{.Id}}' > /tmp/restore-precheck-backend-id.txt
docker image inspect netmanager-frontend:latest --format '{{.Id}}' > /tmp/restore-precheck-frontend-id.txt
sha256sum docker-compose.yml > /tmp/restore-precheck-compose.txt

# Step 2 — Feature flag flip (only if WINDOWS_AGENT_V2_ENABLED currently
# reads as truthy). DO NOT sed-edit in place — back up, edit, verify.
if grep -q '^WINDOWS_AGENT_V2_ENABLED=true' .env; then
  cp -p .env .env.pre-restore-$(date +%s)
  python3 -c "
import re, sys
src = open('.env').read()
out = re.sub(r'^WINDOWS_AGENT_V2_ENABLED=true\s*$', 'WINDOWS_AGENT_V2_ENABLED=false',
             src, flags=re.MULTILINE)
open('.env', 'w').write(out)
"
  grep '^WINDOWS_AGENT_V2_ENABLED=' .env  # confirm value is now false
fi

# Step 3 — Move the git working tree to the known-good commit.
#
# Two paths depending on what you have:
#
# (A) origin is reachable (normal case):
git fetch origin --tags
git reset --hard linux-agent-known-good-2026-06-11
[ "$(git rev-parse HEAD)" = "9a7bf7a5a4ac540cdf4a40de637d15914caeff65" ] || \
  { echo "FAIL: git reset did not land on the expected commit"; exit 1; }
#
# (B) origin is NOT reachable and you are restoring from the local
#     bundle (DR scenario):
#
#     The bundle was built on the VPS at 2026-06-11 09:20:41 UTC, two
#     minutes BEFORE the local repo on which the annotated tag was
#     created fetched it back. As a result the bundle does NOT carry
#     the `linux-agent-known-good-2026-06-11` tag — only the commit
#     itself. Restore by commit SHA:
#
#       git clone /opt/netmanager-backups/netmanager-known-good-20260611.bundle repo
#       cd repo
#       git checkout 9a7bf7a5a4ac540cdf4a40de637d15914caeff65
#
#     Confirm:
#
#       git rev-parse HEAD
#       # → 9a7bf7a5a4ac540cdf4a40de637d15914caeff65

# Step 4 — Mark the rollback Docker tags as :latest so docker-compose
# picks them up. The :latest tag move is intentional; the rollback tag
# itself is left in place so a re-rollback is always possible.
docker tag netmanager-backend:rollback-linux-agent-known-good-20260611 netmanager-backend:latest
docker tag netmanager-frontend:rollback-linux-agent-known-good-20260611 netmanager-frontend:latest

# Step 5 — Recreate backend + frontend ONLY. Do not touch celery, redis,
# postgres, nginx, event_consumer, flower.
docker compose up -d --no-deps backend frontend

# Step 6 — Health-gated wait (NOT a fixed sleep).
for i in $(seq 1 120); do
  if curl -fsS http://localhost/health/ready >/dev/null 2>&1; then
    echo "backend ready after ${i}s"
    break
  fi
  sleep 1
done
if ! curl -fsS http://localhost/health/ready >/dev/null 2>&1; then
  echo "FAIL: backend did not become ready within 120s"
  docker compose logs --tail 200 backend
  exit 1
fi

# Step 7 — Alembic revision drift check.
revision=$(docker compose exec -T postgres psql -U netmgr -d network_manager -tAc \
            "SELECT version_num FROM alembic_version;" | tr -d '[:space:]')
[ "$revision" = "f9aeportpol" ] || \
  { echo "FAIL: alembic drifted to $revision (expected f9aeportpol)"; exit 1; }

# Step 8 — docker-compose.yml drift check.
expected="5a81aaa58291d1275308fdcc73760b9d07633d5b0262638d008c334bca6117b9"
actual=$(sha256sum docker-compose.yml | cut -d' ' -f1)
[ "$actual" = "$expected" ] || \
  { echo "FAIL: docker-compose.yml drifted to $actual"; exit 1; }

# Step 9 — Linux installer endpoint smoke. Replace REAL_AGENT_ID and
# REAL_AGENT_KEY with a known active agent's credentials (NEVER hard-code).
out=$(curl -fsS "http://localhost/api/v1/agents/${REAL_AGENT_ID}/download/linux?server_url=https://netmanager.systrack.app" \
       -H "X-Agent-Key: ${REAL_AGENT_KEY}")
# Structural checks (the SHA-256 will not match the sample's because the
# template embeds a Generated timestamp).
echo "$out" | head -1 | grep -q '#!/bin/bash' || \
  { echo "FAIL: installer first line is not the bash shebang"; exit 1; }
bytes=$(echo -n "$out" | wc -c)
[ "$bytes" -ge 4000 ] && [ "$bytes" -le 8000 ] || \
  { echo "FAIL: installer size $bytes out of expected range 4000-8000"; exit 1; }
echo "$out" | bash -n /dev/stdin || \
  { echo "FAIL: installer failed bash -n syntax check"; exit 1; }

# Step 10 — Linux agent heartbeat + panel visibility.
docker compose exec -T postgres psql -U netmgr -d network_manager -tAc \
  "SELECT 'online_linux_120s=' || COUNT(*) FROM agents
   WHERE is_active = true
     AND (platform = 'linux' OR platform IS NULL)
     AND last_heartbeat > NOW() - INTERVAL '120 seconds';"
# Expect at least one. If zero: an existing Linux agent has to restart
# its systemd service for the WS reconnect — usually one heartbeat
# interval (15s) later it returns. Browser check:
#   https://netmanager.systrack.app/agents → at least one row "online"
```

## §6 Estimated rollback duration

| Step | Time | Cumulative |
|---|---|---|
| 0-1 (SSH + precheck) | 30s | 0:30 |
| 2 (`.env` edit, only if needed) | 30s | 1:00 |
| 3 (`git reset --hard`) | 15s | 1:15 |
| 4 (docker tag) | 5s | 1:20 |
| 5 (recreate backend + frontend) | 60-90s | 2:50 |
| 6 (health-gated wait, typical) | 20-60s | 3:50 |
| 7-8 (alembic + compose checks) | 10s | 4:00 |
| 9 (installer endpoint smoke) | 30s | 4:30 |
| 10 (heartbeat + browser smoke) | 60-120s | 6:30 |
| **Worst-case total** | | **≤ 7 min** |

A real-world rollback should fit comfortably within the stated 10-minute target. A disaster-recovery scenario that needs `docker load < tar.gz` adds ~3-5 minutes on top.

## §7 What is intentionally NOT in this restore point

- **No production `.env` edit was made.** The `WINDOWS_AGENT_V2_ENABLED` flag is documented as a future addition but not yet introduced.
- **No backend or frontend container was recreated.** Image rollback tags were created from `:latest` while the containers continued running on those same images.
- **No PR was merged.** PR #75 and PR #76 remain open.
- **No image was rebuilt.** Only `docker tag` and `docker save` were used.
- **No agent was created, deleted, or modified.**
- **No real agent ID or key appears in any artifact.**

## §8 PR #76 status

PR #76 (the Go service host) is **DRAFT / BLOCKED BY RESTORE POINT** at the time of this restore-point creation. No new commits, no merge, no binary release until:
1. This restore point is reviewed and approved as DURABLE (or an off-host plan is added that makes it durable).
2. The restore drill (§10) has been run with a recorded outcome.

## §9 Cross-references

- Git tag: `linux-agent-known-good-2026-06-11`
- Restore artifact root (in-repo): `artifacts/linux-agent-known-good-20260611/`
- PR-A1 hardening plan (PR #75 reduction): pending separate commit
- Go host MVP-0: PR #76 (blocked)
- Installer integration: PR #77 (not yet started)
- Frontend byte-perfect: PR #78 (not yet started)

## §10 Restore drill — PENDING

Local Docker Compose stacks in this repo carry production secrets,
volumes, domain names, and external network references that may make
`git checkout <tag> && docker compose up -d` non-trivial on a clean
host. A representative drill requires:

1. A clean machine OR a stripped Docker Compose override that does not
   reach the production domain / volumes / external network.
2. A test Linux agent on that machine (systemd unit + the bundled
   `netmanager_agent.py`) configured against the stripped stack.
3. A live measurement of: time-to-ready after `git reset --hard` +
   `docker compose up -d`, agent heartbeat reappearance, and panel
   visibility.

Until that drill is run and its outcome recorded here, this restore
point is:

**STATUS:**
```
RESTORE POINT CREATED
OFF-HOST STATUS: LOCAL-ONLY / NOT DURABLE
BACKUP ARTIFACT INTEGRITY VERIFIED (git bundle + DB schema + Linux artifact)
DOCKER ARCHIVE DRILL: PENDING  (disposable VM required — production daemon must not load these tags)
FULL APPLICATION RESTORE DRILL: PENDING
```

The drill plan, when run, must end by appending a `## §11 Drill log`
section with: drill date, environment used, recorded times, pass/fail
verdict, and the operator who ran it.
