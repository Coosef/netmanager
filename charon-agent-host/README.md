# charon-agent-host

Native Go Windows service host that supervises the NetManager proxy
agent.

## Status

**MVP-0 (PR #76).** This is the first deliverable of the Agent v2
migration. It bridges Windows Service Control Manager (SCM) and the
existing v1 Python agent, which runs as the host's managed child
process. Subsequent MVPs replace the Python child with native Go
workers; the SCM-facing surface stays stable across those migrations.

This binary is NOT yet wired into the production installer — the
PowerShell installer hardening in PR #75 deliberately removes the
broken `sc.exe create` path until PR #77 lands the host-aware installer.

## Build

```
make build-windows-amd64
```

Produces `bin/charon-agent-host-windows-amd64.exe`. Cross-compiles
from Linux/macOS; CGO is disabled and there is no Windows SDK
dependency. **UPX is intentionally not used** — EDR / SmartScreen
flag UPX-packed binaries as suspicious, which costs more in support
tickets than it saves in disk space.

## Test

```
make test
```

Unit tests run on any platform. Windows-specific code paths sit
behind `//go:build windows` tags and are exercised by integration
tests that the CI workflow runs on `windows-2022` GitHub Actions
runners (see `.github/workflows/charon-agent-host.yml`).

## CLI

```
charon-agent-host install   --service-name NetManagerAgent \
                            --display-name "NetManager Proxy Agent" \
                            --child-exe "C:\Python312\python.exe" \
                            --child-args "C:\ProgramData\NetManagerAgent\run_agent.py" \
                            --work-dir "C:\ProgramData\NetManagerAgent" \
                            --env-file "C:\ProgramData\NetManagerAgent\config.env" \
                            --log-dir "C:\ProgramData\NetManagerAgent\logs"

charon-agent-host start     --service-name NetManagerAgent
charon-agent-host status    --service-name NetManagerAgent   # exit 0 if Running
charon-agent-host stop      --service-name NetManagerAgent
charon-agent-host uninstall --service-name NetManagerAgent

charon-agent-host version
charon-agent-host help
```

## Exit codes

| Code | Meaning                                                   |
|------|-----------------------------------------------------------|
| 0    | Success (status: service is Running)                      |
| 1    | Generic failure (see stderr)                              |
| 2    | Flag / validation error                                   |
| 17   | install: service already exists                           |
| 18   | service not found (start/stop/status/uninstall)           |
| 19   | uninstall: SCM unregistration still pending — retry later |
| 64   | console-mode supervisor not yet implemented (MVP-0)       |

## Architecture pointers

- `cmd/charon-agent-host/` — entry point
- `internal/cli/`          — subcommand dispatch + flag parsing
- `internal/service/`      — SCM lifecycle (Windows-only behind build tag)
- `internal/child/`        — Python child process + Job Object + backoff
- `internal/config/`       — schema + env file loader (BOM-safe)
- `internal/logging/`      — rotating writer + Windows Event Log
- `internal/version/`      — build-time injected metadata

See `docs/AGENT_V2_GO_ARCHITECTURE.md` (at the repo root) for the
multi-MVP roadmap.
