# Cross-Platform Agent Installer Architecture

> **Document version:** v1 (PR-A foundation; data model + matrix + manifest fields).
> Subsequent PRs (PR-B through PR-G) realise the runtime + bootstrapper +
> CI plumbing described below.

This document describes the target architecture for the cross-platform
NetManager Charon Agent installer. PR-A introduces only the data model
and the formal support matrix; nothing in the runtime or installer
flows changes in this PR.

## 1. Design principles

The installer is built around four non-negotiable principles. Future
PRs that touch any of these are explicit deviations and require their
own ADR.

1. **Private runtime, never system runtime.** The installer ships its
   own Python, OpenSSL, and any other runtime dependency the agent
   needs. It does NOT install or upgrade the operator's system Python,
   PowerShell, .NET, or distro packages. Existing system runtimes are
   left untouched. The global `PATH` is never mutated.

2. **Bootstrapper EXE / shell, not DLL.** Windows uses a native
   bootstrapper EXE that registers a Windows Service. Linux uses a
   POSIX shell bootstrap that registers a systemd service. The agent
   does NOT load into another process as a DLL or `.so`. Each agent
   runs as an isolated supervised process.

3. **Outbound HTTPS only.** The agent only initiates outbound TLS to
   the configured central backend. The installer does NOT open any
   inbound listening port on the public network. Local IPC uses
   Windows Named Pipes (Windows) or Unix domain sockets (Linux); both
   are local-only and never routed off the host.

4. **Explicit version-pinned support matrix.** The installer never
   claims to support "all Windows" or "all Linux". The
   [`docs/AGENT_PLATFORM_SUPPORT_MATRIX.md`](AGENT_PLATFORM_SUPPORT_MATRIX.md)
   is the single source of truth for what is committed. An OS release
   not on the list fails the preflight closed with a clear "OS not
   supported" message; the installer never tries to proceed on
   uncharted hosts.

## 2. Platform model

The architecture model lives in
[`backend/app/services/agent_installer/`](../backend/app/services/agent_installer/).

| Concept | Type | Values |
|---|---|---|
| `OSFamily` | string-enum | `"windows"`, `"linux"` |
| `Architecture` | string-enum | `"amd64"`, `"386"` |
| `Platform` | frozen dataclass | `(OSFamily, Architecture)` |
| Canonical string | str | `"windows-amd64"`, `"windows-386"`, `"linux-amd64"`, `"linux-386"` |

The strings match Go's `GOOS` / `GOARCH` convention so that artifact
filenames (`charon-agent-host-windows-amd64.exe`), filesystem paths
(`/opt/netmanager/agent-bins/charon-runtime-linux-386-1.0.0.tar.gz`),
and download URLs (`/api/v1/agents/{id}/download/runtime/linux-386`)
all share one canonical form.

Parsers (`parse_architecture`, `parse_os_family`,
`parse_platform_string`) accept the broadest common spellings
(`x86_64` / `amd64`, `i686` / `386`, `x64`, `x86`, ...) and normalise
to the Go form. Anything outside the supported set raises `ValueError`
— there is no "best-guess" fallback. The caller decides whether to
surface that as a 4xx response, a 503, or a hard installer block.

## 3. Artifact naming

Every artifact carries the canonical platform string in its name.

**Windows:**

```
charon-agent-host-windows-amd64.exe
charon-agent-host-windows-386.exe
charon-agent-updater-windows-amd64.exe
charon-agent-updater-windows-386.exe
charon-runtime-windows-amd64-<version>.zip
charon-runtime-windows-386-<version>.zip
charon-agent-windows-amd64-offline.exe          (offline-mode bootstrapper)
charon-agent-windows-386-offline.exe
```

**Linux:**

```
charon-agent-host-linux-amd64
charon-agent-host-linux-386
charon-agent-updater-linux-amd64
charon-agent-updater-linux-386
charon-runtime-linux-amd64-<version>.tar.gz
charon-runtime-linux-386-<version>.tar.gz
charon-agent-linux-amd64-offline.tar.gz         (offline-mode bootstrapper)
charon-agent-linux-386-offline.tar.gz
```

PR-A introduces only the model; the actual `linux-*` and `windows-386`
artifacts arrive in PR-C / PR-D / PR-F. The existing
`windows-amd64` artifact set (already produced by
`ops/windows-runtime-bundle/build.py` and `.github/workflows/charon-agent-host.yml`)
is the reference.

