"""Host core-version compatibility tests (Section C.3, correction #25)."""
from __future__ import annotations

import pytest

from app.services.windows_runtime.core_range import (
    CoreRangeError,
    parse_core_range,
    parse_host_version,
    satisfies,
)


# --------------------------------------------------------------------- #
# parse_core_range
# --------------------------------------------------------------------- #


def test_parses_the_canonical_range():
    lo, hi = parse_core_range(">=2.0.0 <3.0.0")
    assert lo == (2, 0, 0)
    assert hi == (3, 0, 0)


def test_parses_wider_ranges():
    lo, hi = parse_core_range(">=2.5.10 <10.0.0")
    assert lo == (2, 5, 10)
    assert hi == (10, 0, 0)


@pytest.mark.parametrize(
    "spec",
    [
        ">=2.0.0,<3.0.0",            # comma is rejected
        ">= 2.0.0 <3.0.0",           # extra space before lower
        ">=2.0.0 < 3.0.0",           # extra space before upper
        ">=2.0.0  <3.0.0",           # double space between bounds
        "^2.0.0",                    # npm caret
        "~2.0.0",                    # npm tilde
        "2.x",
        "*",
        ">=2.0",                     # missing patch
        ">=2.0.0 <=3.0.0",           # inclusive upper rejected
        "==2.0.0",
        "2.0.0",
        "",
    ],
)
def test_rejects_unsupported_grammar(spec):
    with pytest.raises(CoreRangeError):
        parse_core_range(spec)


def test_rejects_inverted_bounds():
    with pytest.raises(CoreRangeError):
        parse_core_range(">=3.0.0 <2.0.0")


def test_rejects_equal_bounds():
    with pytest.raises(CoreRangeError):
        parse_core_range(">=2.0.0 <2.0.0")


# --------------------------------------------------------------------- #
# parse_host_version (existing `agents.py:731` contract)
# --------------------------------------------------------------------- #


def test_parses_valid_host_version():
    assert parse_host_version("2.0.0-mvp0+gabcdef123456") == (2, 0, 0)
    assert parse_host_version("2.9.999-mvp0+g0123456789ab") == (2, 9, 999)


@pytest.mark.parametrize(
    "raw",
    [
        "2.0.0",                              # missing suffix
        "2.0.0-mvp0+gABCDEF123456",           # uppercase hex rejected
        "2.0.0-mvp0+gabcdef",                 # short hex
        "2.0.0-mvp0+gabcdef1234567",          # long hex
        "2.0-mvp0+gabcdef123456",             # missing patch
        "2.0.0.0-mvp0+gabcdef123456",         # extra segment
        "2.0.0-mvp1+gabcdef123456",           # mvp1 not allowed
        "dev",
        "",
    ],
)
def test_rejects_malformed_host_version(raw):
    with pytest.raises(CoreRangeError):
        parse_host_version(raw)


# --------------------------------------------------------------------- #
# satisfies(): the Section C.3 acceptance table
# --------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "host_version, accepted",
    [
        ("2.0.0-mvp0+gabcdef123456", True),
        ("2.9.999-mvp0+gabcdef123456", True),
        ("3.0.0-mvp0+gabcdef123456", False),    # excluded by upper
        ("1.9.999-mvp0+gabcdef123456", False),  # below lower
    ],
)
def test_acceptance_table(host_version, accepted):
    assert satisfies(host_version, ">=2.0.0 <3.0.0") is accepted


def test_satisfies_propagates_grammar_error():
    with pytest.raises(CoreRangeError):
        satisfies("2.0.0-mvp0+gabcdef123456", "^2.0.0")
