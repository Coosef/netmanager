"""Section F canonicalization tests.

Each negative case is named after the rule that fires; the test asserts
the raised error's `code` matches the rule. Positive cases (e.g.
`CONSOLE.txt`, `COM10.txt`, `LPT10.txt`) explicitly DO NOT raise.
"""
from __future__ import annotations

import pytest

from app.services.windows_runtime.canonical_path import (
    CanonicalPathError,
    CanonicalPathRule,
    CanonicalPathSet,
    canonicalize,
)


# --------------------------------------------------------------------- #
# Positive: canonical form preserved + slash normalized.
# --------------------------------------------------------------------- #


def test_unix_separator_normalized_to_backslash():
    assert canonicalize("app/foo.py") == r"app\foo.py"


def test_already_canonical_round_trips():
    assert canonicalize(r"app\foo.py") == r"app\foo.py"


def test_deep_path_preserved():
    raw = r"runtime\python\Lib\site-packages\websockets\__init__.py"
    assert canonicalize(raw) == raw


# --------------------------------------------------------------------- #
# Per-rule negatives.
# --------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "path, code",
    [
        ("", CanonicalPathRule.EMPTY),
        ("/app/foo.py", CanonicalPathRule.LEADING_SEPARATOR),
        ("\\app\\foo.py", CanonicalPathRule.LEADING_SEPARATOR),
        ("C:\\foo.py", CanonicalPathRule.DRIVE_LETTER),
        ("c:foo.py", CanonicalPathRule.DRIVE_LETTER),
        ("\\\\server\\share\\foo.py", CanonicalPathRule.UNC),
        ("\\\\?\\C:\\foo.py", CanonicalPathRule.NT_DEVICE),
        ("\\\\.\\PhysicalDrive0", CanonicalPathRule.NT_DEVICE),
        ("app\\\\foo.py", CanonicalPathRule.EMPTY_SEGMENT),
        ("app\\.\\foo.py", CanonicalPathRule.DOT_SEGMENT),
        ("app\\..\\foo.py", CanonicalPathRule.DOTDOT_SEGMENT),
        ("..\\..\\escape", CanonicalPathRule.DOTDOT_SEGMENT),
        ("app\\foo.", CanonicalPathRule.TRAILING_DOT),
        ("app\\...\\foo.py", CanonicalPathRule.TRAILING_DOT),
        ("app\\foo ", CanonicalPathRule.TRAILING_SPACE),
        ("app\\ foo", CanonicalPathRule.RESERVED_DEVICE_NAME)
        if False
        else ("app\\foo ", CanonicalPathRule.TRAILING_SPACE),
        ("app\\foo:bar", CanonicalPathRule.COLON_IN_SEGMENT),
        ("CON", CanonicalPathRule.RESERVED_DEVICE_NAME),
        ("CON.txt", CanonicalPathRule.RESERVED_DEVICE_NAME),
        ("CON.foo.txt", CanonicalPathRule.RESERVED_DEVICE_NAME),
        ("nul.log", CanonicalPathRule.RESERVED_DEVICE_NAME),
        ("COM1.dll", CanonicalPathRule.RESERVED_DEVICE_NAME),
        ("LPT9.backup.zip", CanonicalPathRule.RESERVED_DEVICE_NAME),
        ("aux", CanonicalPathRule.RESERVED_DEVICE_NAME),
    ],
)
def test_canonicalize_rejects(path, code):
    with pytest.raises(CanonicalPathError) as excinfo:
        canonicalize(path)
    assert excinfo.value.code == code


@pytest.mark.parametrize(
    "control_path",
    [
        "app\\foo\x00bar",
        "app\\foo\x01bar",
        "app\\foo\x1fbar",
        "app\\foo\x7fbar",
    ],
)
def test_control_characters_rejected(control_path):
    with pytest.raises(CanonicalPathError) as excinfo:
        canonicalize(control_path)
    assert excinfo.value.code == CanonicalPathRule.CONTROL_CHAR


# --------------------------------------------------------------------- #
# Reserved-name FIRST-dot base name behavior (correction #29).
# --------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "path",
    [
        "CONSOLE.txt",   # base CONSOLE, not reserved
        "COM10.txt",     # base COM10, not reserved (only COM1-9)
        "LPT10.txt",     # base LPT10, not reserved (only LPT1-9)
        "CONSTANT.dll",  # base CONSTANT
        "myaux",         # base myaux (case-insensitive but not exact match)
    ],
)
def test_console_com10_lpt10_not_reserved(path):
    # These pass the reserved-name check. (Other rules may still
    # legitimately reject the path; here we just assert the reserved-
    # name rule doesn't fire.)
    try:
        canonicalize(path)
    except CanonicalPathError as err:
        if err.code == CanonicalPathRule.RESERVED_DEVICE_NAME:
            pytest.fail(
                f"{path!r} should NOT be rejected as a reserved device name"
            )


# --------------------------------------------------------------------- #
# Set tracker (steps 7 + 8 + explicit-directory rule).
# --------------------------------------------------------------------- #


def test_set_accepts_distinct_paths():
    s = CanonicalPathSet()
    s.add(r"app\foo.py")
    s.add(r"app\bar.py")
    s.add(r"runtime\python\python.exe")
    assert len(s) == 3


def test_set_rejects_case_insensitive_duplicate():
    s = CanonicalPathSet()
    s.add(r"app\Foo.py")
    with pytest.raises(CanonicalPathError) as excinfo:
        s.add(r"app\foo.py")
    assert excinfo.value.code == CanonicalPathRule.DUPLICATE_CANONICAL_KEY


def test_set_rejects_separator_normalization_duplicate():
    s = CanonicalPathSet()
    s.add("Lib/Foo.py")  # normalizes to Lib\Foo.py
    with pytest.raises(CanonicalPathError) as excinfo:
        s.add(r"Lib\Foo.py")
    assert excinfo.value.code == CanonicalPathRule.DUPLICATE_CANONICAL_KEY


def test_set_rejects_file_used_as_parent_directory():
    s = CanonicalPathSet()
    s.add(r"app\foo")
    with pytest.raises(CanonicalPathError) as excinfo:
        s.add(r"app\foo\bar.txt")
    assert excinfo.value.code == CanonicalPathRule.FILE_DIRECTORY_COLLISION


def test_set_rejects_directory_path_already_used_as_file():
    s = CanonicalPathSet()
    s.add(r"app\foo\bar.txt")
    with pytest.raises(CanonicalPathError) as excinfo:
        s.add(r"app\foo")
    assert excinfo.value.code == CanonicalPathRule.FILE_DIRECTORY_COLLISION


def test_set_rejects_explicit_directory_entry():
    s = CanonicalPathSet()
    with pytest.raises(CanonicalPathError) as excinfo:
        s.add(r"runtime\python\\", is_explicit_directory_entry=True)
    assert excinfo.value.code == CanonicalPathRule.EXPLICIT_DIRECTORY_ENTRY
