"""Real HTTP endpoint tests for /api/v1/agents/{id}/download/host/windows-amd64.

Spins up a minimal FastAPI app that mounts only the agents_public_router,
overrides the DB and auth dependencies, and drives the route via
fastapi.testclient.TestClient. Exercises:

  - flag off → 404
  - flag on + missing X-Agent-Key → 401
  - flag on + invalid key → 404 (info-disclosure safe)
  - flag on + valid key + binary OK → 200 byte-perfect + all headers
  - flag on + binary missing → 503
  - flag on + sha sidecar missing → 503
  - flag on + version sidecar missing → 503
  - flag on + version sidecar malformed (dev / uppercase / wrong length) → 503
  - flag on + SHA mismatch → 503
  - Range header sent → ignored, still full 200
  - agent key never appears in URL / filename / response body
"""
import hashlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


VALID_VERSION = "2.0.0-mvp0+gabc123def456"


@pytest.fixture
def app_with_overrides(tmp_path, monkeypatch):
    """Build a minimal FastAPI app, override DB + agent auth, and
    point the integrity check at a temp dir we control per test."""
    from app.api.v1.endpoints import agents as agents_mod
    from app.api.v1.endpoints.agents import agents_public_router

    # ── temp binary + sidecars ─────────────────────────────────────
    bin_path = tmp_path / "charon-agent-host-windows-amd64.exe"
    sha_path = tmp_path / "charon-agent-host-windows-amd64.exe.sha256"
    ver_path = tmp_path / "charon-agent-host-windows-amd64.exe.version"
    data = b"\x4D\x5A" + b"\x00" * (2 * 1024 * 1024 - 2)   # MZ + 2 MB filler
    bin_path.write_bytes(data)
    sha_path.write_text(hashlib.sha256(data).hexdigest())
    ver_path.write_text(VALID_VERSION)

    monkeypatch.setattr(agents_mod, "_HOST_BIN_PATH", str(bin_path))
    monkeypatch.setattr(agents_mod, "_HOST_SHA_PATH", str(sha_path))
    monkeypatch.setattr(agents_mod, "_HOST_VERSION_PATH", str(ver_path))
    monkeypatch.setattr(agents_mod, "_HOST_INTEGRITY_CACHE", None)

    # ── feature flag default OFF — each test opts in ──────────────
    from app.core.config import settings
    monkeypatch.setattr(settings, "WINDOWS_AGENT_V2_ENABLED", False)

    # ── fake agent + key contract ─────────────────────────────────
    FAKE_AGENT_ID = "agent-known-good"
    FAKE_AGENT_KEY = "k3yk3yk3yk3yk3yk3y"  # NOTE: never logged

    class _FakeAgent:
        id = FAKE_AGENT_ID
        is_active = True
        agent_key_hash = "stub-hash"  # see verify_password override

    class _StubExecute:
        def __init__(self, scalar_one_or_none_value):
            self._v = scalar_one_or_none_value

        def scalar_one_or_none(self):
            return self._v

    class _FakeDB:
        async def execute(self, stmt):
            # The endpoint executes a SELECT first via set_config
            # (no rowset), then a SELECT Agent. We return None for
            # the set_config NULL roundtrip, and the agent stub for
            # the second call. The first invocation is identified by
            # the absence of `Agent` in str(stmt).
            text = str(stmt)
            if "set_config" in text:
                return _StubExecute(None)
            return _StubExecute(_FakeAgent())

    async def _fake_get_db():
        yield _FakeDB()

    def _fake_verify(plain, _hashed):
        return plain == FAKE_AGENT_KEY

    monkeypatch.setattr(agents_mod, "verify_password", _fake_verify)

    # ── minimal FastAPI app mounting only the gated router ────────
    app = FastAPI()
    app.include_router(agents_public_router, prefix="/api/v1/agents")
    app.dependency_overrides[agents_mod.get_db] = _fake_get_db

    return {
        "app": app,
        "client": TestClient(app),
        "agent_id": FAKE_AGENT_ID,
        "agent_key": FAKE_AGENT_KEY,
        "bin_path": bin_path,
        "sha_path": sha_path,
        "ver_path": ver_path,
        "data": data,
        "settings": settings,
        "agents_mod": agents_mod,
    }


# ── Flag-off ───────────────────────────────────────────────────────


def test_flag_off_returns_404(app_with_overrides):
    f = app_with_overrides
    res = f["client"].get(
        f"/api/v1/agents/{f['agent_id']}/download/host/windows-amd64",
        headers={"X-Agent-Key": f["agent_key"]},
    )
    assert res.status_code == 404
    body = res.json()
    assert body["detail"] == "Endpoint not available"


# ── Flag-on auth contract ──────────────────────────────────────────


