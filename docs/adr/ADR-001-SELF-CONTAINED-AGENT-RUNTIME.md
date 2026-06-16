# ADR-001 — Self-contained agent runtime (private Python + private PowerShell)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-16 |
| **Deciders** | Backend / Windows Agent V2 working group |
| **Scope** | Cross-platform agent installer (Windows amd64 + 386, Linux amd64 + 386) |
| **Supersedes** | None |

## 1. Context

The NetManager Charon Agent is a long-lived supervised process that
must run reliably on a wide range of operator hosts. Three classes of
host create the problem:

1. **Locked-down corporate Windows.** PS 5.1 default; PowerShell 7
   not installed; system Python absent; `winget` blocked by IT
   policy; Microsoft Store alias for `python.exe` traps newcomers.
2. **Legacy Windows Server.** Server 2019 + 2022 ship without modern
   Python; corporate AV reacts badly to PE files placed on system
   PATH; PS 5.1 has cp1254/cp1252 quirks on Turkish locale.
3. **Heterogeneous Linux fleet.** Eight distros across two major
   families (Debian/Ubuntu vs RHEL/Rocky/Alma/CentOS Stream/SUSE);
   each ships a different Python minor (3.8 → 3.12), different
   glibc, different systemd minor, different package manager.

Earlier prototypes that relied on **system runtimes** (system Python,
system PS, system `pip install` from PyPI, `winget` to provision
prerequisites) hit one or more of:

- Quarantined by corporate AV.
- Broken by Microsoft Store alias (`python.exe` → app installer).
- Failed under TR Windows console code-page (cp1254) when the script
  emitted non-ASCII bytes.
- Stale OpenSSL on the host crypto path → broken TLS to our backend.
- Operator surprise that "we changed their Python".

## 2. Decision

The agent installer ships its **own private runtime** for every
dependency it needs. The system runtimes are NEVER read, NEVER
written, NEVER upgraded.

Concretely:

