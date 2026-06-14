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


# --------------------------------------------------------------------- #
# `--build` deterministic ZIP + manifest + sidecar (PR #4).
# --------------------------------------------------------------------- #
#
# The build mode is exercised against a SYNTHETIC source tree to keep
# the test self-contained — no Python embed download, no PyPI wheelhouse,
# no network. The synthetic tree is the minimum that satisfies the
# builder's structural checks:
#
#   metadata/runtime-smoke-imports.txt  (byte-identical to ops/)
#   app/run_agent.py                    (entrypoint)
#   app/netmanager_agent.py
#   runtime/python/python.exe           (large incompressible blob)
#   runtime/python/python312.dll
#   runtime/python/python312._pth
#   licenses/PYTHON-LICENSE.txt
#   licenses/THIRD_PARTY_NOTICES.json
#   licenses/THIRD_PARTY_NOTICES.txt
#
# To avoid waiting for a real 5 MiB ZIP, tests construct a CUSTOM root
# containing a release-pins.toml whose SIZE_LOWER_BOUND_BYTES is small
# (1024) while keeping every other invariant. This isolates the
# determinism / DOS-bucket / manifest-schema assertions from the
# production size floor (covered separately by
# `test_size_bounds_enforced`).


SHORT_PINS_TOML = """\
RUNTIME_VERSION = "9.9.9"
EMBEDDED_PYTHON_URL = "https://example.invalid/python-embed.zip"
EMBEDDED_PYTHON_SHA256 = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"
PYTHON_VERSION = "3.12.6"
BUNDLE_PLATFORM = "windows-amd64"
COMPATIBLE_HOST_CORE_RANGE = ">=2.0.0 <3.0.0"
SIZE_LOWER_BOUND_BYTES = 1024
SIZE_UPPER_BOUND_BYTES = 209715200
LOCK_MIN_DEPENDENCY_COUNT = 1
"""

PLACEHOLDER_LOCK = "\n".join([
    "websockets==12.0 \\",
    "    --hash=sha256:" + "0" * 63 + "1",
    "",
    "netmiko==4.4.0 \\",
    "    --hash=sha256:" + "0" * 63 + "2",
    "",
])


def _make_short_root(tmp_path):
    """Return a builder root with a copy of the canonical smoke list,
    a tiny placeholder lock, and a relaxed-bounds release-pins.toml."""
    root = tmp_path / "root"
    root.mkdir()
    (root / "release-pins.toml").write_text(SHORT_PINS_TOML, encoding="utf-8")
    (root / "requirements-windows.lock").write_text(
        PLACEHOLDER_LOCK, encoding="utf-8"
    )
    # Byte-copy the real smoke list — the builder enforces parity with
    # ops/ AND the in-tree mirror; substituting a hand-rolled list would
    # break the parity check.
    smoke = (OPS_DIR / "runtime-smoke-imports.txt").read_bytes()
    (root / "runtime-smoke-imports.txt").write_bytes(smoke)
    return root


def _stage_synthetic_tree(stage_root, smoke_bytes, *, runtime_bytes=b"deadbeef"):
    """Construct a minimal staged tree that passes the builder's
    structural checks. `runtime_bytes` is the payload of the synthetic
    `runtime/python/python.exe` — pass a long random buffer for tests
    that depend on the post-deflate size."""
    for d in ("runtime/python", "app", "licenses", "metadata"):
        (stage_root / d).mkdir(parents=True, exist_ok=True)
    (stage_root / "runtime" / "python" / "python.exe").write_bytes(runtime_bytes)
    (stage_root / "runtime" / "python" / "python312.dll").write_bytes(b"DLL")
    (stage_root / "runtime" / "python" / "python312._pth").write_text(
        "python312.zip\n.\nLib\\site-packages\n..\\..\\app\n\nimport site\n",
        encoding="utf-8",
    )
    (stage_root / "app" / "run_agent.py").write_text(
        "# entrypoint stub\n", encoding="utf-8"
    )
    (stage_root / "app" / "netmanager_agent.py").write_text(
        "# agent module stub\n", encoding="utf-8"
    )
    (stage_root / "licenses" / "PYTHON-LICENSE.txt").write_text(
        "PSF License\n", encoding="utf-8"
    )
    (stage_root / "licenses" / "THIRD_PARTY_NOTICES.json").write_text(
        '{"deps": []}\n', encoding="utf-8"
    )
    (stage_root / "licenses" / "THIRD_PARTY_NOTICES.txt").write_text(
        "Notices\n", encoding="utf-8"
    )
    (stage_root / "metadata" / "runtime-smoke-imports.txt").write_bytes(
        smoke_bytes
    )


