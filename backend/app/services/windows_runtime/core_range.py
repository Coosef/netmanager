"""Host core-version compatibility — Section C.3 of the architecture plan.

The `compatible_host_core_range` field in the detached manifest is a
restricted-grammar string. This module provides:

  - `parse_core_range(spec)` — parse the manifest field. Returns a
    `(min_triple, max_exclusive_triple)` pair on success; raises
    `CoreRangeError` on any unsupported grammar (correction #25).
  - `parse_host_version(version)` — parse the existing host version
    contract `^(\\d+)\\.(\\d+)\\.(\\d+)-mvp0\\+g[0-9a-f]{12}$` and
    return the core triple. Uppercase hex is REJECTED.
  - `satisfies(host_version_string, range_spec)` — convenience.

This is NOT a SemVer library. The grammar is intentionally one
specifier — `>=N.N.N <N.N.N` — with a single space. PEP-440, npm
caret/tilde, comma-separated and any other range syntax raise.
"""
from __future__ import annotations

import re


# --------------------------------------------------------------------- #
# Errors.
# --------------------------------------------------------------------- #


class CoreRangeError(ValueError):
    """A compatibility-grammar or host-version-format failure."""


# --------------------------------------------------------------------- #
# Grammar.
# --------------------------------------------------------------------- #


# `range := ">=" version " " "<" version`
# `version := DIGITS "." DIGITS "." DIGITS`
# Single space between bounds; no commas, no carets, no tildes,
# no wildcards, no inclusive upper.
_RANGE_RE = re.compile(
    r"^>=(?P<min_maj>\d+)\.(?P<min_min>\d+)\.(?P<min_pat>\d+) "
    r"<(?P<max_maj>\d+)\.(?P<max_min>\d+)\.(?P<max_pat>\d+)$"
)


CoreTriple = tuple[int, int, int]


def parse_core_range(spec: str) -> tuple[CoreTriple, CoreTriple]:
    """Parse `compatible_host_core_range`.

    Returns `(min_triple, max_exclusive_triple)` if the spec is valid.
    Raises `CoreRangeError` otherwise.
    """
    if not isinstance(spec, str) or spec == "":
        raise CoreRangeError("compatible_host_core_range is empty or non-string")
    match = _RANGE_RE.fullmatch(spec)
    if not match:
        raise CoreRangeError(
            f"compatible_host_core_range {spec!r} does not match the "
            f"restricted grammar `>=N.N.N <N.N.N`"
        )
    lo = (int(match["min_maj"]), int(match["min_min"]), int(match["min_pat"]))
    hi = (int(match["max_maj"]), int(match["max_min"]), int(match["max_pat"]))
    if hi <= lo:
        raise CoreRangeError(
            f"compatible_host_core_range upper bound {hi} must be strictly "
            f"greater than lower bound {lo}"
        )
    return lo, hi


# --------------------------------------------------------------------- #
# Host version string parsing.
# --------------------------------------------------------------------- #


# Matches `agents.py:731`'s existing host version regex. Lowercase hex
# only; uppercase is REJECTED.
_HOST_VERSION_RE = re.compile(
    r"^(?P<maj>\d+)\.(?P<min>\d+)\.(?P<pat>\d+)-mvp0\+g(?P<sha>[0-9a-f]{12})$"
)


def parse_host_version(version: str) -> CoreTriple:
    """Extract the `(major, minor, patch)` triple from a host version.

    The `-mvp0+g<hex12>` suffix is project metadata; it does NOT
    participate in range comparison. Mismatched suffix shape (missing
    `-mvp0`, uppercase hex, wrong hex length, etc.) raises.
    """
    if not isinstance(version, str):
        raise CoreRangeError("host version is not a string")
    match = _HOST_VERSION_RE.fullmatch(version)
    if not match:
        raise CoreRangeError(
            f"host version {version!r} does not match `<n>.<n>.<n>-mvp0+g<12-lowercase-hex>`"
        )
    return (int(match["maj"]), int(match["min"]), int(match["pat"]))


# --------------------------------------------------------------------- #
# Acceptance check.
# --------------------------------------------------------------------- #


def satisfies(host_version: str, range_spec: str) -> bool:
    """Return True iff `host_version` is in `[lo, hi)` of `range_spec`."""
    lo, hi = parse_core_range(range_spec)
    triple = parse_host_version(host_version)
    return lo <= triple < hi
