"""
Unit tests for synthetic_tasks.py pure helpers — Faz 3B / Pilot

Tests cover probe-to-event-type mapping, correlation event decision logic,
kwargs building, and direct probe sync helpers. No Celery, no DB, no real
network I/O, no agent required.
"""

import socket
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock, patch

import pytest

from app.workers.tasks.synthetic_tasks import (
    _probe_event_type,
    _probe_severity,
    _probe_kwargs,
    _should_run,
    _needs_problem_event,
    _needs_recovery_event,
    _sync_icmp,
    _sync_tcp,
    _sync_dns,
    _sync_http,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

def _probe(probe_type="icmp", target="10.0.0.1", port=None, interval_secs=300,
           timeout_secs=5, http_method="GET", expected_status=None,
           dns_record_type="A") -> MagicMock:
    p = MagicMock()
    p.probe_type      = probe_type
    p.target          = target
    p.port            = port
    p.http_method     = http_method
    p.expected_status = expected_status
    p.dns_record_type = dns_record_type
    p.interval_secs   = interval_secs
    p.timeout_secs    = timeout_secs
    return p


def _result(success: bool, measured_at=None) -> MagicMock:
    r = MagicMock()
    r.success     = success
    r.measured_at = measured_at or datetime.now(timezone.utc)
    return r


def _now():
    return datetime.now(timezone.utc)


# ══════════════════════════════════════════════════════════════════════════════
# 1. _probe_event_type
# ══════════════════════════════════════════════════════════════════════════════

def test_event_type_icmp():
    et, comp = _probe_event_type(_probe("icmp"))
    assert et   == "device_unreachable"
    assert comp == "device"


def test_event_type_tcp():
    et, comp = _probe_event_type(_probe("tcp", port=443))
    assert et   == "port_down"
    assert comp == "tcp:443"


def test_event_type_tcp_default_port():
    et, comp = _probe_event_type(_probe("tcp", port=None))
    assert comp == "tcp:80"


def test_event_type_http():
    et, comp = _probe_event_type(_probe("http", target="http://10.0.0.1"))
    assert et   == "service_unavailable"
    assert "http" in comp


def test_event_type_dns():
    et, comp = _probe_event_type(_probe("dns", target="example.local"))
    assert et   == "dns_failure"
    assert "dns" in comp


# ══════════════════════════════════════════════════════════════════════════════
# 2. _probe_severity
# ══════════════════════════════════════════════════════════════════════════════

def test_severity_icmp_is_critical():
    assert _probe_severity("icmp") == "critical"


def test_severity_tcp_is_critical():
    assert _probe_severity("tcp") == "critical"


def test_severity_http_is_warning():
    assert _probe_severity("http") == "warning"


def test_severity_dns_is_warning():
    assert _probe_severity("dns") == "warning"


# ══════════════════════════════════════════════════════════════════════════════
# 3. _probe_kwargs
# ══════════════════════════════════════════════════════════════════════════════

def test_probe_kwargs_icmp_empty():
    assert _probe_kwargs(_probe("icmp")) == {}


def test_probe_kwargs_tcp_includes_port():
    kw = _probe_kwargs(_probe("tcp", port=8080))
    assert kw == {"port": 8080}


def test_probe_kwargs_tcp_defaults_to_80():
    kw = _probe_kwargs(_probe("tcp", port=None))
    assert kw == {"port": 80}


def test_probe_kwargs_http():
    kw = _probe_kwargs(_probe("http", target="http://x", http_method="HEAD",
                              expected_status=200))
    assert kw["url"]             == "http://x"
    assert kw["http_method"]     == "HEAD"
    assert kw["expected_status"] == 200


def test_probe_kwargs_http_default_status():
    kw = _probe_kwargs(_probe("http", expected_status=None))
    assert kw["expected_status"] == 200


def test_probe_kwargs_dns():
    kw = _probe_kwargs(_probe("dns", dns_record_type="AAAA"))
    assert kw == {"dns_record_type": "AAAA"}


# ══════════════════════════════════════════════════════════════════════════════
# 4. _should_run
# ══════════════════════════════════════════════════════════════════════════════

def test_should_run_no_previous():
    assert _should_run(_probe(interval_secs=300), None, _now()) is True


def test_should_run_interval_not_elapsed():
    now = _now()
    last = _result(True, measured_at=now - timedelta(seconds=100))
    assert _should_run(_probe(interval_secs=300), last, now) is False


def test_should_run_interval_elapsed():
    now = _now()
    last = _result(True, measured_at=now - timedelta(seconds=400))
    assert _should_run(_probe(interval_secs=300), last, now) is True


def test_should_run_exact_boundary():
    now = _now()
    last = _result(True, measured_at=now - timedelta(seconds=300))
    assert _should_run(_probe(interval_secs=300), last, now) is True


# ══════════════════════════════════════════════════════════════════════════════
# 5. _needs_problem_event
# ══════════════════════════════════════════════════════════════════════════════

def test_problem_event_success_never():
    assert _needs_problem_event(True, None) is False
    assert _needs_problem_event(True, _result(False)) is False


def test_problem_event_first_run_failure():
    assert _needs_problem_event(False, None) is True


def test_problem_event_transition_ok_to_fail():
    assert _needs_problem_event(False, _result(True)) is True


def test_problem_event_already_failing():
    assert _needs_problem_event(False, _result(False)) is False


# ══════════════════════════════════════════════════════════════════════════════
# 6. _needs_recovery_event
# ══════════════════════════════════════════════════════════════════════════════

def test_recovery_event_failure_never():
    assert _needs_recovery_event(False, None) is False
    assert _needs_recovery_event(False, _result(True)) is False


def test_recovery_event_first_run_ok():
    assert _needs_recovery_event(True, None) is False


def test_recovery_event_already_ok():
    assert _needs_recovery_event(True, _result(True)) is False


def test_recovery_event_transition_fail_to_ok():
    assert _needs_recovery_event(True, _result(False)) is True


# ══════════════════════════════════════════════════════════════════════════════
# 7. _sync_icmp
# ══════════════════════════════════════════════════════════════════════════════

class TestSyncIcmp:
    def test_success(self):
        mock_result = MagicMock(returncode=0)
        with patch("subprocess.run", return_value=mock_result):
            r = _sync_icmp("1.1.1.1", 5)
        assert r["success"] is True
        assert r["latency_ms"] is not None
        assert r["detail"] == ""

    def test_host_unreachable(self):
        mock_result = MagicMock(returncode=1)
        with patch("subprocess.run", return_value=mock_result):
            r = _sync_icmp("192.0.2.1", 5)
        assert r["success"] is False
        assert r["detail"] == "host unreachable"

    def test_timeout(self):
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(["ping"], 5)):
            r = _sync_icmp("192.0.2.1", 5)
        assert r["success"] is False
        assert r["detail"] == "timeout"

    def test_ping_not_found(self):
        with patch("subprocess.run", side_effect=FileNotFoundError):
            r = _sync_icmp("1.1.1.1", 5)
        assert r["success"] is False
        assert r["detail"] == "ping not available"


