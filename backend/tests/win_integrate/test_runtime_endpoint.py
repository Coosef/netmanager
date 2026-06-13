"""HTTP-level tests for the runtime bundle endpoints (Section D).

Spins up a minimal FastAPI app that mounts only `agents_public_router`,
overrides the DB + agent auth, and drives the two new routes via
`fastapi.testclient.TestClient`:

  GET /api/v1/agents/{id}/download/runtime/windows-amd64/manifest
  GET /api/v1/agents/{id}/download/runtime/windows-amd64

Exercises:

  - flag off → 404 on both endpoints
  - flag on + missing X-Agent-Key → 401 (both)
  - flag on + invalid key → 404, info-disclosure safe (both)
  - flag on + valid key + happy path
      manifest → 200, bytes verbatim, correct headers
      ZIP      → 200, bytes verbatim, full header set
  - flag on + asset missing / corrupt → 503 (both)
  - flag on + manifest schema invalid → 503 (both)
  - flag on + host integrity unavailable → 503 (both)
  - Range header is ignored, full 200 served
  - agent key never appears in URL / response headers / body
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


RUNTIME_VERSION = "1.0.0"
VALID_HOST_VERSION = "2.0.0-mvp0+gabc123def456"


def _build_bundle(tmp_path: Path):
    """Materialize a complete, valid runtime bundle under `tmp_path`.

    Mirror of the helper in `test_runtime_integrity.py` — kept
    duplicated so neither test file imports private internals from
    the other.
    """
    bin_dir = tmp_path / "agent-bins"
    bin_dir.mkdir(parents=True, exist_ok=True)
    zip_data = b"\x50\x4b\x05\x06" + b"\x00" * (5 * 1024 * 1024 + 1020)
    zip_path = bin_dir / f"charon-runtime-windows-amd64-{RUNTIME_VERSION}.zip"
    zip_path.write_bytes(zip_data)
    zip_sha_lower = hashlib.sha256(zip_data).hexdigest()
    zip_sha_upper = zip_sha_lower.upper()

    sha_path = bin_dir / f"charon-runtime-windows-amd64-{RUNTIME_VERSION}.zip.sha256"
    sha_path.write_text(zip_sha_lower + "\n")

    manifest_dict = {
        "schema_version": 1,
        "runtime_version": RUNTIME_VERSION,
        "python_version": "3.12.6",
        "platform": "windows-amd64",
        "built_utc": "2026-06-12T00:00:00Z",
        "embedded_python_source_sha256": "A" * 64,
        "zip_size_bytes": len(zip_data),
        "zip_sha256": zip_sha_upper,
        "compatible_host_core_range": ">=2.0.0 <3.0.0",
        "entrypoint": "app\\run_agent.py",
        "files": [
            {"path": "app\\run_agent.py", "size": 100, "sha256": "B" * 64},
            {"path": "metadata\\runtime-smoke-imports.txt", "size": 103, "sha256": "C" * 64},
        ],
    }
    manifest_bytes = (
        json.dumps(manifest_dict, sort_keys=True, indent=2).encode("utf-8")
        + b"\n"
    )
    manifest_path = bin_dir / f"charon-runtime-windows-amd64-{RUNTIME_VERSION}.manifest.json"
    manifest_path.write_bytes(manifest_bytes)

    current_path = bin_dir / "charon-runtime-windows-amd64.current"
    current_path.write_text(RUNTIME_VERSION + "\n")

    return {
        "bin_dir": bin_dir,
        "zip_path": zip_path,
        "sha_path": sha_path,
        "manifest_path": manifest_path,
        "current_path": current_path,
        "zip_sha_upper": zip_sha_upper,
        "zip_data": zip_data,
        "manifest_dict": manifest_dict,
        "manifest_bytes": manifest_bytes,
    }


def _rewrite_manifest(fx, mutate):
    d = dict(fx["manifest_dict"])
    mutate(d)
    fx["manifest_path"].write_bytes(
        json.dumps(d, sort_keys=True, indent=2).encode("utf-8") + b"\n"
    )
    fx["manifest_dict"] = d


@pytest.fixture
def app_with_overrides(tmp_path, monkeypatch):
    """Minimal FastAPI app + DB / auth / host-integrity / runtime-paths overrides."""
    from app.api.v1.endpoints import agents as agents_mod
    from app.api.v1.endpoints.agents import agents_public_router
    from app.services.windows_runtime import integrity as integrity_mod

    # ── runtime bundle on disk ────────────────────────────────────
    fx = _build_bundle(tmp_path)
    monkeypatch.setattr(integrity_mod, "RUNTIME_BIN_DIR", str(fx["bin_dir"]))
    monkeypatch.setattr(integrity_mod, "RUNTIME_CURRENT_PATH", str(fx["current_path"]))
    monkeypatch.setattr(integrity_mod, "_RUNTIME_INTEGRITY_CACHE", None)

    # ── host integrity stub (returns ok + a baked version) ────────
    class _StubHostIntegrity:
        ok = True
        version = VALID_HOST_VERSION
        sha256 = "DE" * 32
        size = 2 * 1024 * 1024
        error = None
    monkeypatch.setattr(agents_mod, "_host_integrity", lambda: _StubHostIntegrity())

    # ── feature flag default OFF — each test opts in ─────────────
    from app.core.config import settings
    monkeypatch.setattr(settings, "WINDOWS_AGENT_V2_ENABLED", False)

    # ── fake agent + key contract ─────────────────────────────────
    FAKE_AGENT_ID = "agent-known-good"
    FAKE_AGENT_KEY = "k3yk3yk3yk3yk3yk3y"  # NOTE: never logged or echoed

    class _FakeAgent:
        id = FAKE_AGENT_ID
        is_active = True
        agent_key_hash = "stub-hash"

    class _StubExecute:
        def __init__(self, value):
            self._v = value

        def scalar_one_or_none(self):
            return self._v

    class _FakeDB:
        async def execute(self, stmt):
            text = str(stmt)
            if "set_config" in text:
                return _StubExecute(None)
            return _StubExecute(_FakeAgent())

    async def _fake_get_db():
        yield _FakeDB()

    monkeypatch.setattr(
        agents_mod, "verify_password",
        lambda plain, _hashed: plain == FAKE_AGENT_KEY,
    )

    app = FastAPI()
    app.include_router(agents_public_router, prefix="/api/v1/agents")
    app.dependency_overrides[agents_mod.get_db] = _fake_get_db

    return {
        "app": app,
        "client": TestClient(app),
        "agent_id": FAKE_AGENT_ID,
        "agent_key": FAKE_AGENT_KEY,
        "settings": settings,
        "agents_mod": agents_mod,
        "integrity_mod": integrity_mod,
        "fx": fx,
    }


def _manifest_url(f):
    return f"/api/v1/agents/{f['agent_id']}/download/runtime/windows-amd64/manifest"


def _zip_url(f):
    return f"/api/v1/agents/{f['agent_id']}/download/runtime/windows-amd64"


def _reset_runtime_cache(f):
    f["integrity_mod"]._RUNTIME_INTEGRITY_CACHE = None


# ── Flag-off ───────────────────────────────────────────────────────


def test_flag_off_manifest_returns_404(app_with_overrides):
    f = app_with_overrides
    res = f["client"].get(
        _manifest_url(f),
        headers={"X-Agent-Key": f["agent_key"]},
    )
    assert res.status_code == 404
    assert res.json()["detail"] == "Endpoint not available"


def test_flag_off_zip_returns_404(app_with_overrides):
    f = app_with_overrides
    res = f["client"].get(
        _zip_url(f),
        headers={"X-Agent-Key": f["agent_key"]},
    )
    assert res.status_code == 404
    assert res.json()["detail"] == "Endpoint not available"


# ── Auth contract ──────────────────────────────────────────────────


def test_missing_key_manifest_returns_401(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    res = f["client"].get(_manifest_url(f))
    assert res.status_code == 401


def test_missing_key_zip_returns_401(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    res = f["client"].get(_zip_url(f))
    assert res.status_code == 401


def test_invalid_key_manifest_returns_404(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    res = f["client"].get(
        _manifest_url(f),
        headers={"X-Agent-Key": "WRONG-KEY"},
    )
    assert res.status_code == 404
    assert res.json()["detail"] == "Agent not found"


def test_invalid_key_zip_returns_404(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    res = f["client"].get(
        _zip_url(f),
        headers={"X-Agent-Key": "WRONG-KEY"},
    )
    assert res.status_code == 404
    assert res.json()["detail"] == "Agent not found"


# ── Happy path ─────────────────────────────────────────────────────


def test_manifest_happy_path_byte_perfect(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    res = f["client"].get(
        _manifest_url(f),
        headers={"X-Agent-Key": f["agent_key"]},
    )
    assert res.status_code == 200
    assert res.content == f["fx"]["manifest_bytes"]
    assert res.headers["content-type"] == "application/json"
    assert res.headers["content-length"] == str(len(f["fx"]["manifest_bytes"]))
    assert res.headers["cache-control"] == \
        "no-store, no-cache, must-revalidate, max-age=0"
    assert res.headers["pragma"] == "no-cache"
    assert res.headers["x-content-type-options"] == "nosniff"


def test_zip_happy_path_byte_perfect_and_full_headers(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    res = f["client"].get(
        _zip_url(f),
        headers={"X-Agent-Key": f["agent_key"]},
    )
    assert res.status_code == 200
    assert res.content == f["fx"]["zip_data"]
    # Required header set (Section D)
    assert res.headers["content-type"] == "application/zip"
    assert res.headers["content-length"] == str(len(f["fx"]["zip_data"]))
    assert res.headers["content-disposition"] == \
        f'attachment; filename="charon-runtime-windows-amd64-{RUNTIME_VERSION}.zip"'
    assert res.headers["cache-control"] == \
        "no-store, no-cache, must-revalidate, max-age=0"
    assert res.headers["pragma"] == "no-cache"
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["x-charon-runtime-version"] == RUNTIME_VERSION
    assert res.headers["x-charon-runtime-zip-sha256"] == f["fx"]["zip_sha_upper"]
    assert res.headers["x-charon-python-version"] == "3.12.6"
    assert res.headers["x-charon-compatible-host-core-range"] == ">=2.0.0 <3.0.0"


def test_zip_sha256_header_is_upper_case(app_with_overrides, monkeypatch):
    """Section D spec is `X-Charon-Runtime-Zip-Sha256: <HEX-UPPER>`."""
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    res = f["client"].get(
        _zip_url(f),
        headers={"X-Agent-Key": f["agent_key"]},
    )
    assert res.status_code == 200
    sha = res.headers["x-charon-runtime-zip-sha256"]
    assert sha == sha.upper()
    assert sha == hashlib.sha256(f["fx"]["zip_data"]).hexdigest().upper()


# ── Integrity failure → 503 (both endpoints) ───────────────────────


def test_zip_missing_returns_503(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    f["fx"]["zip_path"].unlink()
    _reset_runtime_cache(f)
    res = f["client"].get(_zip_url(f), headers={"X-Agent-Key": f["agent_key"]})
    assert res.status_code == 503
    assert res.json()["detail"] == "Runtime bundle not available"


def test_manifest_missing_returns_503(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    f["fx"]["manifest_path"].unlink()
    _reset_runtime_cache(f)
    res = f["client"].get(_manifest_url(f), headers={"X-Agent-Key": f["agent_key"]})
    assert res.status_code == 503
    assert res.json()["detail"] == "Runtime bundle not available"


def test_current_sidecar_missing_returns_503(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    f["fx"]["current_path"].unlink()
    _reset_runtime_cache(f)
    res = f["client"].get(_manifest_url(f), headers={"X-Agent-Key": f["agent_key"]})
    assert res.status_code == 503


def test_sha_sidecar_missing_returns_503(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    f["fx"]["sha_path"].unlink()
    _reset_runtime_cache(f)
    res = f["client"].get(_zip_url(f), headers={"X-Agent-Key": f["agent_key"]})
    assert res.status_code == 503


def test_sha_mismatch_returns_503(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    f["fx"]["sha_path"].write_text("0" * 64)
    _reset_runtime_cache(f)
    res = f["client"].get(_zip_url(f), headers={"X-Agent-Key": f["agent_key"]})
    assert res.status_code == 503


def test_manifest_schema_invalid_returns_503(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    _rewrite_manifest(f["fx"], lambda d: d.pop("entrypoint"))
    _reset_runtime_cache(f)
    res = f["client"].get(_manifest_url(f), headers={"X-Agent-Key": f["agent_key"]})
    assert res.status_code == 503


def test_size_out_of_range_returns_503(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    f["fx"]["zip_path"].write_bytes(b"x")  # 1 byte < 5 MiB
    _reset_runtime_cache(f)
    res = f["client"].get(_zip_url(f), headers={"X-Agent-Key": f["agent_key"]})
    assert res.status_code == 503


def test_host_integrity_unavailable_returns_503(app_with_overrides, monkeypatch):
    """When the baked host binary integrity check has failed, the
    runtime endpoint also 503s (we cannot verify the
    compatible_host_core_range without a baked host version)."""
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)

    class _BadHost:
        ok = False
        version = None
        sha256 = None
        size = None
        error = "stubbed"
    monkeypatch.setattr(f["agents_mod"], "_host_integrity", lambda: _BadHost())
    _reset_runtime_cache(f)
    res = f["client"].get(_zip_url(f), headers={"X-Agent-Key": f["agent_key"]})
    assert res.status_code == 503

    _reset_runtime_cache(f)
    res = f["client"].get(_manifest_url(f), headers={"X-Agent-Key": f["agent_key"]})
    assert res.status_code == 503


def test_baked_host_outside_compat_range_returns_503(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)

    class _OldHost:
        ok = True
        version = "1.99.99-mvp0+gabc123def456"
        sha256 = "AB" * 32
        size = 2 * 1024 * 1024
        error = None
    monkeypatch.setattr(f["agents_mod"], "_host_integrity", lambda: _OldHost())
    _reset_runtime_cache(f)
    res = f["client"].get(_manifest_url(f), headers={"X-Agent-Key": f["agent_key"]})
    assert res.status_code == 503


# ── Range header ignored ───────────────────────────────────────────


def test_range_header_ignored(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    res = f["client"].get(
        _zip_url(f),
        headers={
            "X-Agent-Key": f["agent_key"],
            "Range": "bytes=0-99",
        },
    )
    assert res.status_code == 200
    assert len(res.content) == len(f["fx"]["zip_data"])


# ── Agent key never in URL / headers / body ────────────────────────


def test_agent_key_not_in_zip_response_artifacts(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    res = f["client"].get(_zip_url(f), headers={"X-Agent-Key": f["agent_key"]})
    assert res.status_code == 200
    for name, value in res.headers.items():
        assert f["agent_key"] not in value, \
            f"agent key leaked into response header {name}"
    assert f["agent_key"].encode() not in res.content


def test_agent_key_not_in_manifest_response_artifacts(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    res = f["client"].get(_manifest_url(f), headers={"X-Agent-Key": f["agent_key"]})
    assert res.status_code == 200
    for name, value in res.headers.items():
        assert f["agent_key"] not in value
    assert f["agent_key"].encode() not in res.content


# ── Source-level guards ────────────────────────────────────────────


def test_endpoints_gate_on_feature_flag():
    """Both new endpoint bodies must short-circuit when the flag is off.

    The gate is factored into the shared `_authenticate_runtime_agent()`
    helper; we assert (a) both routes call the helper, and (b) the
    helper raises 404 on the flag check.
    """
    from app.api.v1.endpoints import agents as agents_mod
    import os
    src_path = os.path.join(os.path.dirname(agents_mod.__file__), "agents.py")
    with open(src_path) as f:
        src = f.read()
    for route in (
        '@agents_public_router.get("/{agent_id}/download/runtime/windows-amd64/manifest")',
        '@agents_public_router.get("/{agent_id}/download/runtime/windows-amd64")',
    ):
        idx = src.find(route)
        assert idx > 0, f"route decorator missing: {route}"
        next_dec = src.find("@agents_public_router", idx + len(route))
        body = src[idx:next_dec if next_dec > 0 else idx + 6000]
        assert "_authenticate_runtime_agent(" in body, \
            f"{route} must delegate to _authenticate_runtime_agent()"

    helper_idx = src.find("async def _authenticate_runtime_agent(")
    assert helper_idx > 0, "_authenticate_runtime_agent helper missing"
    helper_body = src[helper_idx:helper_idx + 2000]
    assert "settings.WINDOWS_AGENT_V2_ENABLED" in helper_body
    assert "status_code=404" in helper_body
    assert 'detail="Endpoint not available"' in helper_body


def test_runtime_endpoints_do_not_log_agent_key():
    """Source-level guard: neither endpoint may pass the agent key
    to any log call (parity with the host endpoint guard)."""
    from app.api.v1.endpoints import agents as agents_mod
    import os, re as _re
    src_path = os.path.join(os.path.dirname(agents_mod.__file__), "agents.py")
    with open(src_path) as f:
        src = f.read()
    for route in (
        '@agents_public_router.get("/{agent_id}/download/runtime/windows-amd64/manifest")',
        '@agents_public_router.get("/{agent_id}/download/runtime/windows-amd64")',
    ):
        idx = src.find(route)
        next_dec = src.find("@agents_public_router", idx + len(route))
        body = src[idx:next_dec if next_dec > 0 else idx + 6000]
        log_calls = _re.findall(
            r"log\.(?:info|warn|warning|error|exception|critical)\([^)]*\)", body
        )
        for call in log_calls:
            for forbidden in ("x_agent_key", "X-Agent-Key", "agent_key"):
                assert forbidden not in call, \
                    f"agent key leaked into log call in {route}: {call!r}"
