"""QF-2 (2026-06-03) — Backend _send_request timeout audit.

Background:
  When the agent does not reply within `_COMMAND_TIMEOUT` (90s), `_send_request`
  raises `RuntimeError("did not respond within ...")`. Callers (execute_ssh_command,
  execute_ssh_config, test_ssh_connection) all log to agent_command_logs only
  on the success path; the timeout path skips the log entirely. Result:
  agent_command_logs is silent for every concurrent-burst failure and forensics
  has no DB-level signal.

Fix:
  _send_request itself writes the failure row when given the new audit-context
  kwargs (command_type, command, device_ip). The exception is still re-raised;
  caller behavior unchanged.

Strategy:
  Mock the agent WebSocket so we can drive `_send_request` directly. Stub
  `_log_command_async` to capture kwargs. No password/secret fields are
  passed through — verify via source assertion + runtime kwargs check.
"""
from __future__ import annotations

import asyncio
import inspect
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch


# ─── 1. Backend reads new agent version ───────────────────────────────────────


def test_qf2_backend_current_agent_version_is_1_4_1():
    """Backend imports agent VERSION from script at startup (regex). After
    bumping VERSION in the agent script, CURRENT_AGENT_VERSION must reflect it.
    This test re-runs the same parser logic so we don't depend on import-time
    ordering of the agents endpoint module."""
    from app.api.v1.endpoints.agents import _read_agent_version
    assert _read_agent_version() == "1.4.1"


# ─── 2. _send_request timeout audit path ──────────────────────────────────────


def test_qf2_send_request_logs_on_timeout():
    """When the future never resolves and timeout fires, _log_command_async
    must be called with success=False and block_reason='timeout_after_<n>s'."""
    from app.services.agent_manager import agent_manager

    captured: dict = {}

    def _spy(**kwargs):
        captured.update(kwargs)

    # Provide a fake WS that accepts send_text
    fake_ws = MagicMock()
    fake_ws.send_text = AsyncMock(return_value=None)

    rid = "test_rid_qf2_timeout"
    payload = {"type": "ssh_command", "request_id": rid}

    async def _drive():
        with patch.dict(agent_manager._connections, {"agent_xyz": fake_ws}, clear=False), \
             patch.object(agent_manager, "_log_command_async", side_effect=_spy):
            try:
                await agent_manager._send_request(
                    "agent_xyz", payload, timeout=1,
                    device_id=42,
                    command_type="ssh_command", command="show version",
                    device_ip="10.0.0.1",
                )
            except RuntimeError as e:
                assert "did not respond within 1s" in str(e), str(e)
                return
        raise AssertionError("_send_request did not raise on timeout")

    asyncio.run(_drive())

    # Audit assertions
    assert captured, "_log_command_async was not called on timeout"
    assert captured.get("agent_id") == "agent_xyz"
    assert captured.get("device_id") == 42
    assert captured.get("device_ip") == "10.0.0.1"
    assert captured.get("command_type") == "ssh_command"
    assert captured.get("command") == "show version"
    assert captured.get("success") is False
    assert captured.get("blocked") is False
    assert captured.get("block_reason") == "timeout_after_1s"
    assert captured.get("request_id") == rid
    # duration_ms must be a positive int reflecting the ~1s wait
    dur = captured.get("duration_ms")
    assert isinstance(dur, int) and dur >= 900, f"duration_ms={dur!r}"


def test_qf2_send_request_skips_audit_when_command_type_missing():
    """Backward compat: callers that did NOT pass command_type (legacy code or
    snmp_get/snmp_walk/discover) get no audit row — behavior identical to
    pre-QF-2. Only opted-in callers (ssh_command/config/test) get the new log."""
    from app.services.agent_manager import agent_manager

    called = {"count": 0}

    def _spy(**kwargs):
        called["count"] += 1

    fake_ws = MagicMock()
    fake_ws.send_text = AsyncMock(return_value=None)
    rid = "test_rid_qf2_legacy"
    payload = {"type": "snmp_get", "request_id": rid}

    async def _drive():
        with patch.dict(agent_manager._connections, {"agent_legacy": fake_ws}, clear=False), \
             patch.object(agent_manager, "_log_command_async", side_effect=_spy):
            try:
                await agent_manager._send_request(
                    "agent_legacy", payload, timeout=1, device_id=99,
                    # NO command_type / command / device_ip — legacy caller shape
                )
            except RuntimeError:
                return
        raise AssertionError("expected timeout RuntimeError")

    asyncio.run(_drive())
    assert called["count"] == 0, "audit must be skipped when command_type is None"


