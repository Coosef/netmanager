"""
T10 Faz B4.2 — auth/security event stream (`netmanager.security`).

log_security_event: gerçek-zamanlı güvenlik akışı (SIEM). DB audit_logs'tan
BAĞIMSIZ ve ona paraleldir. result=failure/denied/blocked/error → warning;
success/info → info. IP istekten çıkarılır (maskelenmez). request_id middleware
contextvars ile otomatik korelasyon (burada birim testte yok, canlıda var).

structlog.testing.capture_logs ile emit edilen alanlar doğrulanır.
"""
from structlog.testing import capture_logs

from app.core.security_log import log_security_event


class _FakeReq:
    def __init__(self, host=None, xff=None):
        self.headers = {"x-forwarded-for": xff} if xff else {}
        self.client = type("C", (), {"host": host})() if host else None


def test_login_success_is_info_with_fields():
    with capture_logs() as logs:
        log_security_event("login", result="success", username="admin", user_id=1)
    e = logs[0]
    assert e["event"] == "login"
    assert e["security_event"] == "login"
    assert e["result"] == "success"
    assert e["username"] == "admin"
    assert e["user_id"] == 1
    assert e["log_level"] == "info"


def test_login_failure_is_warning():
    with capture_logs() as logs:
        log_security_event("login", result="failure", username="x", reason="invalid_credentials")
    e = logs[0]
    assert e["log_level"] == "warning"
    assert e["result"] == "failure"
    assert e["reason"] == "invalid_credentials"


def test_denied_and_blocked_are_warning():
    with capture_logs() as logs:
        log_security_event("permission_denied", result="denied", reason="devices.edit")
        log_security_event("login_blocked_ip", result="blocked", username="u", user_id=2)
    assert logs[0]["log_level"] == "warning"
    assert logs[0]["security_event"] == "permission_denied"
    assert logs[1]["log_level"] == "warning"
    assert logs[1]["security_event"] == "login_blocked_ip"


def test_ip_from_request_client():
    with capture_logs() as logs:
        log_security_event("login", result="success", request=_FakeReq(host="10.0.0.9"))
    assert logs[0]["client_ip"] == "10.0.0.9"


def test_ip_xff_takes_priority():
    with capture_logs() as logs:
        log_security_event("login", result="success",
                           request=_FakeReq(host="10.0.0.1", xff="1.2.3.4, 5.6.7.8"))
    assert logs[0]["client_ip"] == "1.2.3.4"


def test_no_request_no_ip_field():
    with capture_logs() as logs:
        log_security_event("logout", result="success", user_id=5)
    assert "client_ip" not in logs[0]
    assert logs[0]["result"] == "success"