- **Private embedded Python** under
  `C:\Program Files\Charon Agent\runtime\python\` (Windows) and
  `/opt/charon-agent/runtime/python/` (Linux). The agent's child
  processes invoke this Python directly via absolute path.
- **Private PowerShell 7** under
  `C:\Program Files\Charon Agent\runtime\pwsh\` *only when* the agent
  needs PS 7+ surfaces. Default install does not ship PS 7 — only the
  Python runtime ships unconditionally.
- **Private OpenSSL** bundled with the embedded Python distribution
  (the embed package already contains `libssl-3.dll` and
  `libcrypto-3.dll` on Windows; Linux statically links).
- **Private CA bundle** in `certs/`. The system trust store is
  consulted only as a fallback for proxy certificates.
- **No `pip install`** at install time. All Python dependencies are
  pre-installed at build time into the embedded `site-packages/` via
  `pip install --no-index --find-links <wheelhouse> --require-hashes`.
- **No `winget install`** at install time. Windows native dependencies
  (VC++ runtime, if needed) are detected and surfaced to the operator
  via a structured exit code — the installer does NOT silently invoke
  `winget`.
- **The global `PATH` is never mutated.** All invocations use
  absolute paths.

## 3. Alternatives considered

### 3a. System Python + `pip install` at install time

Rejected.

- Requires outbound HTTPS to PyPI on every install.
- Subject to PyPI outage / corporate proxy interception.
- Version drift across 3.10 / 3.11 / 3.12 surfaces breaks the agent
  on randomly chosen hosts.
- AV quarantines arbitrary user-installed packages on Windows.

### 3b. `winget install Python.Python.3.12` on Windows

Rejected.

- App Installer (which provides `winget`) is Store-only on Server
  2019; locked-down corporate Windows blocks the Store.
- Behaviour and exit-code semantics changed across `winget` versions.
- Changes the operator's system Python (NACK — see ADR scope).

### 3c. PyInstaller / Nuitka compiled agent

Rejected.

- Loses the Go-host-supervises-Python-child model we already debugged
  on Linux.
- Compiled bundles are opaque to AV heuristics → more false positives.
- Updating one Python dep requires a full recompile.

### 3d. Docker container as the agent

Rejected.

- Requires Docker / containerd on every host.
- Adds an entire trusted boundary the agent does not need.
- Loses the lightweight per-process supervision model.

## 4. Consequences

### Positive

- Determinism: the same `runtime/python/` ships everywhere; only
  agent code differs across releases.
- Air-gappable: an offline installer (PR-F) contains the full runtime
  + agent + updater; no network needed at install time.
- AV-friendly: the runtime tree lives under
  `C:\Program Files\Charon Agent\` (signed) rather than scattered
  across `C:\Users\...\AppData\`.
- Locale-safe: avoids the TR Windows cp1254 console code-page traps
  that the system PS 5.1 hits.

### Negative / trade-offs

- Bigger install footprint (~30 MB embedded Python on Windows; ~50
  MB on Linux including tarball uncompressed). Acceptable: every
  supported OS reserves >2 GB of disk by definition.
- Larger initial bootstrap download. Mitigated by `online` installer
  (which downloads the runtime ZIP/tarball on demand) vs `offline`
  installer (which embeds it).
- Operators occasionally ask "why isn't this using my system
  Python?". Documented in
  [`AGENT_INSTALLER_ARCHITECTURE.md`](../AGENT_INSTALLER_ARCHITECTURE.md)
  section 1.

## 5. Related invariants this ADR locks down

- The agent runs as a process, not as a DLL. No injection into other
  processes; no `LoadLibrary` of agent.dll. (See
  [`AGENT_INSTALLER_ARCHITECTURE.md`](../AGENT_INSTALLER_ARCHITECTURE.md)
  section 1 principle 2.)
- The agent does NOT open a public inbound port. All communication
  with the central backend is outbound TLS. Local IPC uses Windows
  Named Pipes / Unix domain sockets — both machine-local.
- The Windows Service runs as `LocalSystem` in MVP. A virtual service
  account hardening pass is a separate ADR.
- The support matrix is the single source of truth. The installer
  fails closed on uncharted hosts.

## 6. Scope boundaries (what this ADR does NOT decide)

- The choice of native bootstrapper language (Go vs .NET). PR-B will
  pick one and document the rationale; both are compatible with this
  ADR.
- The exact `versions/` directory rotation strategy + atomic-switch
  semantics. PR-G ADR will cover the updater.
- Code-signing certificate procurement and key management. Separate
  SecOps work item.
- Telemetry granularity + opt-in/out behaviour. Separate ADR.

## 7. Verification

- [`backend/tests/architecture/test_architecture_model.py`](../../backend/tests/architecture/test_architecture_model.py) — pins the `OSFamily` / `Architecture` / `Platform` data model.
- [`backend/tests/architecture/test_support_matrix.py`](../../backend/tests/architecture/test_support_matrix.py) — pins the support matrix and the unsupported lists.
- [`backend/tests/win_integrate/test_manifest_validation.py`](../../backend/tests/win_integrate/test_manifest_validation.py) — pins backward-compatibility of the new optional manifest fields.
- [`backend/tests/win_integrate/test_linux_unchanged.py`](../../backend/tests/win_integrate/test_linux_unchanged.py) — pins Linux installer byte-equality; ADR-001 does not touch the existing Linux template (which still uses system Python). PR-D replaces the Linux template + rotates the golden.

## 8. Future work that depends on this ADR

| Future PR | Inherits from ADR-001 |
|---|---|
| PR-B Windows bootstrapper skeleton | Bootstrapper-EXE / no-DLL principle |
| PR-C Windows private runtime + 386 | Private-runtime location convention |
| PR-D Linux installer with private runtime | Same convention on Linux |
| PR-E Architecture-aware endpoints | Artifact-name convention from this ADR |
| PR-F CI matrix + offline installer | Offline installer self-contains runtime per this ADR |
| PR-G Updater + rollback | Versioned-directories strategy lives inside this ADR's filesystem layout |