## 4. Detached manifest

The runtime bundle's detached manifest grows five optional fields in
PR-A. All default to `None`, so existing windows-amd64 manifests
produced by `ops/windows-runtime-bundle/build.py` continue to validate
unchanged.

```jsonc
{
  // Existing fields (unchanged).
  "schema_version": 1,
  "runtime_version": "1.0.0",
  "python_version": "3.12.6",
  "platform": "windows-amd64",
  "built_utc": "2024-06-18T00:00:00Z",
  "zip_size_bytes": 31457280,
  "zip_sha256": "<HEX UPPER>",
  "compatible_host_core_range": ">=2.0.0 <3.0.0",
  "entrypoint": "app\\run_agent.py",
  "files": [ ... ],

  // PR-A: optional cross-platform fields. `None` keeps current behaviour.
  "architecture": "amd64",                      // Go GOARCH
  "os_family": "windows",                       // Go GOOS
  "minimum_os_version": "Windows Server 2019",  // human-readable
  "minimum_kernel": "5.10",                     // Linux only
  "minimum_glibc": "2.31"                       // Linux only
}
```

The legacy `platform: "windows-amd64"` field is preserved unchanged
for backward compatibility. Future PRs add architecture-aware
endpoints (PR-E) that consume the new fields.

## 5. Windows installer model (target)

```
┌─────────────────────────────────────────────────────────────────────┐
│   Bootstrapper EXE     (signed, single-file; Go or .NET)            │
│   charon-agent-windows-{arch}.exe                                   │
└─────────────────────────────────────────────────────────────────────┘
                  │
                  ├─ OS / arch detection
                  ├─ Admin elevation
                  ├─ Preflight (TLS 1.2, disk, certificates, ...)
                  ├─ Manifest download + SHA + signature verify
                  ├─ Private runtime download / extract
                  └─ Windows Service registration
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│   Windows Service       (CharonAgent, Automatic Delayed Start)      │
│   C:\Program Files\Charon Agent\bin\charon-agent-host.exe           │
└─────────────────────────────────────────────────────────────────────┘
                  │
                  ├─ Child process: private Python runtime
                  │   C:\Program Files\Charon Agent\runtime\python\python.exe
                  ├─ Local IPC: Named Pipe (machine-local only)
                  └─ Outbound HTTPS: central backend only
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│   Updater EXE          (independent of agent service)               │
│   C:\Program Files\Charon Agent\bin\charon-agent-updater.exe        │
└─────────────────────────────────────────────────────────────────────┘
                  │
                  ├─ Versioned directories (versions\1.0.0\, versions\1.1.0\)
                  ├─ Atomic version switch via .current pointer
                  └─ Rollback on health-check failure
```

Filesystem layout:

```
C:\Program Files\Charon Agent\
├── bin\
│   ├── charon-agent-host.exe
│   └── charon-agent-updater.exe
├── runtime\
│   ├── python\
│   └── pwsh\               (only if agent needs PowerShell 7+ surfaces)
├── plugins\
└── versions\
    ├── 1.0.0\
    ├── 1.1.0\
    └── .current

C:\ProgramData\CharonAgent\
├── config\                 (DPAPI machine-scope encrypted)
├── certs\
├── logs\
├── data\
├── queue\
├── updates\
└── rollback\
```

The Windows Service runs as `LocalSystem` in the MVP. A virtual
service account hardening pass is on the roadmap but not in scope for
PR-A.

## 6. Linux installer model (target)

```
┌─────────────────────────────────────────────────────────────────────┐
│   Bootstrap shell installer                                         │
│   charon-agent-linux-{arch}.sh                                      │
└─────────────────────────────────────────────────────────────────────┘
                  │
                  ├─ /etc/os-release parsing
                  ├─ uname -m -> arch normalise
                  ├─ Package manager detection (apt | dnf | yum | zypper)
                  ├─ Preflight (ca-certificates, curl/wget, tar/gzip,
                  │             openssl, systemd, procps, iproute2)
                  ├─ Manifest download + SHA + signature verify
                  ├─ Private runtime extraction
                  └─ systemd unit installation
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│   systemd service       (charon-agent.service)                      │
│   /opt/charon-agent/bin/charon-agent-host                           │
└─────────────────────────────────────────────────────────────────────┘
                  │
                  ├─ Child process: private Python runtime
                  │   /opt/charon-agent/runtime/python/bin/python
                  ├─ Local IPC: Unix domain socket
                  └─ Outbound HTTPS: central backend only
```