def test_qf2_runtime_error_re_raised_with_same_message():
    """Endpoint layer relies on the literal 'did not respond within Ns' string
    to surface the agent-perf hint to the UI. Don't break that contract."""
    from app.services.agent_manager import agent_manager

    fake_ws = MagicMock()
    fake_ws.send_text = AsyncMock(return_value=None)
    rid = "rid_msg_check"

    async def _drive():
        with patch.dict(agent_manager._connections, {"a": fake_ws}, clear=False), \
             patch.object(agent_manager, "_log_command_async", side_effect=lambda **k: None):
            try:
                await agent_manager._send_request(
                    "a", {"type": "ssh_command", "request_id": rid}, timeout=1,
                    command_type="ssh_command", command="show version", device_ip="x",
                )
            except RuntimeError as e:
                return str(e)
        raise AssertionError("expected timeout")

    msg = asyncio.run(_drive())
    assert "Agent a did not respond within 1s" == msg


# ─── 3. Security: no plaintext password ever in the audit kwargs ──────────────


def test_qf2_audit_kwargs_exclude_password_fields():
    """Source assertion: in `_send_request` body, the `_log_command_async`
    call must NOT pass any of: ssh_password, decrypt_credential, payload[
    "ssh_password"]. The audit gets command_type/command/duration_ms etc. —
    nothing that could leak credentials into agent_command_logs."""
    src = Path(
        inspect.getfile(__import__("app.services.agent_manager", fromlist=["x"]))
    ).read_text()
    # Locate _send_request body
    start = src.find("async def _send_request(")
    assert start > 0
    # Find next async def after start to bound the block
    after = src.find("\n    async def ", start + 1)
    block = src[start:after if after > 0 else len(src)]

    forbidden = (
        "ssh_password",
        "decrypt_credential",
        '"ssh_password"',
        "ssh_password=",
        "enable_secret=",
    )
    for token in forbidden:
        assert token not in block, (
            f"_send_request body contains forbidden token {token!r} "
            "(possible password leak into audit kwargs)"
        )


def test_qf2_runtime_call_no_password_in_audit_kwargs():
    """Runtime guard: drive a timeout with a payload that DOES carry a
    plaintext password (as ssh_command does), then verify the spy never saw it."""
    from app.services.agent_manager import agent_manager

    captured: dict = {}

    def _spy(**kwargs):
        captured.update(kwargs)

    fake_ws = MagicMock()
    fake_ws.send_text = AsyncMock(return_value=None)

    payload_with_secret = {
        "type": "ssh_command",
        "request_id": "rid_secret_leak_check",
        "ssh_username": "admin",
        "ssh_password": "SUPER_SECRET_PW_AAAA",   # MUST NOT appear in audit
        "enable_secret": "EN_SECRET_BBBB",
        "command": "show version",
    }

    async def _drive():
        with patch.dict(agent_manager._connections, {"ag": fake_ws}, clear=False), \
             patch.object(agent_manager, "_log_command_async", side_effect=_spy):
            try:
                await agent_manager._send_request(
                    "ag", payload_with_secret, timeout=1, device_id=7,
                    command_type="ssh_command", command="show version", device_ip="1.2.3.4",
                )
            except RuntimeError:
                return
        raise AssertionError("expected timeout")

    asyncio.run(_drive())

    # No value in captured kwargs should equal the secret literals
    forbidden_values = {"SUPER_SECRET_PW_AAAA", "EN_SECRET_BBBB"}
    forbidden_keys = {"ssh_password", "enable_secret"}
    for k, v in captured.items():
        assert k not in forbidden_keys, f"audit kwarg {k!r} leaked"
        assert v not in forbidden_values, (
            f"audit value {v!r} matches secret literal (key={k})"
        )


# ─── 4. Callers updated to pass audit context ─────────────────────────────────


def test_qf2_execute_ssh_command_passes_audit_context():
    src = Path(
        inspect.getfile(__import__("app.services.agent_manager", fromlist=["x"]))
    ).read_text()
    # Bound execute_ssh_command body
    start = src.find("async def execute_ssh_command(")
    assert start > 0
    after = src.find("\n    async def ", start + 1)
    block = src[start:after if after > 0 else len(src)]
    assert 'command_type="ssh_command"' in block
    assert "device_ip=device.ip_address" in block


def test_qf2_execute_ssh_config_passes_audit_context():
    src = Path(
        inspect.getfile(__import__("app.services.agent_manager", fromlist=["x"]))
    ).read_text()
    start = src.find("async def execute_ssh_config(")
    after = src.find("\n    async def ", start + 1)
    block = src[start:after if after > 0 else len(src)]
    assert 'command_type="ssh_config"' in block
    assert "device_ip=device.ip_address" in block


def test_qf2_test_ssh_connection_passes_audit_context():
    src = Path(
        inspect.getfile(__import__("app.services.agent_manager", fromlist=["x"]))
    ).read_text()
    start = src.find("async def test_ssh_connection(")
    after = src.find("\n    async def ", start + 1)
    block = src[start:after if after > 0 else len(src)]
    assert 'command_type="ssh_test"' in block
    assert "device_ip=device.ip_address" in block
