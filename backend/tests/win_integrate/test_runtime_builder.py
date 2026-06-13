"""ops/windows-runtime-bundle/build.py --check tests.

The builder lives outside the backend tree. These tests exercise its
fail-closed contract — SOURCE_DATE_EPOCH required / range-bounded,
smoke-list canonical byte format, release-pins schema, lock file
shape.

The full `--build` path is gated to PR #4; PR #1 ships only `--check`,
so the tests cover the validation pipeline up to but not including
the actual ZIP assembly.
"""
from __future__ import annotations

import importlib.util
import os
import re
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
BUILD_PY = REPO_ROOT / "ops" / "windows-runtime-bundle" / "build.py"
OPS_DIR = REPO_ROOT / "ops" / "windows-runtime-bundle"


@pytest.fixture(scope="session")
def builder_module():
    """Import build.py as a module (its top is import-safe)."""
    spec = importlib.util.spec_from_file_location("rb_build", BUILD_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


# --------------------------------------------------------------------- #
# SOURCE_DATE_EPOCH contract.
# --------------------------------------------------------------------- #


def _epoch_bounds(builder_module) -> tuple[int, int]:
    upper = builder_module._probe_zip_upper_bound()
    return builder_module.SOURCE_DATE_EPOCH_MIN, upper


def test_source_date_epoch_required(builder_module):
    with pytest.raises(builder_module.BuilderError) as excinfo:
        builder_module.parse_source_date_epoch({}, upper_bound=4_000_000_000)
    assert "REQUIRED" in str(excinfo.value)


@pytest.mark.parametrize("value", ["", "  ", " "])
def test_source_date_epoch_empty_or_whitespace_rejected(builder_module, value):
    with pytest.raises(builder_module.BuilderError):
        builder_module.parse_source_date_epoch(
            {"SOURCE_DATE_EPOCH": value},
            upper_bound=4_000_000_000,
        )


@pytest.mark.parametrize("value", ["abc", "1.5", "1e9", "0x100"])
def test_source_date_epoch_non_integer_rejected(builder_module, value):
    with pytest.raises(builder_module.BuilderError):
        builder_module.parse_source_date_epoch(
            {"SOURCE_DATE_EPOCH": value},
            upper_bound=4_000_000_000,
        )


def test_source_date_epoch_negative_rejected(builder_module):
    with pytest.raises(builder_module.BuilderError):
        builder_module.parse_source_date_epoch(
            {"SOURCE_DATE_EPOCH": "-1"},
            upper_bound=4_000_000_000,
        )


def test_source_date_epoch_below_1980_rejected(builder_module):
    with pytest.raises(builder_module.BuilderError):
        builder_module.parse_source_date_epoch(
            {"SOURCE_DATE_EPOCH": "1000"},
            upper_bound=4_000_000_000,
        )


def test_source_date_epoch_above_library_bound_rejected(builder_module):
    lo, hi = _epoch_bounds(builder_module)
    with pytest.raises(builder_module.BuilderError):
        builder_module.parse_source_date_epoch(
            {"SOURCE_DATE_EPOCH": str(hi + 60)},
            upper_bound=hi,
        )


def test_source_date_epoch_canonical_value_accepted(builder_module):
    value = builder_module.parse_source_date_epoch(
        {"SOURCE_DATE_EPOCH": "1735689600"},
        upper_bound=4_000_000_000,
    )
    assert value == 1_735_689_600


def test_epoch_to_dos_bucket_normalizes_to_even_second(builder_module):
    assert builder_module.epoch_to_dos_bucket(1_735_689_601) == 1_735_689_600
    assert builder_module.epoch_to_dos_bucket(1_735_689_602) == 1_735_689_602


def test_epoch_to_iso8601_utc_uses_original_epoch(builder_module):
    # The manifest's `built_utc` is derived from the ORIGINAL epoch,
    # not the bucket-normalized one (#39).
    assert builder_module.epoch_to_iso8601_utc(1_735_689_601) == "2025-01-01T00:00:01Z"
    assert builder_module.epoch_to_iso8601_utc(1_735_689_600) == "2025-01-01T00:00:00Z"


# --------------------------------------------------------------------- #
# Smoke-list canonical byte format.
# --------------------------------------------------------------------- #


def test_canonical_smoke_list_validates(builder_module, tmp_path):
    path = OPS_DIR / "runtime-smoke-imports.txt"
    modules = builder_module.validate_smoke_list_bytes(path)
    assert modules == [
        "ssl", "socket", "ctypes", "asyncio", "netmanager_agent",
        "websockets", "netmiko", "paramiko", "cryptography",
        "bcrypt", "nacl", "psutil",
    ]


def test_canonical_smoke_list_size_is_103_bytes():
    path = OPS_DIR / "runtime-smoke-imports.txt"
    assert path.stat().st_size == 103


def test_smoke_list_rejects_bom(builder_module, tmp_path):
    bad = tmp_path / "bom.txt"
    bad.write_bytes(b"\xef\xbb\xbf" + b"ssl\n")
    with pytest.raises(builder_module.BuilderError) as excinfo:
        builder_module.validate_smoke_list_bytes(bad)
    assert "BOM" in str(excinfo.value)


def test_smoke_list_rejects_crlf(builder_module, tmp_path):
    bad = tmp_path / "crlf.txt"
    bad.write_bytes(b"ssl\r\nsocket\r\n")
    with pytest.raises(builder_module.BuilderError):
        builder_module.validate_smoke_list_bytes(bad)


def test_smoke_list_rejects_missing_trailing_newline(builder_module, tmp_path):
    bad = tmp_path / "no_nl.txt"
    bad.write_bytes(b"ssl")
    with pytest.raises(builder_module.BuilderError):
        builder_module.validate_smoke_list_bytes(bad)


def test_smoke_list_rejects_double_trailing_newline(builder_module, tmp_path):
    bad = tmp_path / "double_nl.txt"
    bad.write_bytes(b"ssl\n\n")
    with pytest.raises(builder_module.BuilderError):
        builder_module.validate_smoke_list_bytes(bad)


def test_smoke_list_rejects_blank_line_in_middle(builder_module, tmp_path):
    bad = tmp_path / "blank_middle.txt"
    bad.write_bytes(b"ssl\n\nsocket\n")
    with pytest.raises(builder_module.BuilderError):
        builder_module.validate_smoke_list_bytes(bad)


def test_smoke_list_rejects_invalid_module_name(builder_module, tmp_path):
    bad = tmp_path / "bad_name.txt"
    bad.write_bytes(b"ssl\nnot-a-module\n")
    with pytest.raises(builder_module.BuilderError):
        builder_module.validate_smoke_list_bytes(bad)


def test_smoke_list_rejects_duplicate(builder_module, tmp_path):
    bad = tmp_path / "dup.txt"
    bad.write_bytes(b"ssl\nsocket\nssl\n")
    with pytest.raises(builder_module.BuilderError):
        builder_module.validate_smoke_list_bytes(bad)


def test_smoke_list_rejects_empty_file(builder_module, tmp_path):
    bad = tmp_path / "empty.txt"
    bad.write_bytes(b"")
    with pytest.raises(builder_module.BuilderError):
        builder_module.validate_smoke_list_bytes(bad)


# --------------------------------------------------------------------- #
# Release-pins schema.
# --------------------------------------------------------------------- #


def test_release_pins_loads(builder_module):
    pins = builder_module.load_release_pins(OPS_DIR / "release-pins.toml")
    assert pins["RUNTIME_VERSION"] == "1.0.0"
    assert pins["BUNDLE_PLATFORM"] == "windows-amd64"
    assert pins["COMPATIBLE_HOST_CORE_RANGE"] == ">=2.0.0 <3.0.0"


def test_release_pins_rejects_timestamp_field(builder_module, tmp_path):
    bad = tmp_path / "with_timestamp.toml"
    bad.write_text(
        '\n'.join([
            'RUNTIME_VERSION = "1.0.0"',
            'EMBEDDED_PYTHON_URL = "https://example/x.zip"',
            'EMBEDDED_PYTHON_SHA256 = "' + 'A' * 64 + '"',
            'PYTHON_VERSION = "3.12.6"',
            'BUNDLE_PLATFORM = "windows-amd64"',
            'COMPATIBLE_HOST_CORE_RANGE = ">=2.0.0 <3.0.0"',
            'SIZE_LOWER_BOUND_BYTES = 1',
            'SIZE_UPPER_BOUND_BYTES = 2',
            'RELEASE_TIMESTAMP_UTC = "2026-06-12T00:00:00Z"',
            '',
        ]),
        encoding="utf-8",
    )
    with pytest.raises(builder_module.BuilderError) as excinfo:
        builder_module.load_release_pins(bad)
    assert "RELEASE_TIMESTAMP_UTC" in str(excinfo.value)


def test_release_pins_rejects_bad_sha(builder_module, tmp_path):
    bad = tmp_path / "bad_sha.toml"
    bad.write_text(
        '\n'.join([
            'RUNTIME_VERSION = "1.0.0"',
            'EMBEDDED_PYTHON_URL = "https://example/x.zip"',
            'EMBEDDED_PYTHON_SHA256 = "not-a-sha"',
            'PYTHON_VERSION = "3.12.6"',
            'BUNDLE_PLATFORM = "windows-amd64"',
            'COMPATIBLE_HOST_CORE_RANGE = ">=2.0.0 <3.0.0"',
            'SIZE_LOWER_BOUND_BYTES = 1',
            'SIZE_UPPER_BOUND_BYTES = 2',
            '',
        ]),
        encoding="utf-8",
    )
    with pytest.raises(builder_module.BuilderError):
        builder_module.load_release_pins(bad)


# --------------------------------------------------------------------- #
# Lock file parsing.
# --------------------------------------------------------------------- #


def test_lock_file_parses_and_has_hashes(builder_module):
    pinned = builder_module.parse_requirements_lock(
        OPS_DIR / "requirements-windows.lock"
    )
    assert len(pinned) >= 6  # minimum floor


def test_lock_file_rejects_entry_without_hash(builder_module, tmp_path):
    bad = tmp_path / "no_hash.lock"
    bad.write_text("widget==1.0.0\n")
    with pytest.raises(builder_module.BuilderError):
        builder_module.parse_requirements_lock(bad)


# --------------------------------------------------------------------- #
# End-to-end `--check`.
# --------------------------------------------------------------------- #


def test_run_check_succeeds_with_valid_epoch(monkeypatch, capsys, builder_module):
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689600")
    rc = builder_module.run_check(OPS_DIR)
    captured = capsys.readouterr()
    assert rc == 0
    assert "CHECK_RESULT=OK" in captured.out


def test_main_fails_without_epoch(monkeypatch, capsys, builder_module):
    monkeypatch.delenv("SOURCE_DATE_EPOCH", raising=False)
    rc = builder_module.main(["--check"])
    captured = capsys.readouterr()
    assert rc == 1
    assert "BUILDER_ERROR" in captured.err