Filesystem layout:

```
/opt/charon-agent/
├── bin/
├── runtime/
├── plugins/
└── versions/

/etc/charon-agent/
├── config
└── certs/

/var/lib/charon-agent/
├── queue/
├── state/
├── updates/
└── rollback/

/var/log/charon-agent/
```

systemd unit hardening: `NoNewPrivileges=yes`, `ProtectSystem=strict`,
`PrivateTmp=yes`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`,
`ReadWritePaths=/var/lib/charon-agent /var/log/charon-agent`. Details
in PR-D.

## 7. Online vs offline installer

| Mode | Bootstrap size | Network requirement | Use case |
|---|---|---|---|
| **Online** | ~5 MB | Outbound HTTPS to central backend | Default install on connected hosts |
| **Offline** | ~50 MB | None | Air-gapped / restricted networks |

The offline bundle embeds the full set of artifacts (host binary,
updater, runtime ZIP/tarball, certificates, metadata, manifest,
checksums, licenses, uninstall support) so the installer can complete
without any HTTPS round-trip.

## 8. Backwards compatibility

PR-A is a pure-additive PR:

- The legacy `platform: "windows-amd64"` manifest field continues to
  validate.
- Five new manifest fields are all optional and default to `None`.
- No installer template (`_windows_installer()`,
  `_linux_installer()`) is touched.
- No endpoint URL contract is touched.
- The runtime bundle builder (`ops/windows-runtime-bundle/build.py`)
  is untouched.
- The Linux installer byte-equal golden test
  (`test_linux_unchanged.py`) still passes -- the rendered Linux
  installer is byte-identical to the prior golden.
- The PR #89 URL-render hardening invariants are preserved.
- The PR #90 headless-exit + rollback-Phase-2 invariants are preserved.

## 9. What this document does NOT promise

- **It does NOT promise "all Windows" support.** Only the OS releases
  in [`AGENT_PLATFORM_SUPPORT_MATRIX.md`](AGENT_PLATFORM_SUPPORT_MATRIX.md)
  are committed.
- **It does NOT promise "all Linux distros" support.** Only the eight
  distros in the supported matrix are committed; Alpine, Arch, Gentoo,
  Void, and OpenWRT are explicitly excluded.
- **It does NOT promise 32-bit Windows Server support.** Server 32-bit
  lineage ended after Windows Server 2008. Windows 386 is conditional
  on test-available desktop builds only.
- **It does NOT promise architecture support beyond x86-64 + 32-bit
  x86.** ARM, AArch64, MIPS, PPC64LE, RISC-V, and s390x are explicitly
  unsupported.

## References

- [`AGENT_PLATFORM_SUPPORT_MATRIX.md`](AGENT_PLATFORM_SUPPORT_MATRIX.md) — single source of truth for supported OS releases.
- [`WINDOWS_AGENT_BOOTSTRAPPER.md`](WINDOWS_AGENT_BOOTSTRAPPER.md) — PR-B skeleton bootstrapper (Go, amd64 + 386).
- [`WINDOWS_AGENT_BOOTSTRAPPER_EXIT_CODES.md`](WINDOWS_AGENT_BOOTSTRAPPER_EXIT_CODES.md) — bootstrapper exit-code contract.
- [`adr/ADR-001-SELF-CONTAINED-AGENT-RUNTIME.md`](adr/ADR-001-SELF-CONTAINED-AGENT-RUNTIME.md) — decision record for the private-runtime principle.
- [`backend/app/services/agent_installer/architecture.py`](../backend/app/services/agent_installer/architecture.py) — `OSFamily` / `Architecture` / `Platform` model.
- [`backend/app/services/agent_installer/support_matrix.py`](../backend/app/services/agent_installer/support_matrix.py) — formal support matrix.
- [`backend/app/services/windows_runtime/manifest.py`](../backend/app/services/windows_runtime/manifest.py) — detached manifest Pydantic model.
- [`charon-agent-host/internal/bootstrapper/`](../charon-agent-host/internal/bootstrapper/) — bootstrapper Go packages (platform, install, security, runtime, service).