def test_flag_on_missing_key_returns_401(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    res = f["client"].get(
        f"/api/v1/agents/{f['agent_id']}/download/host/windows-amd64"
    )
    assert res.status_code == 401


def test_flag_on_invalid_key_returns_404(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    res = f["client"].get(
        f"/api/v1/agents/{f['agent_id']}/download/host/windows-amd64",
        headers={"X-Agent-Key": "WRONG-KEY"},
    )
    assert res.status_code == 404
    assert res.json()["detail"] == "Agent not found"


# ── Flag-on happy path ─────────────────────────────────────────────


def test_flag_on_valid_key_byte_perfect(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    res = f["client"].get(
        f"/api/v1/agents/{f['agent_id']}/download/host/windows-amd64",
        headers={"X-Agent-Key": f["agent_key"]},
    )
    assert res.status_code == 200
    assert res.content == f["data"]
    assert res.headers["content-type"] == "application/octet-stream"
    assert res.headers["content-disposition"] == \
        'attachment; filename="charon-agent-host-windows-amd64.exe"'
    assert res.headers["content-length"] == str(len(f["data"]))
    assert res.headers["cache-control"] == \
        "no-store, no-cache, must-revalidate, max-age=0"
    assert res.headers["pragma"] == "no-cache"
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["x-host-version"] == VALID_VERSION
    expected_sha = hashlib.sha256(f["data"]).hexdigest()
    assert res.headers["x-host-sha256"] == expected_sha


# ── Integrity failure paths → all 503 ──────────────────────────────


def test_binary_missing_returns_503(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    f["bin_path"].unlink()
    monkeypatch.setattr(f["agents_mod"], "_HOST_INTEGRITY_CACHE", None)
    res = f["client"].get(
        f"/api/v1/agents/{f['agent_id']}/download/host/windows-amd64",
        headers={"X-Agent-Key": f["agent_key"]},
    )
    assert res.status_code == 503
    assert res.json()["detail"] == "Host binary not available"


def test_sha_sidecar_missing_returns_503(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    f["sha_path"].unlink()
    monkeypatch.setattr(f["agents_mod"], "_HOST_INTEGRITY_CACHE", None)
    res = f["client"].get(
        f"/api/v1/agents/{f['agent_id']}/download/host/windows-amd64",
        headers={"X-Agent-Key": f["agent_key"]},
    )
    assert res.status_code == 503


def test_version_sidecar_missing_returns_503(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    f["ver_path"].unlink()
    monkeypatch.setattr(f["agents_mod"], "_HOST_INTEGRITY_CACHE", None)
    res = f["client"].get(
        f"/api/v1/agents/{f['agent_id']}/download/host/windows-amd64",
        headers={"X-Agent-Key": f["agent_key"]},
    )
    assert res.status_code == 503


@pytest.mark.parametrize("bad", [
    "dev",
    "",
    "2.0.0-mvp0+gABCDEF123456",       # uppercase
    "2.0.0-mvp0+gabcdef",             # wrong length
    "2.0.0-mvp0+g0123456789ab0",      # too long (13 chars)
    "2.0.0-mvp0+gabcdef12345Z",       # non-hex final char
    "1.0.0-mvp0+gabcdef123456",       # wrong major
    "v2.0.0-mvp0+gabcdef123456",      # leading 'v'
    "2.0.0-mvp0+gabcdef123456\n",     # trailing newline (strip → OK)
])
def test_version_sidecar_malformed_returns_503(
    app_with_overrides, monkeypatch, bad
):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    if bad.endswith("\n"):
        # trailing newline is documented as accepted via .strip() —
        # this is the happy path, exclude from the negative set
        pytest.skip("trailing newline is stripped by the read path")
    f["ver_path"].write_text(bad)
    monkeypatch.setattr(f["agents_mod"], "_HOST_INTEGRITY_CACHE", None)
    res = f["client"].get(
        f"/api/v1/agents/{f['agent_id']}/download/host/windows-amd64",
        headers={"X-Agent-Key": f["agent_key"]},
    )
    assert res.status_code == 503, (
        f"version {bad!r} should reject; got {res.status_code}"
    )


def test_sha_mismatch_returns_503(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    f["sha_path"].write_text("0" * 64)
    monkeypatch.setattr(f["agents_mod"], "_HOST_INTEGRITY_CACHE", None)
    res = f["client"].get(
        f"/api/v1/agents/{f['agent_id']}/download/host/windows-amd64",
        headers={"X-Agent-Key": f["agent_key"]},
    )
    assert res.status_code == 503


# ── Range header is ignored → still full 200 ───────────────────────


def test_range_header_ignored(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    res = f["client"].get(
        f"/api/v1/agents/{f['agent_id']}/download/host/windows-amd64",
        headers={
            "X-Agent-Key": f["agent_key"],
            "Range": "bytes=0-99",
        },
    )
    # Documented WIN-INTEGRATE behaviour: ignore Range, serve full 200.
    assert res.status_code == 200
    assert len(res.content) == len(f["data"])


# ── Agent key never in URL / filename / response body ──────────────


def test_agent_key_not_in_response_artifacts(app_with_overrides, monkeypatch):
    f = app_with_overrides
    monkeypatch.setattr(f["settings"], "WINDOWS_AGENT_V2_ENABLED", True)
    res = f["client"].get(
        f"/api/v1/agents/{f['agent_id']}/download/host/windows-amd64",
        headers={"X-Agent-Key": f["agent_key"]},
    )
    assert res.status_code == 200
    # Never in any header value (URL, content-disposition, etc.)
    for name, value in res.headers.items():
        assert f["agent_key"] not in value, \
            f"agent key leaked into response header {name}"
    # Never in body (binary content is a fixed 2 MB buffer + MZ prefix)
    assert f["agent_key"].encode() not in res.content
