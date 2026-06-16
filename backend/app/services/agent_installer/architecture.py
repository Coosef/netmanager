"""OS-family / architecture / platform model + normalisation parsers.

Pure data + helpers; no I/O, no side effects, no behaviour change in
existing installer flows. The convention follows Go's GOOS/GOARCH so
that artifact names + filesystem paths remain mechanical to derive
("windows-amd64", "linux-386", ...).

Backwards compatibility with the existing system:
  * The current Windows runtime manifest pins `platform = "windows-amd64"`
    as a single hardcoded string. That representation continues to
    work; this module simply gives future code an explicit decomposition
    `(OSFamily.WINDOWS, Architecture.AMD64)` to reason about.
  * Parsers accept the broadest set of common spellings (`x86_64`,
    `amd64`, `i686`, `x86`, ...) and normalise to the Go convention.
    Anything outside the supported set raises ValueError -- the caller
    decides whether that's a 4xx, a 503, or a hard installer block.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass


class OSFamily(str, enum.Enum):
    """Top-level OS family. MVP scope is Windows + Linux only.

    The string value is the Go GOOS name so manifest fields, filesystem
    paths, and download URLs share one canonical form.
    """

    WINDOWS = "windows"
    LINUX = "linux"

    def __str__(self) -> str:
        # Python 3.12 changed Enum's default __str__ to "ClassName.MEMBER"
        # even when the base class is str. We pin the string-value form
        # so f-strings and filesystem-path construction stay readable.
        return self.value


class Architecture(str, enum.Enum):
    """CPU architecture. MVP scope is x86-64 + 32-bit x86 only.

    The string value is the Go GOARCH name. `"386"` is the canonical
    32-bit-x86 token even though it covers i486/i586/i686 too; modern
    builds typically target i686-compatible 32-bit x86.
    """

    AMD64 = "amd64"
    X86_386 = "386"

    def __str__(self) -> str:
        return self.value


@dataclass(frozen=True, eq=True)
class Platform:
    """An (OSFamily, Architecture) pair, the canonical artifact identifier."""

    os_family: OSFamily
    architecture: Architecture

    def __str__(self) -> str:
        """Canonical string form, e.g. ``windows-amd64`` or ``linux-386``."""
        return f"{self.os_family.value}-{self.architecture.value}"

    @property
    def canonical_string(self) -> str:
        """Alias for ``str(self)`` -- explicit-name accessor for clarity."""
        return str(self)


WINDOWS_AMD64 = Platform(OSFamily.WINDOWS, Architecture.AMD64)
WINDOWS_386 = Platform(OSFamily.WINDOWS, Architecture.X86_386)
LINUX_AMD64 = Platform(OSFamily.LINUX, Architecture.AMD64)
LINUX_386 = Platform(OSFamily.LINUX, Architecture.X86_386)

ALL_PLATFORMS: tuple[Platform, ...] = (
    WINDOWS_AMD64,
    WINDOWS_386,
    LINUX_AMD64,
    LINUX_386,
)


# Architecture normalisation -- accept common spellings, normalise to Go GOARCH.
_ARCH_NORMALIZE: dict[str, Architecture] = {
    "amd64": Architecture.AMD64,
    "x86_64": Architecture.AMD64,
    "x86-64": Architecture.AMD64,
    "x64": Architecture.AMD64,
    "386": Architecture.X86_386,
    "i386": Architecture.X86_386,
    "i486": Architecture.X86_386,
    "i586": Architecture.X86_386,
    "i686": Architecture.X86_386,
    "x86": Architecture.X86_386,
}

# OS family normalisation -- accept common spellings, normalise to Go GOOS.
_OS_NORMALIZE: dict[str, OSFamily] = {
    "windows": OSFamily.WINDOWS,
    "win": OSFamily.WINDOWS,
    "win32": OSFamily.WINDOWS,
    "linux": OSFamily.LINUX,
    "gnu/linux": OSFamily.LINUX,
}


def parse_architecture(value: str) -> Architecture:
    """Normalise a CPU-architecture token to an :class:`Architecture`.

    Accepts common spellings: ``amd64`` / ``x86_64`` / ``x86-64`` / ``x64``
    for 64-bit x86; ``386`` / ``i386`` / ``i486`` / ``i586`` / ``i686``
    / ``x86`` for 32-bit x86.

    Raises:
        ValueError: if ``value`` is not a string or names an unsupported
            architecture (arm/arm64/aarch64/mips/etc). The caller is
            responsible for deciding whether to surface this as a
            4xx response, a 503, or an installer block.
    """
    if not isinstance(value, str):
        raise ValueError(f"architecture must be a string, got {type(value).__name__}")
    norm = value.strip().lower()
    if norm in _ARCH_NORMALIZE:
        return _ARCH_NORMALIZE[norm]
    raise ValueError(f"unsupported architecture {value!r}")


def parse_os_family(value: str) -> OSFamily:
    """Normalise an OS-family token to an :class:`OSFamily`.

    Raises:
        ValueError: if ``value`` is not a string or names an OS family
            outside the MVP scope (macOS, BSD variants, illumos, etc).
    """
    if not isinstance(value, str):
        raise ValueError(f"os family must be a string, got {type(value).__name__}")
    norm = value.strip().lower()
    if norm in _OS_NORMALIZE:
        return _OS_NORMALIZE[norm]
    raise ValueError(f"unsupported os family {value!r}")


def parse_platform_string(value: str) -> Platform:
    """Parse a canonical platform string like ``windows-amd64`` or ``linux-386``.

    Splits on the LAST ``-`` so that any future OS family names that
    contain a hyphen (none today) would still parse the architecture
    suffix correctly.

    Raises:
        ValueError: missing separator, or either component unparseable.
    """
    if not isinstance(value, str):
        raise ValueError(f"platform must be a string, got {type(value).__name__}")
    norm = value.strip().lower()
    if "-" not in norm:
        raise ValueError(f"platform string must contain '-': {value!r}")
    os_part, _, arch_part = norm.rpartition("-")
    return Platform(parse_os_family(os_part), parse_architecture(arch_part))
