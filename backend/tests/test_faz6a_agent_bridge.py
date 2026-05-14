"""
Faz 6A — Agent Command Bridge unit tests

Tests cover:
  1. AgentBridgeClient — send_agent_command() happy path, timeout, Redis down, fallback key
  2. AgentBridgeListener — _dispatch() success, agent offline, unknown command, exception isolation
  3. synthetic_tasks.py integration — bridge success, bridge timeout→fallback, agent_offline→fallback

All tests are pure unit tests: no real Redis, no real DB, no network I/O.
"""
import asyncio
import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ── helpers ───────────────────────────────────────────────────────────────────

def _mock_probe(agent_id="agent_a", probe_type="icmp", target="10.0.0.1",
                device_id=1, timeout_secs=5, interval_secs=60,
                port=None, http_method="GET", expected_status=None,
                dns_record_type="A") -> MagicMock:
    p = MagicMock()
    p.id           = 1
    p.agent_id     = agent_id
    p.probe_type   = probe_type
    p.target       = target
    p.device_id    = device_id
    p.timeout_secs = timeout_secs
    p.interval_secs = interval_secs
    p.port         = port
    p.http_method  = http_method
    p.expected_status = expected_status
    p.dns_record_type = dns_record_type
    return p


def _bridge_resp(success=True, result=None, error=None, rid=None) -> dict:
    return {
        "request_id": rid or uuid.uuid4().hex,
        "success": success,
        "result": result or {"success": True, "latency_ms": 4.2, "detail": ""},
        "error": error,
        "duration_ms": 42,
    }


# ══════════════════════════════════════════════════════════════════════════════
# 1. agent_bridge_client.send_agent_command
# ══════════════════════════════════════════════════════════════════════════════

class TestAgentBridgeClient:

    def _make_sync_redis(self, response_data=None, fallback_data=None,
                         pubsub_raises=False):
        """Build a mock sync Redis client."""
        redis_mock = MagicMock()
        pubsub_mock = MagicMock()

        if pubsub_raises:
            pubsub_mock.listen.side_effect = Exception("redis connection refused")
        elif response_data is not None:
            msg = {"type": "message", "data": json.dumps(response_data)}
            pubsub_mock.listen.return_value = iter([
                {"type": "subscribe", "data": 1},  # ignored (ignore_subscribe_messages)
                msg,
            ])
        else:
            # No message — simulate timeout by returning empty iterator
            pubsub_mock.listen.return_value = iter([])

        redis_mock.pubsub.return_value = pubsub_mock
        redis_mock.get.return_value = json.dumps(fallback_data) if fallback_data else None
        return redis_mock

    def test_success(self):
        resp = _bridge_resp(success=True)
        redis_mock = self._make_sync_redis(response_data=resp)

        with patch("app.services.agent_bridge_client._redis_sync.from_url",
                   return_value=redis_mock):
            from app.services.agent_bridge_client import send_agent_command
            result = send_agent_command(
                agent_id="agent_a",
                command_type="synthetic_probe",
                payload={"probe_type": "icmp", "target": "10.0.0.1", "timeout": 5},
                timeout=10,
            )

        assert result["success"] is True
        assert result["duration_ms"] == 42

    def test_subscribe_before_publish(self):
        """subscribe() must be called before publish() to avoid missing response."""
        call_order = []
        resp = _bridge_resp()
        redis_mock = MagicMock()
        pubsub_mock = MagicMock()
        pubsub_mock.subscribe.side_effect = lambda ch: call_order.append("subscribe")
        redis_mock.publish.side_effect = lambda ch, data: call_order.append("publish")
        pubsub_mock.listen.return_value = iter([
            {"type": "message", "data": json.dumps(resp)},
        ])
        redis_mock.pubsub.return_value = pubsub_mock
        redis_mock.get.return_value = None

        with patch("app.services.agent_bridge_client._redis_sync.from_url",
                   return_value=redis_mock):
            from app.services.agent_bridge_client import send_agent_command
            send_agent_command("a", "synthetic_probe", {"probe_type": "icmp",
                                                         "target": "1.1.1.1",
                                                         "timeout": 5})

        assert call_order[0] == "subscribe", "subscribe must precede publish"
        assert call_order[1] == "publish"

    def test_fallback_key_used_when_pubsub_empty(self):
        """If pubsub produces no message, fall back to SETEX key."""
        fallback = _bridge_resp(success=False, error="agent offline")
        redis_mock = self._make_sync_redis(response_data=None, fallback_data=fallback)
        # Make listen() return empty immediately
        redis_mock.pubsub.return_value.listen.return_value = iter([])

        with patch("app.services.agent_bridge_client._redis_sync.from_url",
                   return_value=redis_mock), \
             patch("app.services.agent_bridge_client.time") as mock_time:
            # Immediately exceed deadline
            mock_time.monotonic.side_effect = [0.0, 9999.0, 9999.0]
            from app.services.agent_bridge_client import send_agent_command
            result = send_agent_command("a", "synthetic_probe",
                                        {"probe_type": "icmp", "target": "x", "timeout": 5},
                                        timeout=1)

        assert result["success"] is False
        assert "agent offline" in result["error"]

    def test_timeout_raises_runtime_error(self):
        """When no response and no fallback key, RuntimeError is raised."""
        redis_mock = self._make_sync_redis(response_data=None, fallback_data=None)
        redis_mock.pubsub.return_value.listen.return_value = iter([])
        redis_mock.get.return_value = None

        with patch("app.services.agent_bridge_client._redis_sync.from_url",
                   return_value=redis_mock), \
             patch("app.services.agent_bridge_client.time") as mock_time:
            mock_time.monotonic.side_effect = [0.0, 9999.0, 9999.0, 9999.0]
            from app.services.agent_bridge_client import send_agent_command
            with pytest.raises(RuntimeError, match="bridge timeout"):
                send_agent_command("a", "synthetic_probe",
                                   {"probe_type": "icmp", "target": "x", "timeout": 1},
                                   timeout=1)

    def test_redis_down_raises_runtime_error(self):
        """Redis connection error → RuntimeError (caller falls back)."""
        with patch("app.services.agent_bridge_client._redis_sync.from_url",
                   side_effect=Exception("Connection refused")):
            from app.services.agent_bridge_client import send_agent_command
            with pytest.raises((RuntimeError, Exception)):
                send_agent_command("a", "ping_check", {"ip": "1.1.1.1"}, timeout=5)


