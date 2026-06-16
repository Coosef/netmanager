"""Formal version-pinned platform support matrix.

The matrix is the single source of truth for "what we have actually
tested and commit to support". It is intentionally narrow: rather than
claim "all Windows / all Linux", we enumerate explicit OS releases with
status markers, so the installer + the docs + the CI matrix can stay in
sync.

Status levels:
  * SUPPORTED  -- shipped + production-validated on this OS release.
  * TEST_READY -- installer + bundle are technically prepared, but no
    end-to-end validation campaign has been done yet on this release.
  * CONDITIONAL -- supported only when a specific extra condition is
    met (test-available build exists, specific kernel/glibc present,
    or a per-deployment exception).
  * UNSUPPORTED -- explicitly out of scope; installer should fail
    closed with a clear "OS not supported" message rather than try.

The matrix does NOT claim feature parity across all entries. The
bootstrapper / runtime resolver (PR-C / PR-D) consult this matrix to
decide whether to proceed; if an entry is missing, the safe answer is
"not supported, abort".

Unsupported lists below are enumerative samples, not exhaustive. The
absence of an entry from a SUPPORTED list is itself the unsupported
state.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from typing import Optional

from .architecture import (
    LINUX_386,
    LINUX_AMD64,
    Platform,
    WINDOWS_386,
    WINDOWS_AMD64,
)


class SupportStatus(str, enum.Enum):
    """How committed the project is to a given OS release on a platform."""

    SUPPORTED = "supported"
    TEST_READY = "test_ready"
    CONDITIONAL = "conditional"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True, eq=True)
class OSRelease:
    """One row of the support matrix.

    Attributes:
        name: human-readable release name ("Windows Server 2019", "Ubuntu").
        family: distro / OS family the release belongs to ("Windows Server",
            "Ubuntu", "RHEL"). Used for grouping in docs and for
            distro-family-based runtime resolver decisions.
        version: marketing version string, e.g. "22H2", "20.04+", "2019".
            "*" means "any version in this family"; "X+" means "X or later".
        minimum_kernel: Linux only -- minimum Linux kernel version (skipped
            on Windows entries).
        minimum_glibc: Linux only -- minimum glibc version.
        status: SUPPORTED / TEST_READY / CONDITIONAL / UNSUPPORTED.
        notes: free-form prose for caveats (build numbers, extra
            preconditions for CONDITIONAL entries, etc).
    """

    name: str
    family: str
    version: Optional[str] = None
    minimum_kernel: Optional[str] = None
    minimum_glibc: Optional[str] = None
    status: SupportStatus = SupportStatus.SUPPORTED
    notes: Optional[str] = None


# ────────────────────────────────────────────────────────────────────────
# Windows amd64 -- production fleet target. Validated via PR #82-#90 stack
# and the T1.02 / T1.03 manual validation campaigns on Windows Server 2019.
# ────────────────────────────────────────────────────────────────────────
WINDOWS_AMD64_RELEASES: tuple[OSRelease, ...] = (
    OSRelease(
        name="Windows 10 22H2",
        family="Windows 10",
        version="22H2",
        status=SupportStatus.SUPPORTED,
    ),
    OSRelease(
        name="Windows 11",
        family="Windows 11",
        version="*",
        status=SupportStatus.SUPPORTED,
    ),
    OSRelease(
        name="Windows Server 2019",
        family="Windows Server",
        version="2019",
        status=SupportStatus.SUPPORTED,
        notes="Build 17763 or later. Manual validation campaigns ATGHOSFTP.",
    ),
    OSRelease(
        name="Windows Server 2022",
        family="Windows Server",
        version="2022",
        status=SupportStatus.SUPPORTED,
    ),
    OSRelease(
        name="Windows Server 2025",
        family="Windows Server",
        version="2025",
        status=SupportStatus.TEST_READY,
        notes=(
            "Architecturally prepared; no end-to-end validation campaign "
            "performed yet. Production rollout requires a dedicated test run."
        ),
    ),
)


# ────────────────────────────────────────────────────────────────────────
# Windows 386 -- conditional on real test-available builds. We do NOT
# claim general 32-bit Windows support; the installer will block on
# unknown 32-bit OS releases by default and only proceed on entries
# explicitly listed here.
# ────────────────────────────────────────────────────────────────────────
WINDOWS_386_RELEASES: tuple[OSRelease, ...] = (
    OSRelease(
        name="Windows 10 32-bit",
        family="Windows 10",
        version="*",
        status=SupportStatus.CONDITIONAL,
        notes=(
            "Supported only on test-available builds. No default support "
            "claim. Windows Server x86 releases are NOT supported -- the "
            "Server 32-bit lineage was discontinued after Windows Server "
            "2008."
        ),
    ),
)


# ────────────────────────────────────────────────────────────────────────
# Linux amd64 -- the broad supported set. Distros pinned to versions
# whose minimum kernel + glibc carry the syscall and crypto surface the
# private runtime depends on.
# ────────────────────────────────────────────────────────────────────────
LINUX_AMD64_RELEASES: tuple[OSRelease, ...] = (
    OSRelease(
        name="Debian",
        family="Debian",
        version="11+",
        minimum_kernel="5.10",
        minimum_glibc="2.31",
        status=SupportStatus.SUPPORTED,
    ),
    OSRelease(
        name="Ubuntu",
        family="Ubuntu",
        version="20.04+",
        minimum_kernel="5.4",
        minimum_glibc="2.31",
        status=SupportStatus.SUPPORTED,
    ),
    OSRelease(
        name="RHEL",
        family="RHEL",
        version="8+",
        minimum_kernel="4.18",
        minimum_glibc="2.28",
        status=SupportStatus.SUPPORTED,
    ),
    OSRelease(
        name="Rocky Linux",
        family="Rocky Linux",
        version="8+",
        minimum_kernel="4.18",
        minimum_glibc="2.28",
        status=SupportStatus.SUPPORTED,
    ),
    OSRelease(
        name="AlmaLinux",
        family="AlmaLinux",
        version="8+",
        minimum_kernel="4.18",
        minimum_glibc="2.28",
        status=SupportStatus.SUPPORTED,
    ),
    OSRelease(
        name="CentOS Stream",
        family="CentOS Stream",
        version="8+",
        minimum_kernel="4.18",
        minimum_glibc="2.28",
        status=SupportStatus.SUPPORTED,
    ),
    OSRelease(
        name="openSUSE Leap",
        family="openSUSE Leap",
        version="15+",
        minimum_kernel="5.3",
        minimum_glibc="2.31",
        status=SupportStatus.SUPPORTED,
    ),
    OSRelease(
        name="SUSE Linux Enterprise Server",
        family="SLES",
        version="15+",
        minimum_kernel="5.3",
        minimum_glibc="2.31",
        status=SupportStatus.SUPPORTED,
    ),
)


# ────────────────────────────────────────────────────────────────────────
# Linux 386 -- conditional. 32-bit Linux is largely deprecated upstream
# (Ubuntu dropped i386 installer images years ago; Fedora/RHEL never had
# them). We prepare the build/manifest plumbing, but enable per
# deployment only after explicit test.
# ────────────────────────────────────────────────────────────────────────
LINUX_386_RELEASES: tuple[OSRelease, ...] = (
    OSRelease(
        name="Debian 32-bit",
        family="Debian",
        version="11+",
        minimum_kernel="5.10",
        minimum_glibc="2.31",
        status=SupportStatus.CONDITIONAL,
        notes=(
            "Only enabled on per-deployment basis after dedicated test. "
            "Most distros (Ubuntu, Fedora, RHEL, Rocky, Alma) dropped "
            "i386 installer media years ago and are NOT supported on 386."
        ),
    ),
)


SUPPORT_MATRIX: dict[Platform, tuple[OSRelease, ...]] = {
    WINDOWS_AMD64: WINDOWS_AMD64_RELEASES,
    WINDOWS_386: WINDOWS_386_RELEASES,
    LINUX_AMD64: LINUX_AMD64_RELEASES,
    LINUX_386: LINUX_386_RELEASES,
}


# ────────────────────────────────────────────────────────────────────────
# Explicit UNSUPPORTED enumerations. Absence from the supported list is
# the unsupported state by default; the lists below are belt-and-braces
# so the installer's "not supported" message names the specific OS the
# operator was probably trying to run.
# ────────────────────────────────────────────────────────────────────────
UNSUPPORTED_OS: tuple[str, ...] = (
    # EOL Windows desktop releases (TLS 1.2 unsupported or unavailable)
    "Windows XP",
    "Windows Vista",
    "Windows 7",
    "Windows 8",
    "Windows 8.1",
    # EOL Windows Server releases (TLS / crypto surface insufficient)
    "Windows Server 2003",
    "Windows Server 2008",
    "Windows Server 2008 R2",
    "Windows Server 2012",
    "Windows Server 2012 R2",
    # Server 2016 -- intentionally out of MVP; not committed.
    "Windows Server 2016",
)


UNSUPPORTED_ARCHITECTURES: tuple[str, ...] = (
    "arm",
    "arm64",
    "aarch64",
    "mips",
    "mipsel",
    "mips64",
    "ppc64",
    "ppc64le",
    "riscv64",
    "s390x",
)


SUPPORTED_PACKAGE_MANAGERS: tuple[str, ...] = (
    "apt",
    "dnf",
    "yum",
    "zypper",
)


UNSUPPORTED_PACKAGE_MANAGERS: tuple[str, ...] = (
    # Embedded / OpenWRT
    "opkg",
    # Arch family -- not in MVP
    "pacman",
    # Alpine -- musl libc, no glibc shipped; not in MVP
    "apk",
    # Gentoo
    "emerge",
    # Void Linux
    "xbps",
    # Slackware
    "slackpkg",
)


def get_releases(platform: Platform) -> tuple[OSRelease, ...]:
    """Return the OS-release tuple for the given platform (empty if unknown)."""
    return SUPPORT_MATRIX.get(platform, ())


def is_package_manager_supported(name: str) -> bool:
    """Whether the named package manager is in the supported set.

    Comparison is case-insensitive; whitespace is stripped. A name that
    is neither in the supported nor the unsupported list returns
    ``False`` -- the safe default for an unknown package manager is
    "not supported".
    """
    if not isinstance(name, str):
        return False
    return name.strip().lower() in SUPPORTED_PACKAGE_MANAGERS