# ── Happy path ────────────────────────────────────────────────────────────


def test_build_happy_path_emits_all_four_artifacts(
    monkeypatch, builder_module, tmp_path,
):
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689600")
    root = _make_short_root(tmp_path)
    stage = tmp_path / "stage"
    stage.mkdir()
    smoke = (root / "runtime-smoke-imports.txt").read_bytes()
    # 2 KiB of random bytes — exceeds the 1024 lower bound after deflate
    # because the data is incompressible.
    _stage_synthetic_tree(stage, smoke, runtime_bytes=os.urandom(2048))
    out = tmp_path / "out"

    result = builder_module.run_build(root, source_tree=stage, output_dir=out)

    assert result["zip_path"].is_file()
    assert result["sha_path"].is_file()
    assert result["manifest_path"].is_file()
    assert result["current_path"].is_file()
    # Filename convention matches Section D's on-disk source-of-truth.
    assert result["zip_path"].name == "charon-runtime-windows-amd64-9.9.9.zip"
    assert result["sha_path"].name == "charon-runtime-windows-amd64-9.9.9.zip.sha256"
    assert result["manifest_path"].name == "charon-runtime-windows-amd64-9.9.9.manifest.json"
    assert result["current_path"].name == "charon-runtime-windows-amd64.current"
    # `.current` is the single-line runtime version + LF.
    assert result["current_path"].read_text(encoding="utf-8") == "9.9.9\n"
    # Sidecar is lowercase hex + LF.
    sidecar = result["sha_path"].read_text(encoding="utf-8")
    assert sidecar == result["zip_sha256_lower"] + "\n"
    assert sidecar == sidecar.lower()


def test_build_manifest_passes_strict_pydantic_schema(
    monkeypatch, builder_module, tmp_path,
):
    """The detached manifest the builder emits MUST round-trip through
    the backend's Pydantic `Manifest` schema (Section C.2). Any drift
    between the two would surface here at PR-time rather than at
    install-time."""
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689600")
    root = _make_short_root(tmp_path)
    stage = tmp_path / "stage"
    stage.mkdir()
    smoke = (root / "runtime-smoke-imports.txt").read_bytes()
    _stage_synthetic_tree(stage, smoke, runtime_bytes=os.urandom(2048))
    out = tmp_path / "out"
    result = builder_module.run_build(root, source_tree=stage, output_dir=out)

    import json
    from app.services.windows_runtime.manifest import Manifest

    manifest_dict = json.loads(result["manifest_path"].read_text(encoding="utf-8"))
    manifest = Manifest(**manifest_dict)
    assert manifest.runtime_version == "9.9.9"
    assert manifest.zip_size_bytes == result["zip_size"]
    assert manifest.zip_sha256 == result["zip_sha256_upper"]
    assert manifest.entrypoint == "app\\run_agent.py"
    # metadata/runtime-smoke-imports.txt MUST appear in inventory.
    assert any(
        f.path == "metadata\\runtime-smoke-imports.txt" for f in manifest.files
    )


# ── Determinism — same epoch → byte-identical outputs ─────────────────────


def _run_build_in_isolated_out(
    builder_module, root, smoke_bytes, runtime_bytes, tmp_path, *, out_name
):
    stage = tmp_path / f"stage-{out_name}"
    stage.mkdir()
    _stage_synthetic_tree(stage, smoke_bytes, runtime_bytes=runtime_bytes)
    out = tmp_path / out_name
    return builder_module.run_build(root, source_tree=stage, output_dir=out)


