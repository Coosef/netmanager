"""RBAC-SPRINT-2.2B1 — SLA + PoE authorization hardening contract tests.

Follows the Sprint 2.2A test layout. Covers operator scenarios A–K:

  A. SLA read endpoints return 403 without sla:view.
  B. SLA policy CRUD returns 403 without sla:manage_policies.
  C. sla:view alone does NOT grant policy CRUD.
  D. PoE summary + device cache endpoint return 403 without poe:view.
  E. poe:view alone does NOT grant snapshot-now or realtime refresh.
  F. poe:refresh grants access to snapshot-now AND realtime refresh.
  G. org_admin / super_admin retain access (PermissionEngine bypass —
     Phase 1 invariant, exercised by the existing suite).
  H. Tam Yetki / Org Admin migration backfill delivers all 4 new verbs.
  I. Custom sets — explicit false never overwritten.
  J. Malformed JSON fails closed.
  K. PoE realtime endpoint SSH + DB mutation documented via source pin.
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


@pytest.mark.parametrize("module,expected_verbs", [
    ("sla", {"view", "manage_policies"}),
    ("poe", {"view", "refresh"}),
])
def test_default_permissions_new_module_shape(module, expected_verbs):
    block = DEFAULT_PERMISSIONS["modules"][module]
    assert set(block.keys()) == expected_verbs
    for verb, val in block.items():
        assert val is False, f"{module}.{verb} default must be False"


def test_default_permissions_prior_modules_preserved():
    """Sprint 2.2B1 only adds 2 modules; every earlier module must remain
    intact (Phase 1 + Sprint 2.1 + Sprint 2.2A)."""
    modules = DEFAULT_PERMISSIONS["modules"]
    for m in ("devices", "config_backups", "topology", "monitoring",
              "audit_logs", "notifications", "discovery", "vlan",
              "racks", "maps", "config_drift", "security_audit",
              "asset_lifecycle", "terminal_sessions", "mac_arp"):
        assert m in modules, f"{m} regressed"


# ─── 2. Migration pure-function contract ────────────────────────────────


def _load_sprint22b1_migration_module():
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
        / "alembic" / "versions" / "f9ak_sla_poe_authorization.py"
    )
    spec = importlib.util.spec_from_file_location(
        "f9ak_sla_poe_authorization", path,
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def sprint22b1_mig():
    return _load_sprint22b1_migration_module()


def test_sprint22b1_migration_revision_chain(sprint22b1_mig):
    assert sprint22b1_mig.revision == "f9akslapoeauth"
    assert sprint22b1_mig.down_revision == "f9ajauthhard"


# --- H. Tam Yetki / Org Admin opt-in delivers all 4 verbs ---------------


@pytest.mark.parametrize("template_name", ["Tam Yetki", "Org Admin"])
def test_sprint22b1_opt_in_grants_every_verb(sprint22b1_mig, template_name):
    before = {"modules": {}}
    after = sprint22b1_mig._backfill_row(before, template_name)
    assert after["modules"]["sla"] == {"view": True, "manage_policies": True}
    assert after["modules"]["poe"] == {"view": True, "refresh": True}


# --- No view carry-over — Sprint 2.2B1 stripped this rule ---------------


def test_sprint22b1_no_carry_over_from_monitoring_view(sprint22b1_mig):
    """Product decision per operator brief: Sprint 2.2B1 does NOT carry
    over any pre-existing verb (monitoring.view, config.view, etc) to
    sla.view or poe.view. The route still gates on
    RoleRoute(minRole=org_admin) so no location_admin can reach the
    page today; the org_admin PermissionEngine bypass handles current
    org_admin access."""
    before = {"modules": {"monitoring": {"view": True}}}
    after = sprint22b1_mig._backfill_row(before, "Custom Operator Set")
    assert after["modules"]["sla"] == {"view": False, "manage_policies": False}
    assert after["modules"]["poe"] == {"view": False, "refresh": False}


def test_sprint22b1_no_carry_over_from_config_view(sprint22b1_mig):
    before = {"modules": {"config": {"view": True}}}
    after = sprint22b1_mig._backfill_row(before, "Some Set")
    assert after["modules"]["sla"] == {"view": False, "manage_policies": False}
    assert after["modules"]["poe"] == {"view": False, "refresh": False}


# --- I. Existing explicit values ALWAYS win ---------------------------


def test_sprint22b1_existing_false_never_overwritten(sprint22b1_mig):
    """Tam Yetki + explicit sla.view=false → view stays FALSE."""
    before = {
        "modules": {
            "sla": {"view": False, "manage_policies": False},
        }
    }
    after = sprint22b1_mig._backfill_row(before, "Tam Yetki")
    assert after["modules"]["sla"]["view"] is False
    assert after["modules"]["sla"]["manage_policies"] is False
    # poe still opts in (name-based) — the block is missing
    assert after["modules"]["poe"] == {"view": True, "refresh": True}


def test_sprint22b1_partial_existing_wins(sprint22b1_mig):
    """poe.view=false explicit; poe.refresh missing → refresh follows opt-in default."""
    before = {"modules": {"poe": {"view": False}}}
    after = sprint22b1_mig._backfill_row(before, "Tam Yetki")
    assert after["modules"]["poe"]["view"] is False
    assert after["modules"]["poe"]["refresh"] is True


# --- J. Malformed rows fail closed regardless of opt-in ---------------


def test_sprint22b1_malformed_module_block_fails_closed(sprint22b1_mig):
    """Non-dict module value → all False, ignore default."""
    after = sprint22b1_mig._backfill_module_block(
        "not-a-dict", ("view", "refresh"), True,
    )
    assert after == {"view": False, "refresh": False}


def test_sprint22b1_none_module_uses_default(sprint22b1_mig):
    """None (module absent pre-migration) → follow opt-in default."""
    after_true = sprint22b1_mig._backfill_module_block(
        None, ("view", "manage_policies"), True,
    )
    assert after_true == {"view": True, "manage_policies": True}
    after_false = sprint22b1_mig._backfill_module_block(
        None, ("view", "manage_policies"), False,
    )
    assert after_false == {"view": False, "manage_policies": False}


# --- Idempotency + downgrade -----------------------------------------


def test_sprint22b1_backfill_idempotent(sprint22b1_mig):
    before = {"modules": {"devices": {"view": True}}}
    once = sprint22b1_mig._backfill_row(before, "Tam Yetki")
    twice = sprint22b1_mig._backfill_row(once, "Tam Yetki")
    assert once == twice


def test_sprint22b1_downgrade_removes_new_modules(sprint22b1_mig):
    before = {"modules": {"devices": {"view": True}, "topology": {"view": True}}}
    upgraded = sprint22b1_mig._backfill_row(before, "Tam Yetki")
    assert "sla" in upgraded["modules"] and "poe" in upgraded["modules"]
    downgraded = sprint22b1_mig._downgrade_row(upgraded)
    assert "sla" not in downgraded["modules"]
    assert "poe" not in downgraded["modules"]
    assert downgraded["modules"]["devices"] == {"view": True}
    assert downgraded["modules"]["topology"] == {"view": True}


# ─── 3. Provisioner presets ────────────────────────────────────────────


def test_viewer_preset_grants_only_view_across_new_modules():
    p = _viewer_permissions()["modules"]
    assert p["sla"]["view"] is True
    assert p["sla"]["manage_policies"] is False
    assert p["poe"]["view"] is True
    assert p["poe"]["refresh"] is False


def test_operator_preset_leaves_new_modules_at_default_false():
    """Operatör preset explicitly enumerates a small grant list; sla + poe
    are NOT in it, so both stay at default False."""
    p = _operator_permissions()["modules"]
    assert p["sla"] == {"view": False, "manage_policies": False}
    assert p["poe"] == {"view": False, "refresh": False}


def test_full_preset_grants_every_new_verb():
    p = _full_permissions()["modules"]
    assert p["sla"] == {"view": True, "manage_policies": True}
    assert p["poe"] == {"view": True, "refresh": True}


# ─── 4. Endpoint source-grep contracts ─────────────────────────────────


def _read(name: str) -> str:
    path = (
        Path(__file__).resolve().parent.parent
        / "app" / "api" / "v1" / "endpoints" / name
    )
    return path.read_text(encoding="utf-8")


def test_sla_endpoint_gate_counts():
    """5 view + 3 manage_policies gate call sites."""
    src = _read("sla.py")
    view_hits = src.count("_require_sla_view(current_user)")
    manage_hits = src.count("_require_sla_manage_policies(current_user)")
    assert view_hits == 5, f"expected 5 view gates, found {view_hits}"
    assert manage_hits == 3, f"expected 3 manage_policies gates, found {manage_hits}"


def test_poe_endpoint_gate_counts():
    """2 view + 2 refresh gate call sites."""
    src = _read("poe.py")
    view_hits = src.count("_require_poe_view(current_user)")
    refresh_hits = src.count("_require_poe_refresh(current_user)")
    assert view_hits == 2, f"expected 2 view gates, found {view_hits}"
    assert refresh_hits == 2, f"expected 2 refresh gates, found {refresh_hits}"


def test_no_underscore_current_user_leftovers_in_touched_files():
    for name in ("sla.py", "poe.py"):
        src = _read(name)
        assert "\n    _: CurrentUser," not in src, (
            f"{name} has a leftover `_: CurrentUser,` param"
        )


# --- K. PoE realtime endpoint documented as mutating -------------------


def test_poe_realtime_endpoint_documents_ssh_and_db_mutation():
    """The `GET /devices/{device_id}/realtime` endpoint executes SSH
    and writes back to PoEPortSnapshot. The gate call comment MUST
    document this so a future contributor doesn't refactor the gate
    to poe:view based on the HTTP verb alone."""
    src = _read("poe.py")
    # The endpoint decorator + gate must both be present.
    assert '@router.get("/devices/{device_id}/realtime")' in src
    assert "_require_poe_refresh(current_user)" in src
    # The mutation warning MUST appear in the file (comment block at
    # the top of the module OR in the docstring).
    assert (
        "SSH-mutation endpoint" in src
        or "MUTATING endpoint" in src
        or "opens an SSH session" in src
    ), "poe.py must document that GET /realtime is a mutating endpoint"


def test_poe_realtime_and_snapshot_share_refresh_verb():
    """poe:refresh MUST gate BOTH endpoints (snapshot-now Celery +
    realtime SSH mutation) — a caller with only poe:view can trigger
    neither."""
    src = _read("poe.py")
    # snapshot-now decorator + gate call
    assert '@router.post("/snapshot-now"' in src
    # Both endpoints call _require_poe_refresh
    # (count already validated in test_poe_endpoint_gate_counts;
    #  here we assert POSITIONING — the gate call appears before
    #  the SSH import in the realtime endpoint)
    realtime_start = src.find('async def get_device_poe_realtime')
    assert realtime_start != -1
    tail = src[realtime_start:realtime_start + 1500]
    gate_pos = tail.find("_require_poe_refresh(current_user)")
    ssh_import_pos = tail.find("from app.services.ssh_manager import ssh_manager")
    assert 0 < gate_pos < ssh_import_pos, (
        "poe:refresh gate MUST fire before the SSH manager import in the realtime endpoint"
    )


# ─── 5. Gate helper simulation — A/B/C/D/E/F scenarios ────────────────


class _FakeUser:
    def __init__(self, grants: set[str] | None = None):
        self._grants = grants or set()

    def has_permission(self, verb: str) -> bool:
        return verb in self._grants


def _import_helpers():
    import importlib
    return {
        "sla": importlib.import_module("app.api.v1.endpoints.sla"),
        "poe": importlib.import_module("app.api.v1.endpoints.poe"),
    }


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


# --- A. SLA read endpoints require sla:view ---------------------------


def test_A_sla_view_gate_403_without_permission(helpers):
    _expect_403(helpers["sla"]._require_sla_view, _FakeUser(), "sla.view")


# --- B. SLA policy CRUD requires sla:manage_policies ------------------


def test_B_sla_manage_policies_gate_403_without_permission(helpers):
    _expect_403(helpers["sla"]._require_sla_manage_policies,
                _FakeUser(), "sla.manage_policies")


# --- C. sla:view alone does NOT grant manage_policies -----------------


def test_C_sla_view_isolates_from_manage_policies(helpers):
    user = _FakeUser({"sla:view"})
    _expect_pass(helpers["sla"]._require_sla_view, user)
    _expect_403(helpers["sla"]._require_sla_manage_policies,
                user, "sla.manage_policies")


# --- D. PoE view endpoints require poe:view ---------------------------


def test_D_poe_view_gate_403_without_permission(helpers):
    _expect_403(helpers["poe"]._require_poe_view, _FakeUser(), "poe.view")


# --- E. poe:view alone does NOT grant refresh -------------------------


def test_E_poe_view_isolates_from_refresh(helpers):
    user = _FakeUser({"poe:view"})
    _expect_pass(helpers["poe"]._require_poe_view, user)
    _expect_403(helpers["poe"]._require_poe_refresh, user, "poe.refresh")


# --- F. poe:refresh grants access to both snapshot AND realtime -------


def test_F_poe_refresh_grants_access(helpers):
    """The refresh gate is a single verb — it protects BOTH
    POST /snapshot-now AND GET /devices/{id}/realtime. Granting
    poe:refresh alone (without poe:view) still passes the refresh
    gate; view endpoints stay locked (correct isolation)."""
    user = _FakeUser({"poe:refresh"})
    _expect_pass(helpers["poe"]._require_poe_refresh, user)
    # Verify strict isolation the OTHER way — refresh alone does not
    # grant view (asymmetric-permission contract):
    _expect_403(helpers["poe"]._require_poe_view, user, "poe.view")


# --- Positive path — both verbs granted ------------------------------


def test_both_verbs_granted_passes_all_helpers(helpers):
    sla_user = _FakeUser({"sla:view", "sla:manage_policies"})
    _expect_pass(helpers["sla"]._require_sla_view, sla_user)
    _expect_pass(helpers["sla"]._require_sla_manage_policies, sla_user)
    poe_user = _FakeUser({"poe:view", "poe:refresh"})
    _expect_pass(helpers["poe"]._require_poe_view, poe_user)
    _expect_pass(helpers["poe"]._require_poe_refresh, poe_user)
