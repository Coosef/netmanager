"""Pin the OSFamily / Architecture / Platform model + parsers.

These tests are the contract every downstream PR (PR-B bootstrapper,
PR-C Windows runtime resolver, PR-D Linux installer, PR-E endpoints,
PR-F CI matrix, PR-G updater) reads against. Changing any of them
without updating the matching test is a regression.

Conventions pinned here:
  * Enum string values match Go's GOOS/GOARCH ("windows", "linux",
    "amd64", "386"). Filesystem paths and download URLs derive from
    these mechanically, so the values are load-bearing.
  * Parsers accept the broadest common spellings (x86_64, amd64,
    x64, i386, i486, i586, i686, x86) and normalise to the Go form.
  * Anything outside the supported set raises ValueError -- there is
    no "best-guess" fallback.
"""
from __future__ import annotations

import pytest

from app.services.agent_installer import (
    ALL_PLATFORMS,
    Architecture,
    LINUX_386,
    LINUX_AMD64,
    OSFamily,
    Platform,
    WINDOWS_386,
    WINDOWS_AMD64,
    parse_architecture,
    parse_os_family,
    parse_platform_string,
)


# ── Enum value pins (load-bearing for artifact filenames + URLs) ────────


def test_os_family_values_match_go_goos():
    assert OSFamily.WINDOWS.value == "windows"
    assert OSFamily.LINUX.value == "linux"


def test_architecture_values_match_go_goarch():
    assert Architecture.AMD64.value == "amd64"
    assert Architecture.X86_386.value == "386"


def test_os_family_is_strenum():
    """The string-subclass behaviour lets the enum drop straight into
    f-strings without an explicit `.value` accessor."""
    assert f"{OSFamily.WINDOWS}-{Architecture.AMD64}" == "windows-amd64"


def test_architecture_is_strenum():
    assert f"{Architecture.X86_386}" == "386"


# ── Platform dataclass ──────────────────────────────────────────────────


def test_platform_str_is_canonical_form():
    assert str(WINDOWS_AMD64) == "windows-amd64"
    assert str(WINDOWS_386) == "windows-386"
    assert str(LINUX_AMD64) == "linux-amd64"
    assert str(LINUX_386) == "linux-386"


def test_platform_canonical_string_alias():
    assert WINDOWS_AMD64.canonical_string == "windows-amd64"


def test_platform_is_frozen_and_hashable():
    """Frozen dataclass -> usable as dict key (the support matrix relies on this)."""
    d = {WINDOWS_AMD64: 1, LINUX_386: 2}
    assert d[WINDOWS_AMD64] == 1
    assert d[LINUX_386] == 2


def test_platform_equality_is_value_based():
    """Two `Platform` objects with the same components must be ==."""
    p1 = Platform(OSFamily.WINDOWS, Architecture.AMD64)
    p2 = Platform(OSFamily.WINDOWS, Architecture.AMD64)
    assert p1 == p2
    assert p1 is not p2 or True  # identity not asserted; equality is


def test_all_platforms_has_exactly_four_entries():
    """MVP scope: windows-amd64, windows-386, linux-amd64, linux-386."""
    assert len(ALL_PLATFORMS) == 4
    assert WINDOWS_AMD64 in ALL_PLATFORMS
    assert WINDOWS_386 in ALL_PLATFORMS
    assert LINUX_AMD64 in ALL_PLATFORMS
    assert LINUX_386 in ALL_PLATFORMS


def test_all_platforms_are_unique():
    assert len(set(ALL_PLATFORMS)) == len(ALL_PLATFORMS)


# ── parse_architecture ──────────────────────────────────────────────────


@pytest.mark.parametrize("spelling", ["amd64", "x86_64", "x86-64", "x64",
                                       "AMD64", "X86_64", " amd64 "])
def test_parse_architecture_amd64_spellings(spelling):
    assert parse_architecture(spelling) is Architecture.AMD64


