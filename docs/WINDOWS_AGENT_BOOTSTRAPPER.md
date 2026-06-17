# Windows Agent Bootstrapper

> **Status:** PR-B skeleton (planning only). Plan-only / dry-run.
> NO filesystem mutation, NO service registration, NO network call,
> NO secret handling. Subsequent PRs replace the skeleton with the
> real installation flow.

## 1. Purpose

`charon-agent-bootstrapper` is the native Windows entry point for
the cross-platform Charon agent installer. It does the inspection
work that decides whether an install can proceed, picks the right
agent architecture for the host, and emits a deterministic
installation plan in either text or JSON form.

In **PR-B** the bootstrapper stops after producing the plan. PR-C
adds the private-runtime resolver; PR-F adds the offline installer
bundle; PR-G adds the updater + rollback lifecycle.

## 2. Binaries

| Binary | GOOS | GOARCH | Use case |
|---|---|---|---|
| `charon-agent-bootstrapper-windows-amd64.exe` | windows | amd64 | Primary fleet target. Runs on x64 Windows. |
| `charon-agent-bootstrapper-windows-386.exe`   | windows | 386   | 32-bit binary. Usable on a 32-bit Windows host AND on x64 Windows as a WOW64 process (the architecture-aware planner detects this). |

The bootstrapper does **NOT** ship as an ARM, ARM64, AArch64, MIPS,
PPC64, RISC-V, or s390x binary. See
[`AGENT_PLATFORM_SUPPORT_MATRIX.md`](AGENT_PLATFORM_SUPPORT_MATRIX.md)
for the explicit UNSUPPORTED list.

## 3. Skeleton flow (PR-B)

The bootstrapper runs these steps in order. Any step returning a
blocker halts the run with the exit code listed in
[`WINDOWS_AGENT_BOOTSTRAPPER_EXIT_CODES.md`](WINDOWS_AGENT_BOOTSTRAPPER_EXIT_CODES.md):

1. Parse CLI arguments.
2. Detect process / native CPU architecture + WOW64 state.
3. Detect Windows version / edition / build / UBR.
4. Classify the (OS, architecture) pair against the support matrix.
5. Detect Administrator privilege.
6. Resolve install + data directory defaults (or accept overrides).
7. Probe install + data volume free space.
8. Detect pending-reboot signals.
9. Resolve the logical artifact requirement list for the chosen
   install mode (online vs offline).
10. Emit the immutable `InstallationPlan` JSON (or human-readable
    text summary).

Skeleton means **none** of these happen yet: artifact download,
runtime extraction, VC++ runtime install, Windows service
registration, registry mutation, backend HTTPS round-trip, agent
enrollment, updater install, rollback execution.

## 4. CLI contract

```
charon-agent-bootstrapper [flags]

  --mode=online|offline      install mode (default: online)
  --backend-url=URL          central backend URL (REQUIRED with online)
  --agent-id=ID              agent identifier (NOT a secret)
  --config=PATH              path to bootstrapper config file (PR-C+)
  --install-dir=PATH         override default install directory
  --data-dir=PATH            override default data directory
  --output=text|json         plan output format (default: text)
  --dry-run                  plan-only; do not mutate (PR-B is dry-run by design)
  --non-interactive          never prompt; fail closed on missing input
  --force-arch=amd64|386     force agent architecture (default: derived from native)
  --version                  print bootstrapper version and exit
  --help                     print usage and exit
```

Secrets handling -- pinned by `internal/bootstrapper/options_test.go`:

- **Agent keys, passwords, tokens, JWT, X-Agent-Key are NEVER
  accepted on the command line.** Any `--agent-key`, `--password`,
  `--token`, `--jwt`, `--x-agent-key`, `--pass`, `--agent-secret`,
  `--agentkey`, `--agent_key`, or upper-case variant on argv
  causes the parser to refuse with `ExitInvalidArguments` (exit
  code 2). The error message does NOT include the offending
  value.
