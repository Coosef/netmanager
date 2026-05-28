"""
T10 Faz B4.1 — log_category processor + redaction sertleştirme.

Yaklaşım A (tag + route): tek stdout/structured JSON korunur; her kayda
logger isminden `log_category` eklenir (downstream aggregator ayrıştırır).
Redaction: key-bazlı (Authorization/Cookie/Bearer/token/secret/…) + değer
içi Bearer/JWT maskesi. IP maskelenmez (güvenlik analizi için tutulur).

Processor'lar saf fonksiyon → DB/stack gerektirmez.
"""
from app.core.logging_config import (
    _add_log_category, _drop_sensitive, _log_category, _mask_token_values,
)


# ── log_category ─────────────────────────────────────────────────────────────

def test_log_category_mapping():
    assert _log_category("netmanager.http") == "access"
    assert _log_category("uvicorn.access") == "access"
    assert _log_category("netmanager.health") == "health"
    assert _log_category("netmanager.ws") == "ws"
    assert _log_category("netmanager.security") == "security"
    assert _log_category("netmanager.tenant_audit") == "audit"
    assert _log_category("netmanager.audit") == "audit"
    assert _log_category("netmanager.celery") == "task"
    assert _log_category("netmanager.task_scope") == "task"
    assert _log_category("sqlalchemy.engine") == "db"
    assert _log_category("celery.worker") == "task"
    assert _log_category("netmanager.poe") == "app"      # eşlenmeyen → app
    assert _log_category("") == "app"


def test_add_log_category_processor():
    ev = _add_log_category(None, None, {"logger": "netmanager.security", "event": "x"})
    assert ev["log_category"] == "security"


def test_add_log_category_respects_explicit():
    # Caller explicit verdiyse override edilmez.
    ev = _add_log_category(None, None, {"logger": "netmanager.http", "log_category": "audit"})
    assert ev["log_category"] == "audit"


# ── key-bazlı redaction ──────────────────────────────────────────────────────

def test_drop_sensitive_redacts_auth_cookie_bearer():
    ev = _drop_sensitive(None, None, {
        "authorization": "Bearer abc", "cookie": "sid=123",
        "set_cookie": "x=y", "bearer_token": "t",
        "password": "p", "access_token": "a", "api_key": "k",
    })
    for k in ("authorization", "cookie", "set_cookie", "bearer_token",
              "password", "access_token", "api_key"):
        assert ev[k] == "[REDACTED]", k


def test_drop_sensitive_keeps_ip_and_safe_fields():
    # IP maskelenmez; güvenlik analizi için tutulur. request_id de korunur.
    ev = _drop_sensitive(None, None, {
        "ip": "10.0.0.9", "client_ip": "1.2.3.4",
        "request_id": "abc-123", "username": "admin", "event": "login",
    })
    assert ev["ip"] == "10.0.0.9"
    assert ev["client_ip"] == "1.2.3.4"
    assert ev["request_id"] == "abc-123"
    assert ev["username"] == "admin"


# ── değer içi token maskesi ──────────────────────────────────────────────────

def test_mask_bearer_in_message_value():
    ev = _mask_token_values(None, None, {
        "event": "auth header: Authorization: Bearer abc123.def-456_GHI",
    })
    assert "Bearer [REDACTED]" in ev["event"]
    assert "abc123.def-456_GHI" not in ev["event"]


def test_mask_jwt_standalone():
    jwt = "eyJhbGciOiJIUzI1Ni19.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4"
    ev = _mask_token_values(None, None, {"event": f"token={jwt}"})
    assert "[REDACTED_JWT]" in ev["event"]
    assert jwt not in ev["event"]


def test_mask_skips_clean_values():
    ev = _mask_token_values(None, None, {
        "event": "user admin logged in from 10.0.0.9", "ip": "10.0.0.9",
    })
    assert ev["event"] == "user admin logged in from 10.0.0.9"
    assert ev["ip"] == "10.0.0.9"
