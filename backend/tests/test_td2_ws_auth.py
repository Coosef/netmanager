"""TD-2 — WebSocket auth dependency regression.

Bug: agents.router `dependencies=_feat("agents")` (→ require_feature →
get_current_active_user → oauth2_scheme, HTTP-only OAuth2PasswordBearer) ile
include ediliyordu. Bu router-seviyesi user-auth dependency, router'daki
WebSocket route'a (`/agents/ws/{agent_id}`) da uygulanıyor; WS scope'ta
`OAuth2PasswordBearer.__call__(request=...)` çözülürken `request` argümanı
bulunamayıp 5xx üretiyordu (agent WS connect → 500, traceback).

Fix: agent WS, agent_key ile kimlik doğrular (user oturumu değil) → ayrı
`agent_ws_router`'da, GATE'SİZ include edilir. WS endpoint'lerine HTTP
user-auth dependency uygulanmamalı.

Bu testler DB/Redis gerektirmez: route dependency ağacını introspect eder +
ws.py'nin token'sız/invalid-token controlled-close davranışını TestClient ile
doğrular. "valid token → bağlantı başarılı" gerçek-stack canlı doğrulamasında
ele alınır (gerçek JWT + user + Redis pubsub gerekir).
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api.v1.router import api_router
from app.core.deps import oauth2_scheme, get_current_active_user, get_current_user


def _build_app() -> FastAPI:
    # Bare app — app.main lifespan'ı (default admin / RLS / DB connect)
    # çalıştırmadan yalnız route grafiğini kurar.
    app = FastAPI()
    app.include_router(api_router, prefix="/api/v1")
    return app


def _collect_dependency_calls(dependant) -> list:
    """Bir route'un Dependant ağacını recursive gez, tüm `.call` callable'larını topla."""
    out = []
    for sub in dependant.dependencies:
        out.append(sub.call)
        out.extend(_collect_dependency_calls(sub))
    return out


def _route_has_user_auth(route) -> bool:
    """Route'un dependency zincirinde HTTP user-auth (oauth2_scheme /
    get_current_user[/active]) var mı?"""
    dep = getattr(route, "dependant", None)
    assert dep is not None, f"route {getattr(route,'path','?')} has no dependant"
    calls = _collect_dependency_calls(dep)
    return any(
        c is oauth2_scheme or c is get_current_active_user or c is get_current_user
        for c in calls
    )


def _find_route(app, path, *, method=None):
    for r in app.routes:
        if getattr(r, "path", None) != path:
            continue
        if method is None:
            return r
        if method in (getattr(r, "methods", None) or set()):
            return r
    return None


@pytest.fixture(scope="module")
def app():
    return _build_app()


# ── Dependency-introspection (asıl regresyon koruması) ─────────────────────

def test_agent_ws_has_no_user_auth_dependency(app):
    """Agent WS route'u HTTP user-auth (oauth2_scheme) dependency'si TAŞIMAMALI.
    Taşırsa WS scope'ta 5xx döner (TD-2'nin ta kendisi)."""
    route = _find_route(app, "/api/v1/agents/ws/{agent_id}")
    assert route is not None, "agent WS route kayıtlı değil"
    assert _route_has_user_auth(route) is False, (
        "REGRESYON: agent WS route'una HTTP user-auth dependency uygulanmış — "
        "WS scope'ta oauth2_scheme 5xx üretir (TD-2)."
    )


def test_ws_py_routes_have_no_user_auth_dependency(app):
    """ws.py altındaki tüm WS route'ları Query-token ile auth eder; HTTP
    user-auth dependency taşımamalı."""
    for path in (
        "/api/v1/ws/events",
        "/api/v1/ws/anomalies",
        "/api/v1/ws/tasks/{task_id}",
        "/api/v1/ws/ssh/{device_id}",
    ):
        route = _find_route(app, path)
        assert route is not None, f"{path} kayıtlı değil"
        assert _route_has_user_auth(route) is False, f"{path} WS scope'ta user-auth taşıyor"


def test_agents_http_routes_still_feature_gated(app):
    """Fix, HTTP agents route'larının feature-gate + auth'unu BOZMAMALI."""
    route = _find_route(app, "/api/v1/agents/", method="GET")
    assert route is not None, "GET /agents/ route'u yok"
    assert _route_has_user_auth(route) is True, (
        "HTTP agents endpoint'i artık user-auth taşımıyor — feature-gate/auth bozulmuş."
    )


# ── Davranış: token yok / invalid token → controlled close (5xx DEĞİL) ─────

def test_ws_events_no_token_controlled_close(app):
    """Token'sız /ws/events bağlantısı kontrollü kapanmalı (5xx değil).
    Bu yol DB'ye gitmeden 4001 ile kapanır."""
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/api/v1/ws/events"):
            pass
    assert exc.value.code == 4001


def test_ws_events_invalid_token_controlled_close(app):
    """Geçersiz token ile /ws/events kontrollü kapanmalı (4001), 5xx değil."""
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/api/v1/ws/events?token=invalid.jwt.token"):
            pass
    assert exc.value.code == 4001


# ── HTTP routes etkilenmez ─────────────────────────────────────────────────

def test_http_agents_requires_auth(app):
    """Auth'suz GET /agents/ → 401 (HTTP gate/auth bozulmadı)."""
    client = TestClient(app)
    resp = client.get("/api/v1/agents/")
    assert resp.status_code == 401
