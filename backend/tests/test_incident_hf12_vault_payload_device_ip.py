"""Incident sprint Hotfix #12 — vault-active payload missing device_ip/ssh_port/os_type.

RCA (2026-06-04, macm4 agent.log):
  /opt/netmanager-agent/agent.log shows 261 occurrences of:
    File "netmanager_agent.py", line 659, in _build_params
        "host": msg["device_ip"],
    KeyError: 'device_ip'
  Triggered on every ssh_command when the agent's local vault is active.

  Backend agent_manager.execute_ssh_command vault-active payload omitted
  device_ip / ssh_port / os_type, sending only credential_id + command +
  command_mode + allowed_commands. The agent's _build_params reads
  msg["device_ip"] unconditionally → KeyError → _ssh_command task crashes
  before sending ssh_result → backend hits _COMMAND_TIMEOUT=90s →
  agent_command_logs row written with block_reason='timeout_after_90s'
  (QF-2 audit), 502 surfaces to UI as "Bilgi çekilemedi".

Fix:
  Add device_ip, ssh_port, os_type to the three vault-active payloads:
    - execute_ssh_command
    - execute_ssh_config
    - execute_ssh_command_stream
  Plaintext credentials (ssh_username/password/enable_secret) are still
  withheld — the agent looks them up in its local vault by credential_id.
  Only the device routing tuple is shared, matching the non-vault path.

Strategy:
  Source assertion on the three payload literals + a runtime drive of
  execute_ssh_command with a mocked vault_active=True agent to assert the
  payload bytes sent over WS carry device_ip.
"""
from __future__ import annotations

import asyncio
import inspect
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch


def _src() -> str:
    import app.services.agent_manager as m
    return Path(inspect.getfile(m)).read_text()


def _vault_block(symbol: str) -> str:
    """Return the source slice that contains the vault-active payload
    dict literal inside the given async method body."""
    src = _src()
    start = src.find(f"async def {symbol}(")
    assert start > 0, f"{symbol!r} not found"
    after = src.find("\n    async def ", start + 1)
    if after < 0:
        after = src.find("\n    def ", start + 1)
    block = src[start: after if after > 0 else len(src)]
    # Bound to the vault path
    vault_idx = block.find('if meta.get("vault_active"):')
    assert vault_idx > 0, f"{symbol!r}: vault branch not found"
    # Bound by the 'else' that follows
    else_idx = block.find("\n        else:\n", vault_idx)
    return block[vault_idx: else_idx if else_idx > 0 else len(block)]


# ─── Source assertions: all three vault payloads carry device_ip ──────────────


def test_hf12_execute_ssh_command_vault_payload_has_device_ip():
    block = _vault_block("execute_ssh_command")
    assert '"device_ip": device.ip_address' in block, (
        "execute_ssh_command vault payload missing device_ip"
    )
    assert '"ssh_port": device.ssh_port or 22' in block, (
        "execute_ssh_command vault payload missing ssh_port"
    )
    assert '"os_type": device.os_type' in block, (
        "execute_ssh_command vault payload missing os_type"
    )


def test_hf12_execute_ssh_config_vault_payload_has_device_ip():
    block = _vault_block("execute_ssh_config")
    assert '"device_ip": device.ip_address' in block
    assert '"ssh_port": device.ssh_port or 22' in block
    assert '"os_type": device.os_type' in block


def test_hf12_execute_ssh_command_stream_vault_payload_has_device_ip():
    block = _vault_block("execute_ssh_command_stream")
    assert '"device_ip": device.ip_address' in block
    assert '"ssh_port": device.ssh_port or 22' in block
    assert '"os_type": device.os_type' in block


# ─── Security: vault path must NOT leak plaintext credentials ─────────────────


def test_hf12_vault_payloads_still_withhold_plaintext_credentials():
    """The whole point of the vault path is to avoid sending plaintext
    passwords over WS. HF#12 adds the device routing tuple only; password
    fields must remain absent."""
    for symbol in ("execute_ssh_command", "execute_ssh_config",
                   "execute_ssh_command_stream"):
        block = _vault_block(symbol)
        assert '"ssh_password"' not in block, (
            f"{symbol}: vault payload leaks ssh_password"
        )
        assert '"ssh_username"' not in block, (
            f"{symbol}: vault payload includes ssh_username (vault must own it)"
        )
        assert '"enable_secret"' not in block, (
            f"{symbol}: vault payload leaks enable_secret"
        )
        # Vault path identity: credential_id must still be there
        assert "credential_id" in block


# ─── Runtime: payload sent over WS contains device_ip when vault_active=True ──


def test_hf12_runtime_payload_includes_device_ip_when_vault_active():
    """Drive execute_ssh_command with vault_active=True and assert the WS
    JSON payload actually carries device_ip / ssh_port / os_type."""
    from app.services.agent_manager import agent_manager

    captured = {}

    fake_ws = MagicMock()

    async def _capture_send(text):
        captured["payload"] = json.loads(text)

    fake_ws.send_text = AsyncMock(side_effect=_capture_send)

    fake_device = MagicMock()
    fake_device.id = 79
    fake_device.ip_address = "10.22.90.2"
    fake_device.ssh_port = 22
    fake_device.os_type = "ruijie_os"
    fake_device.organization_id = 1
    fake_device.location_id = 9

    async def _drive():
        # Patch the WS connection + meta + scope check + log + the in-flight
        # future so we can flush ws.send_text and timeout cleanly without
        # the agent ever replying.
        with patch.dict(
            agent_manager._connections, {"ag": fake_ws}, clear=False
        ), patch.dict(
            agent_manager._meta, {"ag": {"vault_active": True}}, clear=False
        ), patch.object(
            agent_manager, "_enforce_device_scope", return_value=None
        ), patch.object(
            agent_manager, "_log_command_async", side_effect=lambda **k: None
        ):
            try:
                await agent_manager.execute_ssh_command(
                    "ag", fake_device, "show version",
                )
            except RuntimeError as exc:
                # Expected: no agent reply → 90s timeout. But _send_request
                # has already done ws.send_text(payload) before awaiting.
                assert "did not respond within" in str(exc)
                return

    # Run with the smaller _COMMAND_TIMEOUT by patching it for speed
    with patch("app.services.agent_manager._COMMAND_TIMEOUT", 1):
        asyncio.run(_drive())

    p = captured.get("payload")
    assert p is not None, "ws.send_text never called"
    assert p.get("type") == "ssh_command"
    assert p.get("device_ip") == "10.22.90.2", f"missing device_ip: {p}"
    assert p.get("ssh_port") == 22
    assert p.get("os_type") == "ruijie_os"
    assert p.get("credential_id") == 79
    assert p.get("command") == "show version"
    # Vault path: plaintext credentials MUST NOT appear in payload
    assert "ssh_password" not in p
    assert "ssh_username" not in p
    assert "enable_secret" not in p


# ─── Non-vault path remains unchanged ─────────────────────────────────────────


def test_hf12_non_vault_path_unchanged():
    """HF#12 only modifies the vault-active branch; the device-fallback path
    (HF#11) already had device_ip and must not be touched."""
    src = _src()
    # Anchor non-vault payload literal still present in execute_ssh_command
    idx = src.find("async def execute_ssh_command(")
    end = src.find("\n    async def execute_ssh_config(", idx)
    block = src[idx:end]
    # else branch: device_ip + ssh_username + ssh_password + enable_secret
    assert "_resolve_credentials" in block
    assert '"device_ip": device.ip_address' in block
    assert '"ssh_username": _user' in block
    assert '"ssh_password": _pass' in block
    assert '"enable_secret": _enable' in block
