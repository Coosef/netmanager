"""
T8.3.1 UI API cleanup — regression guard for FastAPI route-shadowing.

Starlette matches routes in declaration order. A single-segment static
route (e.g. GET /health-scores, PATCH /bulk-tag) declared AFTER the
parameterized single-segment catch-all of the SAME method (GET/PATCH/...
/{device_id}) never gets reached: the request binds to /{device_id}
first and 422s trying to parse the static segment as an int.

This bit three real endpoints (all frontend-called):
  * GET   /devices/health-scores      → 422 int_parsing
  * PATCH /devices/bulk-tag           → 422 int_parsing
  * GET   /snmp/top-interfaces        (separate ceiling bug, see below)

The router imports without a DB connection (conftest pins SQLite env),
so this is a pure, fast structural assertion — no app stand-up needed.
"""
import inspect

import pytest


def _single_segment_routes(router):
    """(method, path, index) for every single-path-segment route."""
    out = []
    for i, r in enumerate(router.routes):
        path = getattr(r, "path", "")
        segments = [s for s in path.strip("/").split("/") if s]
        if len(segments) != 1:
            continue
        for method in sorted(getattr(r, "methods", set()) or set()):
            if method in ("HEAD", "OPTIONS"):
                continue
            out.append((method, path, i))
    return out


def _assert_static_before_param(router, router_name):
    """Every static single-segment route must precede the /{param} catch-all
    of the same HTTP method."""
    routes = _single_segment_routes(router)
    # First parameterized single-segment route index, per method.
    param_first: dict[str, int] = {}
    for method, path, idx in routes:
        if path.startswith("/{"):
            param_first.setdefault(method, idx)

    offenders = []
    for method, path, idx in routes:
        if path.startswith("/{"):
            continue
        catch_all = param_first.get(method)
        if catch_all is not None and idx > catch_all:
            offenders.append(f"{method} {path} (idx {idx}) shadowed by "
                             f"{method} /{{...}} (idx {catch_all}) in {router_name}")
    assert not offenders, (
        "Static routes declared after a same-method /{param} catch-all will "
        "422 on int_parsing. Move them above the catch-all:\n  "
        + "\n  ".join(offenders)
    )


def test_devices_router_static_routes_precede_param_catchall():
    from app.api.v1.endpoints.devices import router
    _assert_static_before_param(router, "devices")


def test_health_scores_resolves_to_its_own_route():
    """The exact endpoint that regressed — pin it explicitly."""
    from app.api.v1.endpoints.devices import router, get_health_scores
    hs = next((r for r in router.routes if getattr(r, "path", "") == "/health-scores"), None)
    assert hs is not None, "/health-scores route missing"
    assert hs.endpoint is get_health_scores
    # And it must come before the GET /{device_id} catch-all.
    idx_hs = router.routes.index(hs)
    idx_param = next(i for i, r in enumerate(router.routes)
                     if getattr(r, "path", "") == "/{device_id}" and "GET" in (r.methods or set()))
    assert idx_hs < idx_param, "/health-scores must precede GET /{device_id}"


def test_bulk_tag_precedes_patch_param_catchall():
    from app.api.v1.endpoints.devices import router
    idx_bulk = next((i for i, r in enumerate(router.routes)
                     if getattr(r, "path", "") == "/bulk-tag"), None)
    assert idx_bulk is not None, "/bulk-tag route missing"
    idx_param = next((i for i, r in enumerate(router.routes)
                      if getattr(r, "path", "") == "/{device_id}" and "PATCH" in (r.methods or set())), None)
    assert idx_param is not None, "PATCH /{device_id} route missing"
    assert idx_bulk < idx_param, "PATCH /bulk-tag must precede PATCH /{device_id}"


def test_snmp_top_interfaces_limit_ceiling_admits_500():
    """The Racks/Devices views request limit=500 with threshold=0; the old
    le=100 rejected them with 422 less_than_equal. Assert the ceiling is at
    least 500 by introspecting the Query constraint on the endpoint."""
    from app.api.v1.endpoints.snmp import top_interfaces
    sig = inspect.signature(top_interfaces)
    limit_default = sig.parameters["limit"].default
    # FastAPI Query() default object — find its upper-bound constraint across
    # FastAPI/pydantic versions (direct attr, or annotated_types metadata).
    le = getattr(limit_default, "le", None)
    if le is None:
        for m in getattr(limit_default, "metadata", []) or []:
            le = getattr(m, "le", None)
            if le is not None:
                break
    assert le is not None, "could not introspect 'limit' le constraint"
    assert le >= 500, f"top-interfaces limit ceiling {le} < 500 — frontend sends 500"