@pytest.mark.parametrize("spelling", ["386", "i386", "i486", "i586",
                                       "i686", "x86", "I686", " 386 "])
def test_parse_architecture_386_spellings(spelling):
    assert parse_architecture(spelling) is Architecture.X86_386


@pytest.mark.parametrize("spelling", ["arm", "arm64", "aarch64", "mips",
                                       "ppc64le", "riscv64", "s390x",
                                       "ia64", "alpha"])
def test_parse_architecture_rejects_unsupported(spelling):
    with pytest.raises(ValueError, match="unsupported architecture"):
        parse_architecture(spelling)


def test_parse_architecture_rejects_empty():
    with pytest.raises(ValueError):
        parse_architecture("")


def test_parse_architecture_rejects_non_string():
    with pytest.raises(ValueError, match="must be a string"):
        parse_architecture(386)  # type: ignore[arg-type]


# ── parse_os_family ─────────────────────────────────────────────────────


@pytest.mark.parametrize("spelling", ["windows", "Windows", "win", "win32",
                                       " WINDOWS "])
def test_parse_os_family_windows_spellings(spelling):
    assert parse_os_family(spelling) is OSFamily.WINDOWS


@pytest.mark.parametrize("spelling", ["linux", "Linux", "gnu/linux", "GNU/Linux"])
def test_parse_os_family_linux_spellings(spelling):
    assert parse_os_family(spelling) is OSFamily.LINUX


@pytest.mark.parametrize("spelling", ["darwin", "macos", "osx",
                                       "freebsd", "openbsd", "netbsd",
                                       "illumos", "solaris"])
def test_parse_os_family_rejects_non_mvp(spelling):
    """MVP scope does not include macOS or BSD variants. The installer
    must fail closed rather than silently treat them as 'unix-ish'."""
    with pytest.raises(ValueError, match="unsupported os family"):
        parse_os_family(spelling)


def test_parse_os_family_rejects_non_string():
    with pytest.raises(ValueError, match="must be a string"):
        parse_os_family(1)  # type: ignore[arg-type]


# ── parse_platform_string ───────────────────────────────────────────────


def test_parse_platform_canonical_round_trip():
    """Every Platform's str(...) form must round-trip through the parser."""
    for p in ALL_PLATFORMS:
        assert parse_platform_string(str(p)) == p


@pytest.mark.parametrize("text,expected", [
    ("windows-amd64", WINDOWS_AMD64),
    ("windows-386", WINDOWS_386),
    ("linux-amd64", LINUX_AMD64),
    ("linux-386", LINUX_386),
    ("WINDOWS-AMD64", WINDOWS_AMD64),
    (" windows-amd64 ", WINDOWS_AMD64),
    ("linux-x86_64", LINUX_AMD64),  # normalised
    ("windows-i686", WINDOWS_386),  # normalised
])
def test_parse_platform_string_accepts(text, expected):
    assert parse_platform_string(text) == expected


@pytest.mark.parametrize("text", [
    "",
    "windows",   # missing arch suffix
    "amd64",     # missing OS prefix
    "darwin-amd64",        # unsupported os
    "windows-aarch64",     # unsupported arch
    "linux-mipsel",        # unsupported arch
    "windows-amd64-extra", # extra component routed to arch -> 'amd64-extra'
])
def test_parse_platform_string_rejects(text):
    with pytest.raises(ValueError):
        parse_platform_string(text)


def test_parse_platform_string_rejects_non_string():
    with pytest.raises(ValueError, match="must be a string"):
        parse_platform_string(["windows", "amd64"])  # type: ignore[arg-type]


# ── Cross-PR contract guard ─────────────────────────────────────────────


def test_platform_string_form_uses_hyphen_separator():
    """PR-E (architecture-aware endpoints) will path-segment on '-'.
    PR-F (offline installer filenames) will too. Locking the separator
    here makes the cross-PR coupling explicit."""
    assert "-" in str(WINDOWS_AMD64)
    assert str(WINDOWS_AMD64).count("-") == 1
