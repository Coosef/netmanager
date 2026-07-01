"""RBAC-SPRINT-2.2B2 — Services authorization hardening contract tests.

Follows the Sprint 2.2B1 test layout. Covers operator scenarios A–J:

  A. services:view empty → every GET endpoint 403
  B. services:manage empty → every mutating (POST/PATCH/DELETE) 403
  C. services:view alone does NOT grant manage
  D. services:manage alone does NOT grant view
  E. Both verbs granted → correct endpoints pass
  F. org_admin / super_admin retain access (PermissionEngine bypass —
     Phase 1 invariant, exercised by the existing suite)
  G. Tam Yetki / Org Admin migration backfill delivers both verbs
  H. Custom set — explicit false never overwritten
  I. Malformed JSON fails closed
  J. Source-grep pin — services.py has NO legacy auth-only endpoint
     (every endpoint calls one of the two inline gate helpers at the
      start of its body)
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from typing import Callable

import pytest

from app.models.shared.permission_set import DEFAULT_PERMISSIONS
from app.services.rbac.provisioner import (
    _full_permissions,
    _operator_permissions,
    _viewer_permissions,
)


# ─── 1. DEFAULT_PERMISSIONS schema ────────────────────────────────────────


def test_default_permissions_services_block():
    services = DEFAULT_PERMISSIONS["modules"]["services"]
    assert set(services.keys()) == {"view", "manage"}
    for verb, val in services.items():
        assert val is False, f"services.{verb} default must be False"


def test_default_permissions_prior_modules_preserved():
    """Sprint 2.2B2 only adds 1 module; every earlier module must
    remain intact (Phase 1 + Sprint 2.1 + Sprint 2.2A + Sprint 2.2B1)."""
    modules = DEFAULT_PERMISSIONS["modules"]
    for m in ("devices", "config_backups", "topology", "monitoring",
              "audit_logs", "notifications", "discovery", "vlan",
              "racks", "maps", "config_drift", "security_audit",
              "asset_lifecycle", "terminal_sessions", "mac_arp",
              "sla", "poe"):
        assert m in modules, f"{m} regressed"


# ─── 2. Migration pure-function contract ────────────────────────────────


def _load_sprint22b2_migration_module():
    import sys
    import types
    if "alembic" not in sys.modules:
        sys.modules["alembic"] = types.ModuleType("alembic")
    sys.modules["alembic"].op = SimpleNamespace(
        add_column=lambda *a, **kw: None,
        drop_column=lambda *a, **kw: None,
        get_bind=lambda: None,
    )
    path = (
        Path(__file__).resolve().parent.parent
        / "alembic" / "versions" / "f9al_services_authorization.py"
    )
    spec = importlib.util.spec_from_file_location(
        "f9al_services_authorization", path,
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def sprint22b2_mig():
    return _load_sprint22b2_migration_module()


def test_sprint22b2_migration_revision_chain(sprint22b2_mig):
    assert sprint22b2_mig.revision == "f9alservicesauth"
    assert sprint22b2_mig.down_revision == "f9akslapoeauth"


# --- G. Tam Yetki / Org Admin opt-in delivers both verbs ------------


@pytest.mark.parametrize("template_name", ["Tam Yetki", "Org Admin"])
def test_sprint22b2_opt_in_grants_both_verbs(sprint22b2_mig, template_name):
    before = {"modules": {}}
    after = sprint22b2_mig._backfill_row(before, template_name)
    assert after["modules"]["services"] == {"view": True, "manage": True}


# --- No view carry-over — Sprint 2.2B2 stripped this rule -----------


def test_sprint22b2_no_carry_over_from_monitoring_view(sprint22b2_mig):
    """Product decision per operator brief: Sprint 2.2B2 does NOT
    carry over monitoring.view or any pre-existing verb to
    services.view. Services model has no location_id column so
    location-scoped delegation isn't possible today; the route
    still gates on RoleRoute(minRole="org_admin"). Custom sets stay
    at safe FALSE default."""
    before = {"modules": {"monitoring": {"view": True}}}
    after = sprint22b2_mig._backfill_row(before, "Custom Operator Set")
    assert after["modules"]["services"] == {"view": False, "manage": False}


def test_sprint22b2_no_carry_over_from_config_view(sprint22b2_mig):
    before = {"modules": {"config": {"view": True}}}
    after = sprint22b2_mig._backfill_row(before, "Some Set")
    assert after["modules"]["services"] == {"view": False, "manage": False}


# --- H. Existing explicit values ALWAYS win -------------------------


def test_sprint22b2_existing_false_never_overwritten(sprint22b2_mig):
    """Tam Yetki + explicit services.view=false → view stays FALSE
    (idempotency contract)."""
    before = {
        "modules": {
            "services": {"view": False, "manage": False},
        }
    }
    after = sprint22b2_mig._backfill_row(before, "Tam Yetki")
    assert after["modules"]["services"]["view"] is False
    assert after["modules"]["services"]["manage"] is False


def test_sprint22b2_partial_existing_wins(sprint22b2_mig):
    """services.view=true explicit; services.manage missing → manage
    follows opt-in default."""
    before = {"modules": {"services": {"view": True}}}
    after = sprint22b2_mig._backfill_row(before, "Tam Yetki")
    assert after["modules"]["services"]["view"] is True
    assert after["modules"]["services"]["manage"] is True


# --- I. Malformed rows fail closed regardless of opt-in -------------


def test_sprint22b2_malformed_module_block_fails_closed(sprint22b2_mig):
    """Non-dict module value → all False, ignore default."""
    after = sprint22b2_mig._backfill_module_block(
        "not-a-dict", ("view", "manage"), True,
    )
    assert after == {"view": False, "manage": False}


def test_sprint22b2_none_module_uses_default(sprint22b2_mig):
    after_true = sprint22b2_mig._backfill_module_block(
        None, ("view", "manage"), True,
    )
    assert after_true == {"view": True, "manage": True}
    after_false = sprint22b2_mig._backfill_module_block(
        None, ("view", "manage"), False,
    )
    assert after_false == {"view": False, "manage": False}


# --- Idempotency + downgrade -----------------------------------------


def test_sprint22b2_backfill_idempotent(sprint22b2_mig):
    before = {"modules": {"devices": {"view": True}}}
    once = sprint22b2_mig._backfill_row(before, "Tam Yetki")
    twice = sprint22b2_mig._backfill_row(once, "Tam Yetki")
    assert once == twice


def test_sprint22b2_downgrade_removes_new_module(sprint22b2_mig):
    before = {"modules": {"devices": {"view": True}, "topology": {"view": True}}}
    upgraded = sprint22b2_mig._backfill_row(before, "Tam Yetki")
    assert "services" in upgraded["modules"]
    downgraded = sprint22b2_mig._downgrade_row(upgraded)
    assert "services" not in downgraded["modules"]
    assert downgraded["modules"]["devices"] == {"view": True}
    assert downgraded["modules"]["topology"] == {"view": True}


# ─── 3. Provisioner presets ────────────────────────────────────────────


def test_viewer_preset_grants_only_view():
    p = _viewer_permissions()["modules"]
    assert p["services"]["view"] is True
    assert p["services"]["manage"] is False


def test_operator_preset_leaves_services_at_default_false():
    """Operatör preset explicitly enumerates a small grant list;
    services is NOT in it, so both stay at default False."""
    p = _operator_permissions()["modules"]
    assert p["services"] == {"view": False, "manage": False}


def test_full_preset_grants_both_verbs():
    p = _full_permissions()["modules"]
    assert p["services"] == {"view": True, "manage": True}


# ─── 4. Endpoint source-grep contracts ─────────────────────────────────


def _read_services_source() -> str:
    path = (
        Path(__file__).resolve().parent.parent
        / "app" / "api" / "v1" / "endpoints" / "services.py"
    )
    return path.read_text(encoding="utf-8")


def test_services_endpoint_gate_counts():
    """4 view + 3 manage gate call sites (per operator brief endpoint
    map)."""
    src = _read_services_source()
    view_hits = src.count("_require_services_view(current_user)")
    manage_hits = src.count("_require_services_manage(current_user)")
    assert view_hits == 4, f"expected 4 view gates, found {view_hits}"
    assert manage_hits == 3, f"expected 3 manage gates, found {manage_hits}"


# --- J. NO legacy auth-only endpoint remains ------------------------


def test_services_no_underscore_current_user_leftovers():
    """Every endpoint MUST use the named `current_user: CurrentUser`
    param so the gate helper can access it. A leftover `_: CurrentUser`
    would silently leave that endpoint auth-only."""
    src = _read_services_source()
    assert "\n    _: CurrentUser," not in src, (
        "services.py has a leftover `_: CurrentUser,` param — the "
        "gate helper cannot access it"
    )


def test_services_every_endpoint_has_a_gate_call():
    """Every @router. decorator in services.py MUST be followed by an
    async def whose body contains one of the two gate helper calls.
    Regression pin against a future PR that adds a new endpoint
    without wiring the gate."""
    src = _read_services_source()
    # Count `@router.<method>(` occurrences (endpoint decorators)
    endpoint_decorators = (
        src.count('@router.get("')
        + src.count('@router.post("')
        + src.count('@router.patch("')
        + src.count('@router.delete("')
        + src.count('@router.put("')
    )
    gate_calls = (
        src.count("_require_services_view(current_user)")
        + src.count("_require_services_manage(current_user)")
    )
    # Every endpoint must be paired with exactly one gate call.
    assert endpoint_decorators == gate_calls, (
        f"expected endpoint decorators == gate calls; found "
        f"{endpoint_decorators} decorators, {gate_calls} gates. "
        f"Some endpoint is legacy auth-only or double-gated."
    )


# ─── 5. Gate helper simulation — A/B/C/D/E scenarios ──────────────────


class _FakeUser:
    def __init__(self, grants: set[str] | None = None):
        self._grants = grants or set()

    def has_permission(self, verb: str) -> bool:
        return verb in self._grants


def _import_helpers():
    import importlib
    return importlib.import_module("app.api.v1.endpoints.services")


@pytest.fixture(scope="module")
def helpers():
    return _import_helpers()


def _expect_403(fn: Callable, user: _FakeUser, verb: str) -> None:
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        fn(user)
    assert ei.value.status_code == 403
    assert verb in ei.value.detail


def _expect_pass(fn: Callable, user: _FakeUser) -> None:
    assert fn(user) is None


# --- A. GETs require services:view -----------------------------------


def test_A_services_view_gate_403_without_permission(helpers):
    _expect_403(helpers._require_services_view, _FakeUser(), "services.view")


# --- B. Mutating endpoints require services:manage ------------------


def test_B_services_manage_gate_403_without_permission(helpers):
    _expect_403(helpers._require_services_manage, _FakeUser(), "services.manage")


# --- C. services:view alone does NOT grant manage -------------------


def test_C_services_view_isolates_from_manage(helpers):
    user = _FakeUser({"services:view"})
    _expect_pass(helpers._require_services_view, user)
    _expect_403(helpers._require_services_manage, user, "services.manage")


# --- D. services:manage alone does NOT grant view -------------------


def test_D_services_manage_isolates_from_view(helpers):
    """Asymmetric verb contract — manage does not imply view.
    Operators who only need to mutate services (unusual but
    architecturally possible) don't automatically get the read
    surface."""
    user = _FakeUser({"services:manage"})
    _expect_pass(helpers._require_services_manage, user)
    _expect_403(helpers._require_services_view, user, "services.view")


# --- E. Both verbs granted → both pass ------------------------------


def test_E_both_verbs_granted_passes_all_helpers(helpers):
    user = _FakeUser({"services:view", "services:manage"})
    _expect_pass(helpers._require_services_view, user)
    _expect_pass(helpers._require_services_manage, user)