def test_build_byte_identical_under_same_epoch(
    monkeypatch, builder_module, tmp_path,
):
    """Two clean builds with the SAME `SOURCE_DATE_EPOCH` and identical
    source bytes MUST produce byte-identical ZIP + manifest + sidecar.
    Correction #7 reproducibility contract."""
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689600")
    root = _make_short_root(tmp_path)
    smoke = (root / "runtime-smoke-imports.txt").read_bytes()
    # Use a fixed seed so the synthetic python.exe bytes are identical
    # across the two builds (no os.urandom here).
    runtime = b"\x01\x02\x03" * 1024  # 3 KiB, incompressible enough
    a = _run_build_in_isolated_out(builder_module, root, smoke, runtime, tmp_path, out_name="a")
    b = _run_build_in_isolated_out(builder_module, root, smoke, runtime, tmp_path, out_name="b")

    assert a["zip_path"].read_bytes() == b["zip_path"].read_bytes(), \
        "ZIPs differ under same SOURCE_DATE_EPOCH"
    assert a["sha_path"].read_bytes() == b["sha_path"].read_bytes()
    assert a["manifest_path"].read_bytes() == b["manifest_path"].read_bytes()
    assert a["zip_sha256_lower"] == b["zip_sha256_lower"]


# ── DOS-bucket boundary semantics (#39) ───────────────────────────────────


def test_build_same_dos_bucket_zip_equal_manifest_differs(
    monkeypatch, builder_module, tmp_path,
):
    """Two epochs in the same DOS 2-second bucket → ZIP byte-equal AND
    .sha256 byte-equal, manifest `built_utc` differs."""
    root = _make_short_root(tmp_path)
    smoke = (root / "runtime-smoke-imports.txt").read_bytes()
    runtime = b"\xAA\xBB\xCC" * 1024
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689600")  # even second
    a = _run_build_in_isolated_out(builder_module, root, smoke, runtime, tmp_path, out_name="a")
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689601")  # same bucket
    b = _run_build_in_isolated_out(builder_module, root, smoke, runtime, tmp_path, out_name="b")

    assert a["zip_path"].read_bytes() == b["zip_path"].read_bytes()
    assert a["sha_path"].read_bytes() == b["sha_path"].read_bytes()
    # Manifest's built_utc reflects the original epoch → differs.
    assert a["manifest_path"].read_bytes() != b["manifest_path"].read_bytes()
    import json
    ma = json.loads(a["manifest_path"].read_text(encoding="utf-8"))
    mb = json.loads(b["manifest_path"].read_text(encoding="utf-8"))
    assert ma["built_utc"] == "2025-01-01T00:00:00Z"
    assert mb["built_utc"] == "2025-01-01T00:00:01Z"


def test_build_different_dos_bucket_all_three_differ(
    monkeypatch, builder_module, tmp_path,
):
    """Two epochs in DIFFERENT DOS 2-second buckets → ZIP differs,
    .sha256 differs, manifest differs."""
    root = _make_short_root(tmp_path)
    smoke = (root / "runtime-smoke-imports.txt").read_bytes()
    runtime = b"\xDE\xAD\xBE\xEF" * 1024
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689600")  # bucket 1735689600
    a = _run_build_in_isolated_out(builder_module, root, smoke, runtime, tmp_path, out_name="a")
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689602")  # bucket 1735689602
    b = _run_build_in_isolated_out(builder_module, root, smoke, runtime, tmp_path, out_name="b")

    assert a["zip_path"].read_bytes() != b["zip_path"].read_bytes()
    assert a["sha_path"].read_bytes() != b["sha_path"].read_bytes()
    assert a["manifest_path"].read_bytes() != b["manifest_path"].read_bytes()


# ── Fail-closed structural checks ─────────────────────────────────────────


def test_build_missing_source_tree_rejected(
    monkeypatch, builder_module, tmp_path,
):
    """A non-existent source tree fails fast at the top-level subtree
    presence check (whose error names the missing subtrees verbatim
    so the operator can see exactly what's missing)."""
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689600")
    root = _make_short_root(tmp_path)
    with pytest.raises(builder_module.BuilderError) as exc:
        builder_module.run_build(
            root,
            source_tree=tmp_path / "does-not-exist",
            output_dir=tmp_path / "out",
        )
    msg = str(exc.value)
    assert "subtree" in msg or "is not a directory" in msg