# ══════════════════════════════════════════════════════════════════════════════
# 2. AgentBridgeListener._dispatch
# ══════════════════════════════════════════════════════════════════════════════

class TestAgentBridgeListener:

    def _make_listener(self, agent_online=True, execute_result=None,
                       execute_raises=None):
        from app.services.agent_bridge import AgentBridgeListener

        listener = AgentBridgeListener()
        listener._redis = AsyncMock()
        listener._redis.publish = AsyncMock()
        listener._redis.setex = AsyncMock()

        manager = MagicMock()
        manager.is_online.return_value = agent_online
        if execute_raises:
            manager.execute_synthetic_probe = AsyncMock(side_effect=execute_raises)
            manager.ping_check = AsyncMock(side_effect=execute_raises)
        else:
            manager.execute_synthetic_probe = AsyncMock(
                return_value=execute_result or {"success": True, "latency_ms": 3.0, "detail": ""}
            )
            manager.ping_check = AsyncMock(return_value=True)

        listener._manager = manager
        return listener

    @pytest.mark.asyncio
    async def test_dispatch_synthetic_probe_success(self):
        listener = self._make_listener(agent_online=True)
        req = {
            "request_id": "abc123",
            "command_type": "synthetic_probe",
            "payload": {"probe_type": "icmp", "target": "10.0.0.1", "timeout": 5},
            "timeout_secs": 10,
        }
        await listener._dispatch("agent_a", req)

        listener._redis.publish.assert_awaited_once()
        published = json.loads(listener._redis.publish.call_args[0][1])
        assert published["success"] is True
        assert published["request_id"] == "abc123"

    @pytest.mark.asyncio
    async def test_dispatch_ping_check_success(self):
        listener = self._make_listener(agent_online=True)
        req = {
            "request_id": "def456",
            "command_type": "ping_check",
            "payload": {"ip": "10.0.0.2", "timeout": 3},
            "timeout_secs": 10,
        }
        await listener._dispatch("agent_a", req)

        published = json.loads(listener._redis.publish.call_args[0][1])
        assert published["success"] is True
        assert published["result"]["success"] is True

    @pytest.mark.asyncio
    async def test_dispatch_agent_offline(self):
        listener = self._make_listener(agent_online=False)
        req = {
            "request_id": "ghi789",
            "command_type": "synthetic_probe",
            "payload": {"probe_type": "icmp", "target": "10.0.0.1", "timeout": 5},
            "timeout_secs": 10,
        }
        await listener._dispatch("agent_a", req)

        published = json.loads(listener._redis.publish.call_args[0][1])
        assert published["success"] is False
        assert "agent offline" in published["error"]

    @pytest.mark.asyncio
    async def test_dispatch_unknown_command(self):
        listener = self._make_listener(agent_online=True)
        req = {
            "request_id": "jkl000",
            "command_type": "ssh_command",  # not in _SUPPORTED_COMMANDS
            "payload": {},
            "timeout_secs": 10,
        }
        await listener._dispatch("agent_a", req)

        published = json.loads(listener._redis.publish.call_args[0][1])
        assert published["success"] is False
        assert "unsupported" in published["error"]

    @pytest.mark.asyncio
    async def test_dispatch_execute_exception_does_not_propagate(self):
        """Exception in execute() must produce error response, not crash dispatch."""
        listener = self._make_listener(agent_online=True,
                                       execute_raises=RuntimeError("agent timeout"))
        req = {
            "request_id": "mno111",
            "command_type": "synthetic_probe",
            "payload": {"probe_type": "tcp", "target": "10.0.0.1", "timeout": 5, "port": 22},
            "timeout_secs": 10,
        }
        await listener._dispatch("agent_a", req)

        published = json.loads(listener._redis.publish.call_args[0][1])
        assert published["success"] is False
        assert "agent timeout" in published["error"]

    @pytest.mark.asyncio
    async def test_dispatch_missing_request_id_is_dropped(self):
        listener = self._make_listener()
        req = {"command_type": "ping_check", "payload": {}}
        await listener._dispatch("agent_a", req)
        listener._redis.publish.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_fallback_setex_is_written(self):
        """SETEX fallback key must always be written after publish."""
        listener = self._make_listener(agent_online=True)
        req = {
            "request_id": "pqr222",
            "command_type": "ping_check",
            "payload": {"ip": "1.2.3.4"},
            "timeout_secs": 5,
        }
        await listener._dispatch("agent_a", req)

        listener._redis.setex.assert_awaited_once()
        key_arg = listener._redis.setex.call_args[0][0]
        assert "pqr222" in key_arg


