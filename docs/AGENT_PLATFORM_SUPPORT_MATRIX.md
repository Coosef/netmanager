# Agent Platform Support Matrix

> **Single source of truth.** The Python module
> [`backend/app/services/agent_installer/support_matrix.py`](../backend/app/services/agent_installer/support_matrix.py)
> mirrors this table programmatically and is read by the bootstrapper
> + runtime resolver to gate installs. If this document and the module
> ever disagree, the **module wins** — the installer enforces what the
> code says. Both are pinned by
> [`backend/tests/architecture/test_support_matrix.py`](../backend/tests/architecture/test_support_matrix.py).

## Status legend

| Status | Meaning |
|---|---|
| **SUPPORTED** | Shipped + validated. Installer proceeds. |
| **TEST_READY** | Installer + bundle prepared; no end-to-end campaign yet. Treat as "pre-GA"; production rollout requires a dedicated test run. |
| **CONDITIONAL** | Supported only when a specific extra condition is met (test-available build, specific kernel/glibc, per-deployment exception). |
| **UNSUPPORTED** | Explicitly out of scope. Installer fails closed. |

**Absence is unsupported.** An OS release not on this table is
unsupported by default. The installer does NOT silently best-guess.

## Windows

### x64 (`amd64`)

| OS release | Family | Version | Status | Notes |
|---|---|---|---|---|
| Windows 10 22H2 | Windows 10 | 22H2 | **SUPPORTED** | |
| Windows 11 | Windows 11 | any | **SUPPORTED** | |
| Windows Server 2019 | Windows Server | 2019 | **SUPPORTED** | Build 17763 or later. Manual validation campaigns: ATGHOSFTP. |
| Windows Server 2022 | Windows Server | 2022 | **SUPPORTED** | |
| Windows Server 2025 | Windows Server | 2025 | **TEST_READY** | Architecturally prepared; no end-to-end validation campaign performed yet. Production rollout requires a dedicated test run. |

### x86 (`386`)

| OS release | Family | Version | Status | Notes |
|---|---|---|---|---|
| Windows 10 32-bit | Windows 10 | any | **CONDITIONAL** | Supported only on test-available builds. No default support claim. Windows Server x86 releases are NOT supported — the Server 32-bit lineage was discontinued after Windows Server 2008. |

## Linux

### x64 (`amd64`)

| Distro | Min version | Min kernel | Min glibc | Status |
|---|---|---|---|---|
| Debian | 11+ | 5.10 | 2.31 | **SUPPORTED** |
| Ubuntu | 20.04+ | 5.4 | 2.31 | **SUPPORTED** |
| RHEL | 8+ | 4.18 | 2.28 | **SUPPORTED** |
| Rocky Linux | 8+ | 4.18 | 2.28 | **SUPPORTED** |
| AlmaLinux | 8+ | 4.18 | 2.28 | **SUPPORTED** |
| CentOS Stream | 8+ | 4.18 | 2.28 | **SUPPORTED** |
| openSUSE Leap | 15+ | 5.3 | 2.31 | **SUPPORTED** |
| SUSE Linux Enterprise Server (SLES) | 15+ | 5.3 | 2.31 | **SUPPORTED** |

### x86 (`386`)

| Distro | Min version | Min kernel | Min glibc | Status |
|---|---|---|---|---|
| Debian 32-bit | 11+ | 5.10 | 2.31 | **CONDITIONAL** |

> 32-bit Linux is largely deprecated upstream. Ubuntu dropped its
> i386 installer images after 18.04; Fedora / RHEL / Rocky / Alma
> have never had them. We prepare the build/manifest plumbing for
> `linux-386`, but enable per deployment only after explicit test.

## Supported package managers (Linux)

| Manager | Status |
|---|---|
| `apt` | **SUPPORTED** |
| `dnf` | **SUPPORTED** |
| `yum` | **SUPPORTED** |
| `zypper` | **SUPPORTED** |

## Explicitly UNSUPPORTED

### Windows (EOL, missing TLS 1.2, or out of MVP scope)

- Windows XP
- Windows Vista
- Windows 7
- Windows 8
- Windows 8.1
- Windows Server 2003
- Windows Server 2008
- Windows Server 2008 R2
- Windows Server 2012
- Windows Server 2012 R2
- Windows Server 2016

### Architectures

- ARM (`arm`)
- ARM64 / AArch64 (`arm64`, `aarch64`)
- MIPS (`mips`, `mipsel`, `mips64`)
- PowerPC (`ppc64`, `ppc64le`)
- RISC-V 64-bit (`riscv64`)
- IBM Z (`s390x`)

### Linux package managers

- `apk` (Alpine — musl libc, not glibc)
- `pacman` (Arch family — not in MVP)
- `opkg` (OpenWRT / embedded)
- `emerge` (Gentoo)
- `xbps` (Void Linux)
- `slackpkg` (Slackware)

## How a release moves from CONDITIONAL → SUPPORTED

1. Dedicated end-to-end validation campaign on the candidate OS
   release using the staging backend.
2. PR adding the OS release to the relevant matrix entry as
   `SUPPORTED`.
3. Updated `test_support_matrix.py` test for the entry.
4. Linked validation report in the PR description.

## How a release moves from TEST_READY → SUPPORTED

Same as CONDITIONAL → SUPPORTED above. The only difference is the
starting state.

## How an OS release becomes UNSUPPORTED

Either:

1. The release reaches its vendor end-of-life and no longer receives
   security updates (e.g. Windows 8.1 EOL Jan 2023). Add to the EOL
   list above.
2. The release is found to be missing a load-bearing surface (TLS 1.2,
   minimum kernel for syscall set, minimum glibc). Add to the EOL list
   with a note.
3. The validation campaign reveals an unrecoverable bug in our agent
   on that release. Open an ADR explaining the decision.

## Versioning

This matrix is versioned with the repository. Changes ship via PR
review; CI gates merges via the `test_support_matrix.py` suite.