@pytest.mark.parametrize("drop_root", ["runtime", "app", "licenses", "metadata"])
def test_build_missing_top_level_subtree_rejected(
    monkeypatch, builder_module, tmp_path, drop_root,
):
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689600")
    root = _make_short_root(tmp_path)
    stage = tmp_path / "stage"
    stage.mkdir()
    smoke = (root / "runtime-smoke-imports.txt").read_bytes()
    _stage_synthetic_tree(stage, smoke, runtime_bytes=os.urandom(2048))
    import shutil
    shutil.rmtree(stage / drop_root)
    with pytest.raises(builder_module.BuilderError) as exc:
        builder_module.run_build(root, source_tree=stage, output_dir=tmp_path / "out")
    assert "required top-level subtree" in str(exc.value)


def test_build_in_tree_smoke_list_must_match_ops(
    monkeypatch, builder_module, tmp_path,
):
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689600")
    root = _make_short_root(tmp_path)
    stage = tmp_path / "stage"
    stage.mkdir()
    smoke = (root / "runtime-smoke-imports.txt").read_bytes()
    _stage_synthetic_tree(stage, smoke, runtime_bytes=os.urandom(2048))
    # Mutate the in-tree mirror.
    (stage / "metadata" / "runtime-smoke-imports.txt").write_bytes(
        b"ssl\nsocket\nctypes\nasyncio\n"
    )
    with pytest.raises(builder_module.BuilderError) as exc:
        builder_module.run_build(root, source_tree=stage, output_dir=tmp_path / "out")
    assert "does not match" in str(exc.value)


def test_build_size_below_floor_rejected(
    monkeypatch, builder_module, tmp_path,
):
    """If the built ZIP is below `SIZE_LOWER_BOUND_BYTES`, the build
    fails fast. Using the production-sized bound makes a tiny synthetic
    tree below the floor."""
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689600")
    root = _make_short_root(tmp_path)
    # Crank the floor up to 1 MiB — much larger than our 9-file tree.
    (root / "release-pins.toml").write_text(
        SHORT_PINS_TOML.replace(
            "SIZE_LOWER_BOUND_BYTES = 1024",
            "SIZE_LOWER_BOUND_BYTES = 1048576",
        ),
        encoding="utf-8",
    )
    stage = tmp_path / "stage"
    stage.mkdir()
    smoke = (root / "runtime-smoke-imports.txt").read_bytes()
    _stage_synthetic_tree(stage, smoke, runtime_bytes=b"x" * 64)
    with pytest.raises(builder_module.BuilderError) as exc:
        builder_module.run_build(root, source_tree=stage, output_dir=tmp_path / "out")
    assert "below SIZE_LOWER_BOUND_BYTES" in str(exc.value)


def test_build_size_above_ceiling_rejected(
    monkeypatch, builder_module, tmp_path,
):
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689600")
    root = _make_short_root(tmp_path)
    (root / "release-pins.toml").write_text(
        SHORT_PINS_TOML.replace(
            "SIZE_UPPER_BOUND_BYTES = 209715200",
            "SIZE_UPPER_BOUND_BYTES = 1024",
        ),
        encoding="utf-8",
    )
    stage = tmp_path / "stage"
    stage.mkdir()
    smoke = (root / "runtime-smoke-imports.txt").read_bytes()
    _stage_synthetic_tree(stage, smoke, runtime_bytes=os.urandom(8192))
    with pytest.raises(builder_module.BuilderError) as exc:
        builder_module.run_build(root, source_tree=stage, output_dir=tmp_path / "out")
    assert "above SIZE_UPPER_BOUND_BYTES" in str(exc.value)


def test_build_missing_entrypoint_rejected(
    monkeypatch, builder_module, tmp_path,
):
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689600")
    root = _make_short_root(tmp_path)
    stage = tmp_path / "stage"
    stage.mkdir()
    smoke = (root / "runtime-smoke-imports.txt").read_bytes()
    _stage_synthetic_tree(stage, smoke, runtime_bytes=os.urandom(2048))
    (stage / "app" / "run_agent.py").unlink()
    with pytest.raises(builder_module.BuilderError) as exc:
        builder_module.run_build(root, source_tree=stage, output_dir=tmp_path / "out")
    assert "entrypoint" in str(exc.value) or "missing" in str(exc.value)


