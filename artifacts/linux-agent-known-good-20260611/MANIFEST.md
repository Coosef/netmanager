# Linux Agent Known-Good Restore Point — Artifact Manifest

**Created:** 2026-06-11 (UTC snapshots throughout this document)
**Linked Git tag:** `linux-agent-known-good-2026-06-11` (→ commit `9a7bf7a5a4ac540cdf4a40de637d15914caeff65`)
**Linked restore doc:** `docs/restore-points/linux-agent-known-good-2026-06-11.md`

## Purpose

Frozen reference for the Linux agent v1.4.1 wire format and on-disk
script that was running in production on 2026-06-11 when the Windows
Agent v2 / Go service host implementation began. Used to:

1. Compare a recovered installation against a known-good baseline.
2. Reconstruct a working Linux agent if backend artifacts are lost
   (the script itself is the only Python file the v1 agent needs at
   runtime — combined with the env file it boots and connects).
3. Anchor regression detection: if a future PR mutates either
   `_linux_installer` or `netmanager_agent.py`, the structural checks
   below should still pass.

## Contents

| File | Purpose | Hash equality usable? |
|---|---|---|
| `netmanager_agent.py` | Production agent runtime, byte-for-byte copy from `backend/agent_script/netmanager_agent.py` at the tagged commit | ✅ Yes (deterministic) |
| `linux-installer-sample.sh` | Output of `_linux_installer("known-good-fake-id", "REDACTED_FAKE_KEY", "https://netmanager.systrack.app")` | ❌ No — embeds a `# Generated: <UTC timestamp>` line |
| `SHA256SUMS` | Hash record for both files | — |
| `MANIFEST.md` | This document | — |

## Secret hygiene

- **No real agent ID.** The sample uses the literal string `known-good-fake-id`.
- **No real agent key.** The sample uses the literal string `REDACTED_FAKE_KEY`.
- **No real backend URL secrets.** Only the public origin `https://netmanager.systrack.app`.
- **Tested via** `grep -oE "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"` returning zero matches against the sample at archive time.

## Restore-time verification (structural — NOT hash equality)

The sample's SHA-256 will differ on every regeneration because of the
`# Generated:` timestamp the backend writes into the script. Restore
drills should verify these structural invariants instead:

```bash
# 1. First line is the bash shebang (after dedent's leading whitespace).
[[ "$(head -1 linux-installer-sample.sh | tr -d ' ')" == "#!/bin/bash" ]]

# 2. Size is in the expected range (current sample: 5801 bytes).
size=$(wc -c < linux-installer-sample.sh)
[[ $size -ge 4000 && $size -le 8000 ]]

# 3. Bash syntax is valid.
bash -n linux-installer-sample.sh

# 4. Fake markers are present (and therefore real keys are NOT).
grep -q "REDACTED_FAKE_KEY" linux-installer-sample.sh
grep -q "known-good-fake-id" linux-installer-sample.sh

# 5. No uuid-shaped secret leaked in.
! grep -qE "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" linux-installer-sample.sh
```

For `netmanager_agent.py` the script IS deterministic, so:

```bash
[[ "$(shasum -a 256 netmanager_agent.py | cut -d' ' -f1)" == \
   "7d733e9fd87ef355df276b9b03183c1ac3872cab6ded3baa39a22fc24effd7d2" ]]
```

If the hash differs, EITHER the file was rebuilt from a different
source revision, OR the v1.4.1 contract has been mutated — in either
case investigation is required before treating any restore as
complete.

## Agent contract snapshot (v1.4.1)

Pinned from the agent script and backend at commit `9a7bf7a`:

| Field | Value |
|---|---|
| Agent version (script constant) | `1.4.1` |
| Heartbeat interval | 15 seconds |
| Heartbeat JSON shape | `{"type": "heartbeat", ...}` |
| WebSocket endpoint | `/ws/agent` |
| Auth headers | `X-Agent-ID` + `X-Agent-Key` |
| Config file path (Linux) | `/opt/netmanager-agent/agent.env` or `~/.netmanager-agent/agent.env` |
| Config file path (Windows) | `C:\ProgramData\NetManagerAgent\config.env` |
| Reconnect backoff | exponential 1s → 300s max, ±5s jitter |
| Disconnect anomaly threshold | 3 consecutive disconnects → `local_anomaly` |

## Linked external artifacts (off-host)

Larger artifacts (image tarballs, git bundle, schema dump) are NOT
checked into git. They live in:

- VPS: `/opt/netmanager-backups/` (primary, see SHA-256 in the restore doc)
- Mac off-host copy: `/Users/coosef/netmanager-restore-points/2026-06-11/` (per-file SHA-256 verified against VPS at copy time)

Restore point durability status: **LOCAL-ONLY (Mac developer workstation off-host copy).** This is not durable disaster recovery — a real off-host backup location (S3, separate VPS, etc.) is required to call this DURABLE.

## Out of scope for this manifest

- Active agent identities and keys (held only in the production DB).
- Production secrets, certificates, TLS keys.
- Customer-specific config that the agent receives from the backend at runtime.