- Future PRs will accept the agent key via stdin pipe, a
  permission-locked file, or an enrollment exchange.

Path handling enforces:

- Absolute Windows paths only (drive letter + ':' + separator).
- No `..` traversal segments.
- No UNC (`\\server\share\...`).
- No device namespace (`\\?\`, `\\.\`).
- No control characters / NUL.
- Non-ASCII segments (Turkish, Cyrillic, etc.) are accepted.
- **Critical-path blocklist** (PR-B hardening):
  - Drive root (`C:\`, `D:\`, ...).
  - Windows tree (`C:\Windows`, `C:\Windows\System32`, `C:\Windows\SysWOW64`).
  - User profile tree (`C:\Users`, `C:\Users\<name>`, `C:\Users\...\AppData\Local\Temp`).
  - Program Files / Program Files (x86) / ProgramData **bare roots** (subdirectories like `...\Charon Agent` ARE allowed).
  - Recycle Bin tree (`C:\$Recycle.Bin`).
- **Install / data directory collision**: install_dir and data_dir
  must not be equal; neither may be nested inside the other. The
  check is case-insensitive and path-segment aware so that
  `C:\Foo` and `C:\Foobar` are NOT treated as parent/child.

URL handling carries the PR #89 normalisation invariants:

- `--backend-url` must use `http` or `https`.
- Trailing slashes are stripped before storage.
- Quote / shell-meta / control characters are rejected.
- **Userinfo rejection** (PR-B hardening): `https://user@host`
  and `https://user:pass@host` are rejected. Credentials embedded
  in URLs leak through proxy logs and shell history; the error
  message NEVER echoes the username / password back.
- **Fragment rejection** (PR-B hardening): `https://host#frag` is
  rejected. The error message does not echo the fragment.
- **Query string rejection** (PR-B hardening): `https://host?q=1`
  is rejected. The error message does not echo the query.

## 5. Architecture detection

The bootstrapper records three architecture facts:

- **Process architecture** -- what the binary itself was built for
  (`runtime.GOARCH`).
- **Native architecture** -- what the OS itself is (read via
  `GetNativeSystemInfo` on Windows).
- **WOW64** -- true when a 386 process runs on a 64-bit OS (read
  via `IsWow64Process`).

The default agent-architecture policy:

| Native | Process | --force-arch | Selected agent arch |
|---|---|---|---|
| amd64 | amd64 | (default)    | amd64 |
| amd64 | 386   | (default)    | amd64 |
| amd64 | 386   | `386`        | 386 (explicit opt-in) |
| 386   | 386   | (default)    | 386   |
| 386   | 386   | `amd64`      | rejected (PE loader cannot run amd64 on a 32-bit OS) |

## 6. Windows version detection

The bootstrapper queries `RtlGetVersion` (via
`golang.org/x/sys/windows`) for the canonical version numbers and
`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` for the
ProductName / EditionID / DisplayVersion / UBR strings.

`RtlGetVersion` is preferred over `GetVersionEx` because
`GetVersionEx` honours the application's compatibility manifest --
and the bootstrapper does not ship a compatibility manifest by
design. We need the true OS version, not what the manifest claims.

The classifier mirrors a deliberate **subset** of the PR-A Python
support matrix
(`backend/app/services/agent_installer/support_matrix.py`). The
two are not generated from a shared source today; this is the
**technical debt** PR-E unifies via a canonical JSON data file
that both layers consume. Until then, any change to the Python
matrix MUST be mirrored in `internal/bootstrapper/platform/osversion.go`'s
`ClassifySupport` and pinned by a new `_test.go` entry.

## 7. Install paths

Defaults derived from the matrix in
`internal/bootstrapper/install/paths.go`:

| Host (native) | Agent arch | InstallDir | DataDir |
|---|---|---|---|
| x64 | amd64 | `%ProgramFiles%\Charon Agent` | `%ProgramData%\CharonAgent` |
| x64 | 386 (forced) | `%ProgramFiles(x86)%\Charon Agent` | `%ProgramData%\CharonAgent` |
| x86 | 386 | `%ProgramFiles%\Charon Agent` | `%ProgramData%\CharonAgent` |
| x86 | amd64 | (rejected) | (rejected) |

`DataDir` always lives under `%ProgramData%` -- Microsoft never
splits ProgramData by architecture.

## 8. Installation plan

The plan is a deterministic JSON object pinned by
`internal/bootstrapper/install/plan_test.go`. Two runs of the same
`(options, probes)` pair produce byte-identical JSON.

The plan never includes secret fields. The
`TestPlan_NoSecretFieldsInJSON` test pins this: the JSON output
must not contain `"agent_key"`, `"password"`, `"token"`, `"jwt"`,
`"x_agent_key"`, or `"secret"` anywhere.

## 9. Build / CI

The bootstrapper is built by
[`.github/workflows/charon-agent-bootstrapper.yml`](../.github/workflows/charon-agent-bootstrapper.yml).
The workflow runs:

| Job | Runner | Purpose |
|---|---|---|
| `unit` | ubuntu-latest | go vet, gofmt, `go test -race` against the cross-platform half of the bootstrapper packages |
| `build-amd64` | ubuntu-latest | `GOOS=windows GOARCH=amd64` cross-compile + PE32+ verify (`file ... \| grep PE32+ x86-64`) + size + UPX rejection + no-embedded-64-hex-secret scan + artifact upload |
| `build-386` | ubuntu-latest | `GOOS=windows GOARCH=386` cross-compile + PE32 verify (`file ... \| grep PE32 ... 80386`) + size + UPX rejection + no-embedded-64-hex-secret scan + artifact upload |

The CI tier in use today has **no native 32-bit Windows runner**.
The 386 binary is verified at the PE-header level only; end-to-end
execution on a real x86 Windows host is a manual lab task
documented separately.

CI artifacts are deliberately renamed to
`...-development-skeleton-NOT-FOR-PRODUCTION` so an operator
downloading them by mistake cannot accidentally run the planning
skeleton as if it were a real installer.

## 10. Hard rules

- **Bootstrapper does NOT install Python / PowerShell / .NET /
  winget.** It does not modify the system runtimes. Future PRs
  ship private runtimes under the bootstrapper's install tree.
- **Bootstrapper does NOT mutate the global PATH.** All future
  invocations use absolute paths.
- **Bootstrapper does NOT open any inbound network port.** Local
  IPC will use Windows Named Pipes (PR-C).
- **Bootstrapper does NOT silently best-guess unknown OS
  releases.** Unknown classification = abort, fail closed.
- **Bootstrapper does NOT log secrets.** Secrets cannot enter the
  bootstrapper via argv; future PRs that add stdin / file ingest
  will preserve the discipline.

## 11. Roadmap

| PR | Adds |
|---|---|
| PR-C | Windows private-runtime resolver + dependency probes (VC++ runtime, TLS surface), online artifact download with SHA + signature verification |
| PR-D | Linux installer with private runtime + systemd registration |
| PR-E | Architecture-aware backend endpoints; unify the Python + Go support matrices via a canonical JSON data file |
| PR-F | Offline installer bundles for both architectures |
| PR-G | Updater binary, versioned directories, atomic switch, rollback |

## References

- [`AGENT_INSTALLER_ARCHITECTURE.md`](AGENT_INSTALLER_ARCHITECTURE.md) -- overall architecture.
- [`AGENT_PLATFORM_SUPPORT_MATRIX.md`](AGENT_PLATFORM_SUPPORT_MATRIX.md) -- formal supported-OS list.
- [`WINDOWS_AGENT_BOOTSTRAPPER_EXIT_CODES.md`](WINDOWS_AGENT_BOOTSTRAPPER_EXIT_CODES.md) -- exit-code contract.
- [`adr/ADR-001-SELF-CONTAINED-AGENT-RUNTIME.md`](adr/ADR-001-SELF-CONTAINED-AGENT-RUNTIME.md) -- private-runtime decision record.
