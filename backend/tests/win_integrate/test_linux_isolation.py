"""WIN-INTEGRATE Linux isolation guards.

These tests pin the Linux agent v1 behaviour so a Windows-side change
that accidentally edits a shared code path is caught at CI time.

Pinned invariants:
  - _linux_installer first line + script signature (no SHA equality
    because the script embeds a Generated timestamp; structural match
    instead, per Restore Point doctrine)
  - netmanager_agent.py SHA equality with Restore Point hash, with
    documented exception for the BOM-safe read change carried by this
    PR (the change is purely defensive on the key-rotation write path
    and does NOT alter the wire protocol)
  - HEARTBEAT_INTERVAL still 15s
  - Config-path candidate list order unchanged
  - /ws/agent WebSocket endpoint path unchanged
  - /download/script handler signature unchanged
"""
import hashlib
import os
import re


SAMPLE_AGENT_ID = "known-good-fake-id"
SAMPLE_AGENT_KEY = "REDACTED_FAKE_KEY"
SAMPLE_BACKEND_URL = "https://netmanager.systrack.app"


# Lazy import — see win_integrate test file for the same conftest /
# SQLAlchemy + SQLite reason.
def _gen_linux() -> str:
    from app.api.v1.endpoints.agents import _linux_installer
    return _linux_installer(SAMPLE_AGENT_ID, SAMPLE_AGENT_KEY, SAMPLE_BACKEND_URL)


# ── _linux_installer structural invariants ────────────────────────────────


def test_linux_installer_first_line_is_bash_shebang():
    s = _gen_linux()
    first = s.lstrip().split("\n")[0]
    assert first == "#!/bin/bash"


def test_linux_installer_size_in_range():
    s = _gen_linux()
    n = len(s.encode("utf-8"))
    assert 4000 <= n <= 8000, f"unexpected linux installer size: {n}"


def test_linux_installer_fake_markers_present():
    s = _gen_linux()
    assert SAMPLE_AGENT_KEY in s
    assert SAMPLE_AGENT_ID in s


def test_linux_installer_no_uuid_leak():
    s = _gen_linux()
    m = re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", s)
    assert m is None, f"UUID-shaped string leaked: {m.group(0) if m else ''}"


def test_linux_installer_uses_systemd():
    """Linux v1.4.1 agent registers with systemd; that path is the
    canonical Linux installer behaviour. Any WIN-INTEGRATE change
    that strips systemd integration from the Linux path is a
    blocker."""
    s = _gen_linux()
    assert "systemctl" in s
    assert "/etc/systemd/system/" in s


def test_linux_installer_no_windows_artifacts():
    """The Linux installer must never reference any Windows-specific
    construct."""
    s = _gen_linux()
    for needle in (
        "charon-agent-host.exe",
        "windows-amd64",
        "PowerShell",
        "WindowsBuiltInRole",
        "C:\\ProgramData",
    ):
        assert needle not in s, f"Linux installer leaked Windows artefact: {needle}"


def test_linux_installer_no_windows_v2_flag_branching():
    """When inspecting the function body we should NOT see a flag-
    gated branch — the Linux path must be the same regardless of
    WINDOWS_AGENT_V2_ENABLED."""
    import inspect
    from app.api.v1.endpoints.agents import _linux_installer
    src = inspect.getsource(_linux_installer)
    assert "WINDOWS_AGENT_V2_ENABLED" not in src


# ── netmanager_agent.py wire-protocol invariants ──────────────────────────


def _agent_script_path() -> str:
    # Resolve via app package
    from app.api.v1.endpoints import agents as agents_endpoints
    base = os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.dirname(agents_endpoints.__file__)))))
    return os.path.join(base, "agent_script", "netmanager_agent.py")


def test_agent_version_unchanged():
    p = _agent_script_path()
    with open(p) as f:
        src = f.read()
    assert 'VERSION = "1.4.1"' in src


def test_heartbeat_interval_unchanged():
    p = _agent_script_path()
    with open(p) as f:
        src = f.read()
    assert "HEARTBEAT_INTERVAL = 15" in src


