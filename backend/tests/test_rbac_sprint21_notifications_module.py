"""RBAC-SPRINT-2.1 — notifications module + endpoint gate + intelligence
gate contract tests.

Mirrors test_rbac_phase1_feature_module_catalog.py layout. Six scopes:

  1. DEFAULT_PERMISSIONS schema — notifications block present + verbs
     default to False; pre-existing modules did not regress.

  2. Migration pure-function contract — the notifications backfill
     honours (a) approval.review carry-over, (b) Tam Yetki / Org Admin
     opt-in, (c) fail-closed on malformed rows, (d) idempotency,
     (e) never-overwrite existing values, (f) downgrade round-trip.

  3. notifications.py endpoint gates — every gate string in the router
     now matches `notifications:view` (read) or `notifications:manage`
     (mutate); zero `approval:review` references remain in the file.
     Approval verbs are still used LEGITIMATELY in approvals.py and
     devices.py (device.approval_required flow) — those files must
     not have regressed.

  4. intelligence.py endpoint gates — every read endpoint calls
     `_require_monitoring_view(current_user)` at the start of its
     body; the helper is defined and imports `HTTPException`.

  5. Provisioner presets — Tam Yetki emits both notifications verbs
     True; viewer / operator emit only view (viewer) OR nothing
     (operator does not enumerate notifications).

  6. Approvals matrix-only change — approval:view / approval:review
     backend verbs remain unchanged; approvals.py source has no diff
     against pre-Sprint-2.1 (validated via string presence pin).
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from app.models.shared.permission_set import DEFAULT_PERMISSIONS
from app.services.rbac.provisioner import (
    _full_permissions,
    _operator_permissions,
    _viewer_permissions,
)


# ─── 1. DEFAULT_PERMISSIONS schema ────────────────────────────────────────


def test_default_permissions_notifications_block():
    notifications = DEFAULT_PERMISSIONS["modules"]["notifications"]
    assert set(notifications.keys()) == {"view", "manage"}
    for key, value in notifications.items():
        assert value is False, f"notifications.{key} default must be False"


def test_default_permissions_pre_sprint21_modules_preserved():
    """Sprint 2.1 only ADDS one module; Phase 1 + P2-CATALOG-A keys
    must not have regressed."""
    modules = DEFAULT_PERMISSIONS["modules"]
    for k in ("view", "create", "edit", "delete", "ssh", "connect", "move"):
        assert k in modules["devices"], f"devices.{k} regressed"
    for m in ("discovery", "vlan", "racks", "maps"):
        assert m in modules, f"Phase 1 module '{m}' regressed"
    assert modules["ipam"] == {"view": False, "edit": False, "delete": False}


# ─── 2. Migration pure-function contract ─────────────────────────────────


def _load_sprint21_migration_module():
    import sys
    import types
    if "alembic" not in sys.modules:
        sys.modules["alembic"] = types.ModuleType("alembic")
    sys.modules["alembic"].op = types.SimpleNamespace(
        add_column=lambda *a, **kw: None,
        drop_column=lambda *a, **kw: None,
        get_bind=lambda: None,
    )
    path = (
        Path(__file__).resolve().parent.parent
        / "alembic" / "versions" / "f9ai_notifications_module.py"
    )
    spec = importlib.util.spec_from_file_location(
        "f9ai_notifications_module", path,
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def sprint21_mig():
    return _load_sprint21_migration_module()


def test_sprint21_migration_revision_chain(sprint21_mig):
    """The migration must descend from the Phase 1 head."""
    assert sprint21_mig.revision == "f9ainotifmod"
    assert sprint21_mig.down_revision == "f9ahfeatmod"


def test_sprint21_backfill_carry_over_from_approval_review(sprint21_mig):
    """Any row where approval.review = True gets BOTH new verbs = True
    on backfill — the "no admin loses access" rule."""
    before = {
        "modules": {
            "approval": {"view": True, "review": True},
        }
    }
    after = sprint21_mig._backfill_row(before, "Some Custom Set")
    assert after["modules"]["notifications"] == {"view": True, "manage": True}


def test_sprint21_backfill_no_carry_over_when_approval_review_false(sprint21_mig):
    """approval.review = False (or absent) → both new verbs default
    to False on a non-opt-in-name row."""
    before = {"modules": {"approval": {"view": True, "review": False}}}
    after = sprint21_mig._backfill_row(before, "Some Custom Set")
    assert after["modules"]["notifications"] == {"view": False, "manage": False}


def test_sprint21_backfill_opt_in_true_for_tam_yetki(sprint21_mig):
    """Tam Yetki template gets both verbs True even without approval carry-over."""
    before = {"modules": {}}
    after = sprint21_mig._backfill_row(before, "Tam Yetki")
    assert after["modules"]["notifications"] == {"view": True, "manage": True}


def test_sprint21_backfill_opt_in_true_for_org_admin(sprint21_mig):
    before = {"modules": {}}
    after = sprint21_mig._backfill_row(before, "Org Admin")
    assert after["modules"]["notifications"] == {"view": True, "manage": True}


def test_sprint21_backfill_default_false_for_operator(sprint21_mig):
    """Operator template (name not opt-in, no approval.review) gets both false."""
    before = {"modules": {"devices": {"view": True, "ssh": True}}}
    after = sprint21_mig._backfill_row(before, "Operatör")
    assert after["modules"]["notifications"] == {"view": False, "manage": False}


def test_sprint21_backfill_existing_notifications_value_wins(sprint21_mig):
    """Explicit notifications.view = False must NOT be overwritten to
    True even when both opt-in rules would flip it. Idempotency core."""
    before = {
        "modules": {
            "approval": {"view": True, "review": True},  # carry-over would flip
            "notifications": {"view": False, "manage": False},  # explicit deny
        }
    }
    after = sprint21_mig._backfill_row(before, "Tam Yetki")  # name would flip
    assert after["modules"]["notifications"]["view"] is False
    assert after["modules"]["notifications"]["manage"] is False


def test_sprint21_backfill_partial_existing_value_wins(sprint21_mig):
    """Row with notifications.view=True but no notifications.manage
    should keep view=True and get manage filled in per opt-in rule."""
    before = {
        "modules": {
            "notifications": {"view": True},
            "approval": {"view": True, "review": True},
        }
    }
    after = sprint21_mig._backfill_row(before, "Operatör")  # not name-opt-in
    # view: existing True preserved
    assert after["modules"]["notifications"]["view"] is True
    # manage: missing, filled with default (approval carry-over → True)
    assert after["modules"]["notifications"]["manage"] is True


def test_sprint21_backfill_malformed_row_fails_closed(sprint21_mig):
    """Non-dict module_before → fail-closed, NEVER inherits opt-in True."""
    after = sprint21_mig._backfill_notifications_block("not-a-dict", True)
    assert after == {"view": False, "manage": False}


def test_sprint21_backfill_none_uses_default(sprint21_mig):
    """None module_before = module absent = follow opt-in default."""
    after_true = sprint21_mig._backfill_notifications_block(None, True)
    assert after_true == {"view": True, "manage": True}
    after_false = sprint21_mig._backfill_notifications_block(None, False)
    assert after_false == {"view": False, "manage": False}


def test_sprint21_backfill_idempotent(sprint21_mig):
    """Running the transform twice yields the same result."""
    before = {"modules": {"approval": {"review": True}}}
    once = sprint21_mig._backfill_row(before, "Tam Yetki")
    twice = sprint21_mig._backfill_row(once, "Tam Yetki")
    assert once == twice


def test_sprint21_downgrade_round_trip(sprint21_mig):
    """upgrade(row) → downgrade(.) removes the notifications block
    entirely; pre-migration modules untouched."""
    before = {"modules": {"devices": {"view": True}, "topology": {"view": True}}}
    upgraded = sprint21_mig._backfill_row(before, "Tam Yetki")
    assert "notifications" in upgraded["modules"]
    downgraded = sprint21_mig._downgrade_row(upgraded)
    assert "notifications" not in downgraded["modules"]
    assert downgraded["modules"]["devices"] == {"view": True}
    assert downgraded["modules"]["topology"] == {"view": True}


def test_sprint21_approval_review_helper_strict(sprint21_mig):
    """_approval_review_granted must return True ONLY when the exact
    True bit is set; missing / False / non-bool / non-dict all → False."""
    assert sprint21_mig._approval_review_granted({"approval": {"review": True}}) is True
    assert sprint21_mig._approval_review_granted({"approval": {"review": False}}) is False
    assert sprint21_mig._approval_review_granted({"approval": {}}) is False
    assert sprint21_mig._approval_review_granted({}) is False
    assert sprint21_mig._approval_review_granted({"approval": "yes"}) is False
    # Non-True truthy values must NOT be treated as True by mistake
    assert sprint21_mig._approval_review_granted({"approval": {"review": 1}}) is False
    assert sprint21_mig._approval_review_granted({"approval": {"review": "true"}}) is False


# ─── 3. notifications.py endpoint gates ──────────────────────────────────


def _read_notifications_source() -> str:
    path = (
        Path(__file__).resolve().parent.parent
        / "app" / "api" / "v1" / "endpoints" / "notifications.py"
    )
    return path.read_text(encoding="utf-8")


def test_notifications_source_has_no_approval_review_call_site():
    """The 6 pre-Sprint-2.1 approval:review CALL SITES must be gone.
    Only the literal `has_permission("approval:review")` invocation
    pattern is treated as a regression — the migration comment blocks
    inside notifications.py may explain the old verb by name."""
    src = _read_notifications_source()
    assert 'has_permission("approval:review")' not in src, (
        "notifications.py must not call has_permission('approval:review') "
        "after Sprint 2.1"
    )


def test_notifications_source_gates_by_new_verbs():
    """The new gate strings must be present the correct number of times.
    Six endpoints:
      1 read  (list_channels)          → notifications:view
      5 write (create/update/delete/test/digest) → notifications:manage
    """
    src = _read_notifications_source()
    view_hits = src.count('has_permission("notifications:view")')
    manage_hits = src.count('has_permission("notifications:manage")')
    assert view_hits == 1, f"expected 1 view gate, found {view_hits}"
    assert manage_hits == 5, f"expected 5 manage gates, found {manage_hits}"


# ─── 4. intelligence.py endpoint gates ───────────────────────────────────


def _read_intelligence_source() -> str:
    path = (
        Path(__file__).resolve().parent.parent
        / "app" / "api" / "v1" / "endpoints" / "intelligence.py"
    )
    return path.read_text(encoding="utf-8")


def test_intelligence_source_defines_gate_helper():
    """The gate helper must exist and raise 403 on failure."""
    src = _read_intelligence_source()
    assert "def _require_monitoring_view" in src
    # Failure branch must raise 403
    assert 'HTTPException(403' in src


def test_intelligence_source_all_six_endpoints_gated():
    """The gate call must appear once per read endpoint (6 endpoints)."""
    src = _read_intelligence_source()
    hits = src.count("_require_monitoring_view(current_user)")
    assert hits == 6, f"expected 6 gate call sites, found {hits}"


def test_intelligence_source_all_endpoints_use_named_current_user():
    """The pre-Sprint-2.1 `_: CurrentUser` discard param would leave the
    endpoint auth-only. Every read endpoint must now use the named
    `current_user: CurrentUser` param so the gate helper can be called.
    We verify by counting how many times the named param appears —
    must match the 6 endpoints — and by ensuring no leftover discard
    param sits INSIDE an endpoint parameter list."""
    src = _read_intelligence_source()
    named_hits = src.count("current_user: CurrentUser")
    assert named_hits == 6, (
        f"expected 6 named-param hits, found {named_hits}"
    )
    # Anti-regression: the discard param `_: CurrentUser,` inside a
    # function signature would be a syntactic mistake. We check for
    # the pattern `    _: CurrentUser,` (four-space indent + comma —
    # matches the param-list use, not a code comment or docstring
    # mention).
    param_list_pattern = "\n    _: CurrentUser,"
    assert param_list_pattern not in src, (
        "intelligence.py has a leftover `_: CurrentUser,` param — the "
        "gate helper cannot access it"
    )


# ─── 5. Provisioner presets ──────────────────────────────────────────────


def test_viewer_preset_grants_only_view_on_notifications():
    """Sadece Görüntüle preset — each action = (action == 'view').
    view=True, manage=False."""
    p = _viewer_permissions()["modules"]
    assert p["notifications"]["view"] is True
    assert p["notifications"]["manage"] is False


def test_operator_preset_does_not_grant_notifications():
    """Operatör preset does not enumerate notifications → both False."""
    p = _operator_permissions()["modules"]
    assert p["notifications"] == {"view": False, "manage": False}


def test_full_preset_grants_both_notifications_verbs():
    """Tam Yetki grants every non-skipped module fully."""
    p = _full_permissions()["modules"]
    assert p["notifications"]["view"] is True
    assert p["notifications"]["manage"] is True


# ─── 6. Approvals matrix-only change — legitimate approval verb kept ─────


def test_approvals_source_still_uses_approval_verbs():
    """Sprint 2.1 leaves approvals.py untouched — the approval:view /
    approval:review gates are LEGITIMATELY used there (they are the
    approval workflow's own verbs). Regression pin: those two strings
    must still appear in the approvals.py source."""
    path = (
        Path(__file__).resolve().parent.parent
        / "app" / "api" / "v1" / "endpoints" / "approvals.py"
    )
    src = path.read_text(encoding="utf-8")
    assert 'has_permission("approval:view")' in src, (
        "approvals.py must still use approval:view — legitimate use"
    )
    assert 'has_permission("approval:review")' in src, (
        "approvals.py must still use approval:review — legitimate use"
    )


def test_devices_approval_flow_still_uses_approval_review():
    """devices.py uses approval:review at line ~2286 in the
    device.approval_required flow — this is LEGITIMATE (an approval
    reviewer is doing device operations that need pre-approval). It
    must not have regressed."""
    path = (
        Path(__file__).resolve().parent.parent
        / "app" / "api" / "v1" / "endpoints" / "devices.py"
    )
    src = path.read_text(encoding="utf-8")
    assert 'has_permission("approval:review")' in src, (
        "devices.py approval_required flow must still gate on approval:review"
    )