# ══════════════════════════════════════════════════════════════════════════════
# 8. _sync_tcp
# ══════════════════════════════════════════════════════════════════════════════

class TestSyncTcp:
    def test_success(self):
        mock_sock = MagicMock()
        mock_sock.__enter__ = lambda s: s
        mock_sock.__exit__ = MagicMock(return_value=False)
        with patch("socket.create_connection", return_value=mock_sock):
            r = _sync_tcp("1.1.1.1", 80, 5)
        assert r["success"] is True
        assert r["latency_ms"] is not None

    def test_refused(self):
        with patch("socket.create_connection", side_effect=ConnectionRefusedError):
            r = _sync_tcp("1.1.1.1", 12345, 5)
        assert r["success"] is False
        assert r["detail"] == "connection refused"

    def test_timeout(self):
        with patch("socket.create_connection", side_effect=socket.timeout):
            r = _sync_tcp("1.1.1.1", 80, 5)
        assert r["success"] is False
        assert r["detail"] == "timeout"

    def test_oserror(self):
        with patch("socket.create_connection", side_effect=OSError("network down")):
            r = _sync_tcp("1.1.1.1", 80, 5)
        assert r["success"] is False
        assert "network down" in r["detail"]


# ══════════════════════════════════════════════════════════════════════════════
# 9. _sync_dns
# ══════════════════════════════════════════════════════════════════════════════

class TestSyncDns:
    def test_success(self):
        fake_addrs = [("AF_INET", None, None, None, ("1.1.1.1", 0))]
        with patch("socket.getaddrinfo", return_value=fake_addrs):
            r = _sync_dns("example.com")
        assert r["success"] is True
        assert r["latency_ms"] is not None

    def test_nxdomain(self):
        with patch("socket.getaddrinfo",
                   side_effect=socket.gaierror("Name or service not known")):
            r = _sync_dns("nonexistent.invalid")
        assert r["success"] is False
        assert "not known" in r["detail"]

    def test_no_records(self):
        with patch("socket.getaddrinfo", return_value=[]):
            r = _sync_dns("example.com")
        assert r["success"] is False
        assert r["detail"] == "no records"


# ══════════════════════════════════════════════════════════════════════════════
# 10. _sync_http
# ══════════════════════════════════════════════════════════════════════════════

class TestSyncHttp:
    def test_success(self):
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        with patch("urllib.request.urlopen", return_value=mock_resp):
            r = _sync_http("http://1.1.1.1", "GET", 200, 5)
        assert r["success"] is True

    def test_wrong_status(self):
        mock_resp = MagicMock()
        mock_resp.status = 301
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        with patch("urllib.request.urlopen", return_value=mock_resp):
            r = _sync_http("http://1.1.1.1", "GET", 200, 5)
        assert r["success"] is False
        assert "301" in r["detail"]

    def test_http_error_matches_expected(self):
        with patch("urllib.request.urlopen",
                   side_effect=urllib.error.HTTPError(None, 404, "Not Found", {}, None)):
            r = _sync_http("http://x/notfound", "GET", 404, 5)
        assert r["success"] is True

    def test_http_error_mismatch(self):
        with patch("urllib.request.urlopen",
                   side_effect=urllib.error.HTTPError(None, 500, "Error", {}, None)):
            r = _sync_http("http://x", "GET", 200, 5)
        assert r["success"] is False
        assert "500" in r["detail"]

    def test_connection_error(self):
        with patch("urllib.request.urlopen", side_effect=OSError("refused")):
            r = _sync_http("http://192.0.2.1", "GET", 200, 5)
        assert r["success"] is False
        assert "refused" in r["detail"]