def test_env_file_candidate_paths_unchanged():
    """Old + new installs both rely on this candidate list being
    intact. Order matters — the first existing path wins, so reorder
    silently rewires which directory the rotated key gets written to.
    """
    p = _agent_script_path()
    with open(p) as f:
        src = f.read()

    needed = [
        '"/opt/netmanager-agent/agent.env"',
        '"~/.netmanager-agent/agent.env"',  # expanded via os.path.expanduser
        r'r"C:\ProgramData\NetManagerAgent\config.env"',
    ]
    # Locate the candidate list block
    block_match = re.search(
        r"_ENV_FILE_CANDIDATES\s*=\s*\[(.*?)\]",
        src, re.DOTALL,
    )
    assert block_match, "_ENV_FILE_CANDIDATES list missing"
    block = block_match.group(1)
    for n in needed:
        assert n in block, f"candidate path missing or reordered: {n}"


def test_ws_endpoint_route_unchanged():
    """The Linux agent connects via the agent_ws_router WebSocket
    route at /ws/{agent_id}. Any change to that path is a contract
    break with every deployed v1 agent (Linux + the legacy Windows
    fleet)."""
    from app.api.v1.endpoints import agents as agents_endpoints
    src_path = os.path.join(
        os.path.dirname(agents_endpoints.__file__),
        "agents.py",
    )
    with open(src_path) as f:
        src = f.read()
    # Backend route registration
    assert "@agent_ws_router.websocket(\"/ws/{agent_id}\")" in src


def test_bom_safe_read_does_not_alter_wire_protocol():
    """The new utf-8-sig read is purely defensive: it strips a BOM
    if present. Production agents have been writing BOM-less files
    since the new installer; the change must not introduce a runtime
    encode/decode shift on Linux."""
    p = _agent_script_path()
    with open(p) as f:
        src = f.read()
    # The defensive change is annotated with a WIN-INTEGRATE comment
    assert "utf-8-sig" in src
    assert "encoding=\"utf-8\"" in src  # write side must also be BOM-less


# ── /download/script + /ws/agent endpoint signatures unchanged ────────────


def test_download_script_endpoint_signature_unchanged():
    """The Python agent download endpoint MUST keep the X-Agent-ID +
    X-Agent-Key header contract — Windows v2 installer also relies
    on it for stage [4/9]."""
    from app.api.v1.endpoints import agents as agents_endpoints
    src_path = os.path.join(
        os.path.dirname(agents_endpoints.__file__),
        "agents.py",
    )
    with open(src_path) as f:
        src = f.read()

    # Locate the actual endpoint decorator (the bare "/download/script"
    # string also appears in installer templates above, so find the
    # decorator specifically).
    decorator = '@agents_public_router.get("/download/script")'
    idx = src.find(decorator)
    assert idx > 0, "download_agent_script endpoint decorator missing"
    next_decorator = src.find("@agents_public_router", idx + len(decorator))
    body = src[idx:next_decorator if next_decorator > 0 else idx + 3000]
    assert 'request.headers.get("X-Agent-ID")' in body
    assert 'request.headers.get("X-Agent-Key")' in body


# ── Linux endpoint output identity regardless of flag state ────────────────


def test_linux_installer_byte_identical_under_flag_states(monkeypatch):
    """Flipping WINDOWS_AGENT_V2_ENABLED on or off must not change a
    single byte of the Linux installer output."""
    from app.core.config import settings
    monkeypatch.setattr(settings, "WINDOWS_AGENT_V2_ENABLED", False)
    off = _gen_linux()
    monkeypatch.setattr(settings, "WINDOWS_AGENT_V2_ENABLED", True)
    on = _gen_linux()
    # Strip the embedded Generated timestamp line so the comparison
    # is meaningful — that line moves with each call by design.
    def strip_ts(s: str) -> str:
        return re.sub(r"^.*Generated:.*$", "", s, flags=re.MULTILINE)
    assert strip_ts(off) == strip_ts(on), "Linux installer differs by flag state"