def test_build_symlink_in_source_tree_rejected(
    monkeypatch, builder_module, tmp_path,
):
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689600")
    root = _make_short_root(tmp_path)
    stage = tmp_path / "stage"
    stage.mkdir()
    smoke = (root / "runtime-smoke-imports.txt").read_bytes()
    _stage_synthetic_tree(stage, smoke, runtime_bytes=os.urandom(2048))
    # Drop a symlink into the tree.
    target = stage / "app" / "run_agent.py"
    link = stage / "app" / "alias.py"
    try:
        link.symlink_to(target)
    except (OSError, NotImplementedError):
        pytest.skip("filesystem does not support symlinks")
    with pytest.raises(builder_module.BuilderError) as exc:
        builder_module.run_build(root, source_tree=stage, output_dir=tmp_path / "out")
    assert "symlink" in str(exc.value)


# ── CLI ───────────────────────────────────────────────────────────────────


def test_build_cli_requires_source_tree_and_output_dir(
    monkeypatch, capsys, builder_module,
):
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689600")
    rc = builder_module.main(["--build"])
    captured = capsys.readouterr()
    assert rc == 1
    assert "BUILDER_ERROR" in captured.err
    assert "--source-tree" in captured.err and "--output-dir" in captured.err


def test_build_cli_check_and_build_are_mutually_exclusive(builder_module):
    with pytest.raises(SystemExit):
        builder_module.main(["--check", "--build"])


def test_build_summary_prints_build_result_ok(
    monkeypatch, builder_module, tmp_path, capsys,
):
    """`_print_build_summary` ends with the `BUILD_RESULT=OK` sentinel
    that CI workflows grep for to confirm success without parsing the
    structured fields above it."""
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689600")
    root = _make_short_root(tmp_path)
    stage = tmp_path / "stage"
    stage.mkdir()
    smoke = (root / "runtime-smoke-imports.txt").read_bytes()
    _stage_synthetic_tree(stage, smoke, runtime_bytes=os.urandom(2048))
    out = tmp_path / "out"
    result = builder_module.run_build(root, source_tree=stage, output_dir=out)
    builder_module._print_build_summary(result)
    captured = capsys.readouterr()
    assert "BUILD_RESULT=OK" in captured.out
    assert "zip_sha256" in captured.out
    assert "runtime_version" in captured.out


# ── Stable lexical ZIP entry order (correction #7) ────────────────────────


def test_build_zip_entries_are_lexically_sorted_utf8_lower(
    monkeypatch, builder_module, tmp_path,
):
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689600")
    root = _make_short_root(tmp_path)
    stage = tmp_path / "stage"
    stage.mkdir()
    smoke = (root / "runtime-smoke-imports.txt").read_bytes()
    _stage_synthetic_tree(stage, smoke, runtime_bytes=os.urandom(2048))
    out = tmp_path / "out"
    result = builder_module.run_build(root, source_tree=stage, output_dir=out)

    import zipfile
    with zipfile.ZipFile(result["zip_path"]) as zf:
        names = zf.namelist()
    # Names use forward slashes (PKZIP standard) and are sorted by
    # UTF-8 binary lowercase.
    for n in names:
        assert "\\" not in n, f"ZIP entry {n!r} contains backslash"
    sorted_names = sorted(names, key=lambda n: n.encode("utf-8").lower())
    assert names == sorted_names


def test_build_zip_entries_use_normalized_attributes(
    monkeypatch, builder_module, tmp_path,
):
    """Every ZIP entry must carry the deterministic mode (0o644),
    create_system=3 (Unix), create_version=20, extract_version=20."""
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1735689600")
    root = _make_short_root(tmp_path)
    stage = tmp_path / "stage"
    stage.mkdir()
    smoke = (root / "runtime-smoke-imports.txt").read_bytes()
    _stage_synthetic_tree(stage, smoke, runtime_bytes=os.urandom(2048))
    out = tmp_path / "out"
    result = builder_module.run_build(root, source_tree=stage, output_dir=out)

    import zipfile
    with zipfile.ZipFile(result["zip_path"]) as zf:
        for info in zf.infolist():
            assert info.create_system == 3, f"{info.filename}: create_system not Unix"
            assert info.create_version == 20, f"{info.filename}: create_version"
            assert info.extract_version == 20, f"{info.filename}: extract_version"
            assert (info.external_attr >> 16) == 0o644, \
                f"{info.filename}: external_attr {oct(info.external_attr >> 16)}"
            # DOS bucket — even-second alignment.
            assert info.date_time[5] % 2 == 0, \
                f"{info.filename}: odd-second timestamp leaked"
