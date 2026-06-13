"""Unit tests for `app.services.windows_runtime.integrity`.

Exercises the memoized runtime-bundle integrity check directly (no
FastAPI / no HTTP). The endpoint-level HTTP tests live in
`test_runtime_endpoint.py`.

Covered paths:
  - happy: `.current` + sized ZIP + matching SHA sidecar + valid
    manifest + baked host in compat range → `ok=True`
  - `.current` sidecar missing / multi-line / malformed → 503
  - versioned ZIP missing → 503
  - ZIP size out of range (low / high) → 503
  - SHA sidecar missing / format invalid / mismatch → 503
  - manifest missing / not UTF-8 JSON / schema invalid → 503
  - manifest.zip_size_bytes mismatch vs disk → 503
  - manifest.zip_sha256 mismatch vs disk → 503
  - manifest.runtime_version != `.current` → 503
  - baked host version None / outside compat range / malformed → 503
  - memoization: second call returns the cached instance
  - reset clears the cache
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest


# Lazy module imports — same conftest reason as the existing
# WIN-INTEGRATE tests (avoid eager engine construction).
def _integrity_mod():
    from app.services.windows_runtime import integrity
    return integrity


VALID_HOST_VERSION = "2.0.0-mvp0+gabc123def456"
RUNTIME_VERSION = "1.0.0"


def _build_bundle(
    tmp_path: Path,
    *,
    runtime_version: str = RUNTIME_VERSION,
    zip_size: int = 5 * 1024 * 1024 + 1024,   # just over 5 MiB
):
    """Materialise a complete, valid runtime bundle under `tmp_path`."""
    bin_dir = tmp_path / "agent-bins"
    bin_dir.mkdir(parents=True, exist_ok=True)

    zip_data = b"\x50\x4b\x05\x06" + b"\x00" * (zip_size - 4)  # EOCD-ish prefix
    zip_path = bin_dir / f"charon-runtime-windows-amd64-{runtime_version}.zip"
    zip_path.write_bytes(zip_data)
    zip_sha_lower = hashlib.sha256(zip_data).hexdigest()
    zip_sha_upper = zip_sha_lower.upper()

    sha_path = bin_dir / f"charon-runtime-windows-amd64-{runtime_version}.zip.sha256"
    sha_path.write_text(zip_sha_lower + "\n")

    manifest_dict = {
        "schema_version": 1,
        "runtime_version": runtime_version,
        "python_version": "3.12.6",
        "platform": "windows-amd64",
        "built_utc": "2026-06-12T00:00:00Z",
        "embedded_python_source_sha256": "A" * 64,
        "zip_size_bytes": len(zip_data),
        "zip_sha256": zip_sha_upper,
        "compatible_host_core_range": ">=2.0.0 <3.0.0",
        "entrypoint": "app\\run_agent.py",
        "files": [
            {
                "path": "app\\run_agent.py",
                "size": 100,
                "sha256": "B" * 64,
            },
            {
                "path": "metadata\\runtime-smoke-imports.txt",
                "size": 103,
                "sha256": "C" * 64,
            },
        ],
    }
    manifest_bytes = (
        json.dumps(manifest_dict, sort_keys=True, indent=2).encode("utf-8")
        + b"\n"
    )
    manifest_path = bin_dir / f"charon-runtime-windows-amd64-{runtime_version}.manifest.json"
    manifest_path.write_bytes(manifest_bytes)

    current_path = bin_dir / "charon-runtime-windows-amd64.current"
    current_path.write_text(runtime_version + "\n")

    return {
        "bin_dir": bin_dir,
        "zip_path": zip_path,
        "sha_path": sha_path,
        "manifest_path": manifest_path,
        "current_path": current_path,
        "zip_sha_lower": zip_sha_lower,
        "zip_sha_upper": zip_sha_upper,
        "zip_size": len(zip_data),
        "manifest_dict": manifest_dict,
        "manifest_bytes": manifest_bytes,
        "runtime_version": runtime_version,
    }


@pytest.fixture
def bundle(tmp_path, monkeypatch):
    """A valid bundle on disk + module path constants pointed at it."""
    fx = _build_bundle(tmp_path)
    mod = _integrity_mod()
    monkeypatch.setattr(mod, "RUNTIME_BIN_DIR", str(fx["bin_dir"]))
    monkeypatch.setattr(mod, "RUNTIME_CURRENT_PATH", str(fx["current_path"]))
    monkeypatch.setattr(mod, "_RUNTIME_INTEGRITY_CACHE", None)
    return fx


def _rewrite_manifest(fx, mutate):
    """Apply `mutate(dict)` to the manifest dict and persist the result."""
    d = dict(fx["manifest_dict"])
    mutate(d)
    fx["manifest_path"].write_bytes(
        json.dumps(d, sort_keys=True, indent=2).encode("utf-8") + b"\n"
    )
    fx["manifest_dict"] = d


# ── Happy path ────────────────────────────────────────────────────────────


def test_happy_path_ok(bundle):
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is True, r.error
    assert r.error is None
    assert r.version == RUNTIME_VERSION
    assert r.zip_size == bundle["zip_size"]
    assert r.zip_sha256 == bundle["zip_sha_upper"]
    assert r.manifest is not None
    assert r.manifest.runtime_version == RUNTIME_VERSION
    assert r.manifest_bytes == bundle["manifest_bytes"]
    assert r.zip_path == str(bundle["zip_path"])
    assert r.manifest_path == str(bundle["manifest_path"])


def test_manifest_bytes_are_verbatim(bundle):
    """The bytes the endpoint returns MUST be the on-disk bytes
    verbatim, not a re-serialization of the parsed dict."""
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.manifest_bytes == bundle["manifest_path"].read_bytes()


# ── `.current` sidecar ────────────────────────────────────────────────────


def test_current_sidecar_missing(bundle):
    bundle["current_path"].unlink()
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False
    assert ".current" in r.error and "missing" in r.error


def test_current_sidecar_multi_line(bundle):
    bundle["current_path"].write_text("1.0.0\n2.0.0\n")
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False
    assert "single line" in r.error


@pytest.mark.parametrize("bad", [
    "",
    "dev",
    "v1.0.0",
    "1.0",
    "1.0.0-rc1",
    "1.0.0.0",
    "  1.0.0",
])
def test_current_sidecar_malformed(bundle, bad):
    bundle["current_path"].write_text(bad + "\n")
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False, f"sidecar value {bad!r} should reject"
    assert "malformed" in r.error or "single line" in r.error or "missing" in r.error


# ── Versioned ZIP file ────────────────────────────────────────────────────


def test_zip_missing(bundle):
    bundle["zip_path"].unlink()
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False
    assert "zip" in r.error.lower() and "missing" in r.error


def test_zip_size_too_small(tmp_path, monkeypatch):
    fx = _build_bundle(tmp_path, zip_size=4 * 1024 * 1024)  # 4 MiB < 5 MiB
    # Manifest's zip_size + sha now drift, but the size check fires
    # FIRST (before SHA / manifest comparison).
    mod = _integrity_mod()
    monkeypatch.setattr(mod, "RUNTIME_BIN_DIR", str(fx["bin_dir"]))
    monkeypatch.setattr(mod, "RUNTIME_CURRENT_PATH", str(fx["current_path"]))
    monkeypatch.setattr(mod, "_RUNTIME_INTEGRITY_CACHE", None)
    r = mod._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False
    assert "size" in r.error and "out of sanity range" in r.error


def test_zip_size_too_large(tmp_path, monkeypatch):
    # 201 MiB sparse file (200 MiB ceiling)
    fx = _build_bundle(tmp_path)
    big_path = fx["zip_path"]
    with big_path.open("wb") as f:
        f.seek(201 * 1024 * 1024 - 1)
        f.write(b"\x00")
    mod = _integrity_mod()
    monkeypatch.setattr(mod, "RUNTIME_BIN_DIR", str(fx["bin_dir"]))
    monkeypatch.setattr(mod, "RUNTIME_CURRENT_PATH", str(fx["current_path"]))
    monkeypatch.setattr(mod, "_RUNTIME_INTEGRITY_CACHE", None)
    r = mod._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False
    assert "size" in r.error


# ── `.sha256` sidecar ─────────────────────────────────────────────────────


def test_sha_sidecar_missing(bundle):
    bundle["sha_path"].unlink()
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False
    assert "sha sidecar" in r.error and "missing" in r.error


@pytest.mark.parametrize("bad", [
    "",
    "not-a-sha",
    "deadbeef",                                     # too short
    "g" * 64,                                       # non-hex char
    "0" * 63,                                       # 63 chars
    "0" * 65,                                       # 65 chars
])
def test_sha_sidecar_format_invalid(bundle, bad):
    bundle["sha_path"].write_text(bad)
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False
    assert "format invalid" in r.error or "missing" in r.error


def test_sha_sidecar_mismatch(bundle):
    bundle["sha_path"].write_text("0" * 64)
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False
    assert "mismatch" in r.error


def test_sha_sidecar_uppercase_accepted(bundle):
    bundle["sha_path"].write_text(bundle["zip_sha_upper"])
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is True, r.error


# ── Manifest JSON ────────────────────────────────────────────────────────


def test_manifest_missing(bundle):
    bundle["manifest_path"].unlink()
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False
    assert "manifest" in r.error and "missing" in r.error


def test_manifest_not_utf8_json(bundle):
    bundle["manifest_path"].write_bytes(b"\xff\xfe not json at all")
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False
    assert "not valid" in r.error or "schema" in r.error


def test_manifest_schema_missing_required_field(bundle):
    _rewrite_manifest(bundle, lambda d: d.pop("entrypoint"))
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False
    assert "schema" in r.error


def test_manifest_schema_extra_field_rejected(bundle):
    _rewrite_manifest(bundle, lambda d: d.update({"extra_field": "boom"}))
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False
    assert "schema" in r.error


def test_manifest_schema_missing_smoke_list_entry(bundle):
    def mutate(d):
        d["files"] = [
            f for f in d["files"]
            if f["path"] != "metadata\\runtime-smoke-imports.txt"
        ]
    _rewrite_manifest(bundle, mutate)
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False
    assert "schema" in r.error


def test_manifest_schema_entrypoint_not_in_files(bundle):
    def mutate(d):
        d["entrypoint"] = "app\\not_in_files.py"
    _rewrite_manifest(bundle, mutate)
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False
    assert "schema" in r.error


# ── Manifest cross-checks vs disk ─────────────────────────────────────────


def test_manifest_zip_size_mismatch(bundle):
    _rewrite_manifest(bundle, lambda d: d.update({"zip_size_bytes": 42}))
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False
    assert "zip_size_bytes" in r.error


def test_manifest_zip_sha_mismatch(bundle):
    _rewrite_manifest(bundle, lambda d: d.update({"zip_sha256": "F" * 64}))
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False
    assert "zip_sha256" in r.error


def test_manifest_runtime_version_mismatch(bundle):
    _rewrite_manifest(bundle, lambda d: d.update({"runtime_version": "9.9.9"}))
    r = _integrity_mod()._read_runtime_integrity(VALID_HOST_VERSION)
    assert r.ok is False
    assert "runtime_version" in r.error


# ── Baked host version cross-check ────────────────────────────────────────


def test_baked_host_version_none_rejects(bundle):
    """Failing the host integrity check upstream must cascade into a
    runtime integrity failure — we cannot verify the compat range
    without a baked host version."""
    r = _integrity_mod()._read_runtime_integrity(None)
    assert r.ok is False
    assert "baked host version" in r.error and "unavailable" in r.error


def test_baked_host_below_compat_range(bundle):
    """Manifest range is `>=2.0.0 <3.0.0`; a 1.x host is below."""
    r = _integrity_mod()._read_runtime_integrity("1.99.99-mvp0+gabc123def456")
    assert r.ok is False
    assert "does not satisfy" in r.error


def test_baked_host_above_compat_range(bundle):
    r = _integrity_mod()._read_runtime_integrity("3.0.0-mvp0+gabc123def456")
    assert r.ok is False
    assert "does not satisfy" in r.error


def test_baked_host_version_malformed(bundle):
    r = _integrity_mod()._read_runtime_integrity("not-a-version")
    assert r.ok is False
    assert "parse failed" in r.error or "does not match" in r.error


# ── Memoization contract ──────────────────────────────────────────────────


def test_memoization_returns_cached(bundle):
    mod = _integrity_mod()
    a = mod.runtime_integrity(VALID_HOST_VERSION)
    b = mod.runtime_integrity(VALID_HOST_VERSION)
    assert a is b


def test_memoization_caches_failure(bundle):
    """A failure caches just like a success — a failed integrity check
    is a permanent 'unavailable' until process restart."""
    bundle["zip_path"].unlink()
    mod = _integrity_mod()
    a = mod.runtime_integrity(VALID_HOST_VERSION)
    assert a.ok is False
    # Re-create the ZIP — should still see the cached failure.
    bundle["zip_path"].write_bytes(b"x" * bundle["zip_size"])
    b = mod.runtime_integrity(VALID_HOST_VERSION)
    assert b is a
    assert b.ok is False


def test_reset_clears_cache(bundle):
    mod = _integrity_mod()
    a = mod.runtime_integrity(VALID_HOST_VERSION)
    mod.reset_runtime_integrity_cache()
    b = mod.runtime_integrity(VALID_HOST_VERSION)
    assert a is not b
    assert a.ok is True and b.ok is True


# ── Constants sanity ─────────────────────────────────────────────────────


def test_size_bounds_match_release_pins():
    """The integrity module's size bounds MUST match
    `release-pins.toml`'s SIZE_LOWER_BOUND_BYTES / SIZE_UPPER_BOUND_BYTES.
    Drift between them would let a builder produce a bundle the
    backend refuses."""
    from app.services.windows_runtime import integrity
    assert integrity.SIZE_LOWER_BOUND_BYTES == 5 * 1024 * 1024
    assert integrity.SIZE_UPPER_BOUND_BYTES == 200 * 1024 * 1024
