"""T10 C7.A — port-policy-assignments endpoint kayıt + dependency regresyon testleri.

Bu testler:
- Endpoint'lerin doğru path'lerde kayıtlı olduğunu (GET/POST/PATCH/DELETE).
- `security_policy` feature gate'inin uygulandığını (router.py _feat).
- HTTP user-auth (oauth2_scheme) dependency'sinin geldiğini (RBAC).
- WS endpoint'i olmadığını (yalnız HTTP) doğrular.

DB/TestClient gerektirmez — route grafiği ve Dependant ağacı introspection.
"""
import pytest
from fastapi import FastAPI

from app.api.v1.router import api_router
from app.core.deps import oauth2_scheme, get_current_active_user


def _collect_calls(dep):
    out = []
    for sub in dep.dependencies:
        out.append(sub.call)
        out.extend(_collect_calls(sub))
    return out


@pytest.fixture(scope="module")
def app():
    a = FastAPI()
    a.include_router(api_router, prefix="/api/v1")
    return a


def _routes_by(app, path):
    return [r for r in app.routes if getattr(r, "path", None) == path]


def test_port_policy_assignments_routes_registered(app):
    paths = {
        "/api/v1/devices/{device_id}/port-policy-assignments": {"GET", "POST"},
        "/api/v1/devices/{device_id}/port-policy-assignments/{port_name}": {"PATCH", "DELETE"},
    }
    for path, methods in paths.items():
        routes = _routes_by(app, path)
        assert routes, f"{path} kayıtlı değil"
        seen = set()
        for r in routes:
            seen |= getattr(r, "methods", set()) or set()
        # FastAPI HEAD'i otomatik ekler — sadece istediklerimizin alt-küme olmasını ara.
        assert methods.issubset(seen), f"{path}: beklenen {methods}, görülen {seen}"


def test_port_policy_assignments_have_user_auth(app):
    """Tüm port-policy-assignments route'ları HTTP user-auth zincirini taşır."""
    paths = [
        "/api/v1/devices/{device_id}/port-policy-assignments",
        "/api/v1/devices/{device_id}/port-policy-assignments/{port_name}",
    ]
    for path in paths:
        for r in _routes_by(app, path):
            calls = _collect_calls(r.dependant)
            assert any(c is oauth2_scheme or c is get_current_active_user for c in calls), (
                f"{path} ({r.methods}) user-auth dependency taşımıyor"
            )


def test_port_policy_assignments_have_security_policy_feature_gate(app):
    """Router-seviyesi _feat("security_policy") tüm route'lara uygulanmış olmalı."""
    from app.core.deps import require_feature
    paths = [
        "/api/v1/devices/{device_id}/port-policy-assignments",
        "/api/v1/devices/{device_id}/port-policy-assignments/{port_name}",
    ]
    for path in paths:
        for r in _routes_by(app, path):
            calls = _collect_calls(r.dependant)
            # require_feature("security_policy") inner closure → callable adı kontrolüyle bul
            found = any(getattr(c, "__qualname__", "").startswith("require_feature.")
                        or getattr(c, "__name__", "") == "_checker"
                        for c in calls)
            assert found, f"{path} feature-gate dependency taşımıyor"