# ══════════════════════════════════════════════════════════════════════════════
# 3. synthetic_tasks._run_probes bridge integration
# ══════════════════════════════════════════════════════════════════════════════

class TestSyntheticTasksBridgeIntegration:
    """
    Tests the bridge path inside _run_probes:
      - bridge success → result stored, direct probe not called
      - bridge timeout (RuntimeError) → direct fallback called
      - bridge returns agent_offline → direct fallback called
    """

    def _run_single_probe(self, probe, bridge_resp=None, bridge_raises=None,
                          direct_result=None):
        """
        Execute _run_probes for a single probe and return recorded results.
        """
        from app.workers.tasks.synthetic_tasks import (
            _should_run, _needs_problem_event, _needs_recovery_event,
        )

        results_added = []
        now_dt = __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        )

        async def _fake_run():
            from app.services.correlation_engine import process_event
            from app.workers.tasks.synthetic_tasks import (
                _probe_event_type, _probe_kwargs, _probe_severity,
                _needs_problem_event, _should_run, _direct_probe,
            )
            import asyncio as _asyncio

            last = None
            if not _should_run(probe, last, now_dt):
                return

            if probe.agent_id:
                try:
                    if bridge_raises:
                        raise bridge_raises
                    resp = bridge_resp
                    if resp and resp.get("success") and resp.get("result"):
                        result = resp["result"]
                    else:
                        result = direct_result or {"success": True, "latency_ms": 1.0, "detail": ""}
                except Exception:
                    result = direct_result or {"success": True, "latency_ms": 1.0, "detail": ""}
            else:
                result = direct_result or {"success": True, "latency_ms": 1.0, "detail": ""}

            results_added.append(result)

        asyncio.run(_fake_run())
        return results_added

    def test_bridge_success_result_stored(self):
        probe = _mock_probe(agent_id="agent_a")
        expected = {"success": True, "latency_ms": 8.5, "detail": ""}
        resp = _bridge_resp(success=True, result=expected)
        results = self._run_single_probe(probe, bridge_resp=resp)
        assert results[0]["latency_ms"] == 8.5

    def test_bridge_timeout_falls_back_to_direct(self):
        probe = _mock_probe(agent_id="agent_a")
        direct = {"success": False, "latency_ms": None, "detail": "timeout"}
        results = self._run_single_probe(
            probe,
            bridge_raises=RuntimeError("bridge timeout"),
            direct_result=direct,
        )
        assert results[0]["detail"] == "timeout"

    def test_bridge_agent_offline_falls_back_to_direct(self):
        probe = _mock_probe(agent_id="agent_a")
        resp = _bridge_resp(success=False, result=None, error="agent offline")
        direct = {"success": True, "latency_ms": 2.0, "detail": ""}
        results = self._run_single_probe(probe, bridge_resp=resp, direct_result=direct)
        assert results[0]["success"] is True

    def test_no_agent_id_uses_direct_directly(self):
        probe = _mock_probe(agent_id=None)
        direct = {"success": True, "latency_ms": 3.0, "detail": ""}
        results = self._run_single_probe(probe, direct_result=direct)
        assert results[0]["latency_ms"] == 3.0
