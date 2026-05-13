"""
Unit tests for agent_peer_tasks.py pure helpers — Faz 3C

Tests cover _measure_latency: RTT parsing, reachability flag, timeout,
subprocess errors, and edge cases. No Celery, no DB, no network I/O.
"""

import subprocess
from unittest.mock import MagicMock, patch

import pytest

from app.workers.tasks.agent_peer_tasks import _measure_latency


# ── Helpers ───────────────────────────────────────────────────────────────────

def _completed(returncode: int, stdout: str) -> MagicMock:
    result = MagicMock()
    result.returncode = returncode
    result.stdout = stdout
    return result


# ══════════════════════════════════════════════════════════════════════════════
# 1. Reachable — RTT parsed from stdout
# ══════════════════════════════════════════════════════════════════════════════

def test_reachable_rtt_parsed():
    stdout = "64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time=2.34 ms"
    with patch("subprocess.run", return_value=_completed(0, stdout)):
        reachable, latency = _measure_latency("10.0.0.1")
    assert reachable is True
    assert latency == pytest.approx(2.34)


def test_reachable_rtt_integer():
    stdout = "64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time=5 ms"
    with patch("subprocess.run", return_value=_completed(0, stdout)):
        reachable, latency = _measure_latency("10.0.0.1")
    assert reachable is True
    assert latency == pytest.approx(5.0)


def test_reachable_windows_time_lt():
    # Windows ping may emit "time<1 ms"
    stdout = "Reply from 10.0.0.1: bytes=32 time<1ms TTL=128"
    with patch("subprocess.run", return_value=_completed(0, stdout)):
        reachable, latency = _measure_latency("10.0.0.1")
    assert reachable is True
    assert latency == pytest.approx(1.0)


def test_reachable_no_rtt_in_stdout_falls_back_to_elapsed():
    # No "time=" in output — fallback to measured wall-clock elapsed
    stdout = "PING 10.0.0.1: 56 data bytes\n1 packets transmitted, 1 received"
    with patch("subprocess.run", return_value=_completed(0, stdout)):
        reachable, latency = _measure_latency("10.0.0.1")
    assert reachable is True
    assert latency is not None
    assert latency >= 0.0


# ══════════════════════════════════════════════════════════════════════════════
# 2. Unreachable — non-zero returncode
# ══════════════════════════════════════════════════════════════════════════════

def test_unreachable_returncode_nonzero():
    with patch("subprocess.run", return_value=_completed(1, "")):
        reachable, latency = _measure_latency("10.0.0.99")
    assert reachable is False
    assert latency is None


def test_unreachable_returncode_2():
    with patch("subprocess.run", return_value=_completed(2, "Destination Host Unreachable")):
        reachable, latency = _measure_latency("192.168.1.1")
    assert reachable is False
    assert latency is None


# ══════════════════════════════════════════════════════════════════════════════
# 3. Edge cases — timeouts and exceptions
# ══════════════════════════════════════════════════════════════════════════════

def test_subprocess_timeout_returns_false():
    with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="ping", timeout=5)):
        reachable, latency = _measure_latency("10.0.0.1")
    assert reachable is False
    assert latency is None


def test_generic_exception_returns_false():
    with patch("subprocess.run", side_effect=FileNotFoundError("ping not found")):
        reachable, latency = _measure_latency("10.0.0.1")
    assert reachable is False
    assert latency is None


def test_permission_error_returns_false():
    with patch("subprocess.run", side_effect=PermissionError("ICMP not permitted")):
        reachable, latency = _measure_latency("10.0.0.1")
    assert reachable is False
    assert latency is None


# ══════════════════════════════════════════════════════════════════════════════
# 4. Custom timeout propagated to subprocess
# ══════════════════════════════════════════════════════════════════════════════

def test_custom_timeout_passed_to_subprocess():
    stdout = "time=1.0 ms"
    captured = {}
    def fake_run(cmd, **kwargs):
        captured["timeout"] = kwargs.get("timeout")
        return _completed(0, stdout)

    with patch("subprocess.run", side_effect=fake_run):
        _measure_latency("10.0.0.1", timeout=7)

    assert captured["timeout"] == 9   # timeout + 2


# ══════════════════════════════════════════════════════════════════════════════
# 5. Return-type contracts
# ══════════════════════════════════════════════════════════════════════════════

def test_return_type_on_success():
    with patch("subprocess.run", return_value=_completed(0, "time=1.5 ms")):
        reachable, latency = _measure_latency("10.0.0.1")
    assert isinstance(reachable, bool)
    assert isinstance(latency, float)


def test_return_type_on_failure():
    with patch("subprocess.run", return_value=_completed(1, "")):
        reachable, latency = _measure_latency("10.0.0.1")
    assert isinstance(reachable, bool)
    assert latency is None
