"""RBAC-SPRINT-2.2C-A — Firmware read authorization contract tests.

Sprint 2.2C-A is a READ-ONLY hardening PR. The three firmware.py GET
endpoints (GET /artifacts, GET /jobs, GET /jobs/{id}) were auth-only
pre-2.2C-A; a direct API caller could enumerate the ORG-WIDE firmware
catalog + every install job log (including SSH traces) without any
permission verb.

This suite covers operator brief scenarios A–L for firmware +
scenarios M–P for port_control. Standing constraints:
  - No mutating firmware endpoint is touched by this PR.
  - No port_control mutating endpoint is touched.
  - RLS + query-filter gaps are NOT addressed here (deferred).

Every backend gate helper is called BEFORE any DB read; the source-grep
tests below pin that ordering so a future refactor cannot silently
move the gate below a `select(...)`.
"""
from __future__ import annotations

import importlib.util
import re
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


def test_default_permissions_firmware_block_has_six_verbs():
    firmware = DEFAULT_PERMISSIONS["modules"]["firmware"]
    assert set(firmware.keys()) == {
        "view", "rollout_status", "upload", "assign", "install", "approve_reload",
    }
    for verb, val in firmware.items():
        assert val is False, f"firmware.{verb} default must be False"


def test_default_permissions_prior_modules_preserved():
    """Sprint 2.2C-A adds 1 new module; every earlier module must remain
    intact (Phase 1 + Sprint 2.1 + Sprint 2.2A + Sprint 2.2B1 + 2.2B2)."""
    modules = DEFAULT_PERMISSIONS["modules"]
    for m in ("devices", "config_backups", "topology", "monitoring",
              "audit_logs", "notifications", "discovery", "vlan",
              "racks", "maps", "config_drift", "security_audit",
              "asset_lifecycle", "terminal_sessions", "mac_arp",
              "sla", "poe", "services"):
        assert m in modules, f"{m} regressed"


# ─── 2. Migration pure-function contract ────────────────────────────────


def _load_sprint22ca_migration_module():
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
        / "alembic" / "versions" / "f9am_firmware_read_authorization.py"
    )
    spec = importlib.util.spec_from_file_location(
        "f9am_firmware_read_authorization", path,
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def sprint22ca_mig():
    return _load_sprint22ca_migration_module()


def test_sprint22ca_migration_revision_chain(sprint22ca_mig):
    assert sprint22ca_mig.revision == "f9amfirmwarereadauth"
    assert sprint22ca_mig.down_revision == "f9alservicesauth"


# --- E. Tam Yetki / Org Admin opt-in delivers ALL SIX verbs -------------


@pytest.mark.parametrize("template_name", ["Tam Yetki", "Org Admin"])
def test_sprint22ca_opt_in_grants_all_six_verbs(sprint22ca_mig, template_name):
    before = {"modules": {}}
    after = sprint22ca_mig._backfill_row(before, template_name)
    assert after["modules"]["firmware"] == {
        "view": True,
        "rollout_status": True,
        "upload": True,
        "assign": True,
        "install": True,
        "approve_reload": True,
    }


# --- F. monitoring.view carry-over ONLY unlocks firmware:view + rollout_status


def test_sprint22ca_monitoring_view_carry_over_only_reads(sprint22ca_mig):
    """A custom operator set with monitoring.view=True gets firmware.view
    AND firmware.rollout_status = True on migration; every mutating verb
    stays FALSE. This is the exact contract the operator brief demands
    (test F + test G)."""
    before = {"modules": {"monitoring": {"view": True}}}
    after = sprint22ca_mig._backfill_row(before, "Custom Operator Set")
    firmware = after["modules"]["firmware"]
    assert firmware["view"] is True
    assert firmware["rollout_status"] is True
    # G. Carry-over does NOT bleed into mutating verbs.
    assert firmware["upload"] is False
    assert firmware["assign"] is False
    assert firmware["install"] is False
    assert firmware["approve_reload"] is False


# --- G. Carry-over does NOT leak into mutating verbs --------------------


def test_sprint22ca_monitoring_view_does_not_grant_mutating_verbs(sprint22ca_mig):
    before = {"modules": {"monitoring": {"view": True}}}
    after = sprint22ca_mig._backfill_row(before, "Some Non-Admin Set")
    firmware = after["modules"]["firmware"]
    for verb in ("upload", "assign", "install", "approve_reload"):
        assert firmware[verb] is False, (
            f"monitoring.view carry-over MUST NOT touch firmware.{verb}"
        )


def test_sprint22ca_no_carry_over_from_config_backups_view(sprint22ca_mig):
    """Config-backups viewer does NOT gain any firmware verb.
    Sprint 2.2C-A carries over from monitoring.view only."""
    before = {"modules": {"config_backups": {"view": True}}}
    after = sprint22ca_mig._backfill_row(before, "Some Set")
    assert after["modules"]["firmware"] == {
        "view": False, "rollout_status": False, "upload": False,
        "assign": False, "install": False, "approve_reload": False,
    }


def test_sprint22ca_no_carry_over_from_device_edit_or_config_push(sprint22ca_mig):
    """device:edit / config:push MUST NOT silently unlock the mutating
    firmware verbs — those are handled in the deferred high-risk PR."""
    before = {"modules": {
        "devices": {"edit": True},
        "config": {"push": True},
    }}
    after = sprint22ca_mig._backfill_row(before, "Some Set")
    firmware = after["modules"]["firmware"]
    assert firmware["view"] is False
    assert firmware["rollout_status"] is False
    assert firmware["upload"] is False
    assert firmware["assign"] is False
    assert firmware["install"] is False
    assert firmware["approve_reload"] is False


# --- H. Existing explicit values ALWAYS win -----------------------------


def test_sprint22ca_existing_false_never_overwritten(sprint22ca_mig):
    """Tam Yetki + explicit firmware.upload=false → upload stays FALSE
    (idempotency contract)."""
    before = {
        "modules": {
            "firmware": {"upload": False, "install": False},
        }
    }
    after = sprint22ca_mig._backfill_row(before, "Tam Yetki")
    assert after["modules"]["firmware"]["upload"] is False
    assert after["modules"]["firmware"]["install"] is False
    # Missing verbs still opt-in for Tam Yetki.
    assert after["modules"]["firmware"]["view"] is True
    assert after["modules"]["firmware"]["approve_reload"] is True


def test_sprint22ca_partial_existing_wins(sprint22ca_mig):
    """firmware.view=true explicit; rollout_status missing → follows
    opt-in default for Tam Yetki (True)."""
    before = {"modules": {"firmware": {"view": True}}}
    after = sprint22ca_mig._backfill_row(before, "Tam Yetki")
    assert after["modules"]["firmware"]["view"] is True
    assert after["modules"]["firmware"]["rollout_status"] is True


# --- I. Malformed rows fail closed --------------------------------------


def test_sprint22ca_malformed_module_block_fails_closed(sprint22ca_mig):
    """Non-dict module value → all False, ignore default."""
    after = sprint22ca_mig._backfill_module_block(
        "not-a-dict",
        ("view", "rollout_status", "upload", "assign", "install", "approve_reload"),
        lambda v: True,
    )
    assert after == {
        "view": False, "rollout_status": False, "upload": False,
        "assign": False, "install": False, "approve_reload": False,
    }


def test_sprint22ca_none_module_uses_default(sprint22ca_mig):
    after_true = sprint22ca_mig._backfill_module_block(
        None,
        ("view", "rollout_status"),
        lambda v: True,
    )
    assert after_true == {"view": True, "rollout_status": True}
    after_false = sprint22ca_mig._backfill_module_block(
        None,
        ("view", "rollout_status"),
        lambda v: False,
    )
    assert after_false == {"view": False, "rollout_status": False}


# --- Idempotency + downgrade --------------------------------------------


def test_sprint22ca_backfill_idempotent(sprint22ca_mig):
    before = {"modules": {"devices": {"view": True}}}
    once = sprint22ca_mig._backfill_row(before, "Tam Yetki")
    twice = sprint22ca_mig._backfill_row(once, "Tam Yetki")
    assert once == twice


def test_sprint22ca_downgrade_removes_new_module(sprint22ca_mig):
    before = {"modules": {"devices": {"view": True}, "topology": {"view": True}}}
    upgraded = sprint22ca_mig._backfill_row(before, "Tam Yetki")
    assert "firmware" in upgraded["modules"]
    downgraded = sprint22ca_mig._downgrade_row(upgraded)
    assert "firmware" not in downgraded["modules"]
    assert downgraded["modules"]["devices"] == {"view": True}
    assert downgraded["modules"]["topology"] == {"view": True}


# ─── 3. Provisioner presets ────────────────────────────────────────────


def test_viewer_preset_grants_view_and_rollout_status():
    """Viewer preset already grants monitoring.view; the f9am migration
    would carry that over to firmware.view + firmware.rollout_status.
    Keep freshly-provisioned viewers aligned by explicit grant."""
    p = _viewer_permissions()["modules"]
    assert p["firmware"]["view"] is True
    assert p["firmware"]["rollout_status"] is True
    for verb in ("upload", "assign", "install", "approve_reload"):
        assert p["firmware"][verb] is False


def test_operator_preset_grants_only_read_verbs():
    """Operator preset already carries monitoring.view; explicit
    firmware.view + rollout_status grant. Mutating firmware verbs must
    stay FALSE — operators are not firmware installers."""
    p = _operator_permissions()["modules"]
    assert p["firmware"]["view"] is True
    assert p["firmware"]["rollout_status"] is True
    for verb in ("upload", "assign", "install", "approve_reload"):
        assert p["firmware"][verb] is False


def test_full_preset_grants_all_six_verbs():
    p = _full_permissions()["modules"]
    assert p["firmware"] == {
        "view": True,
        "rollout_status": True,
        "upload": True,
        "assign": True,
        "install": True,
        "approve_reload": True,
    }


# ─── 4. Endpoint source-grep contracts ─────────────────────────────────


def _read_firmware_source() -> str:
    path = (
        Path(__file__).resolve().parent.parent
        / "app" / "api" / "v1" / "endpoints" / "firmware.py"
    )
    return path.read_text(encoding="utf-8")


def _read_port_control_source() -> str:
    path = (
        Path(__file__).resolve().parent.parent
        / "app" / "api" / "v1" / "endpoints" / "port_control.py"
    )
    return path.read_text(encoding="utf-8")


# --- J. Every firmware GET endpoint has a named current_user + a gate --


def test_firmware_no_underscore_current_user_leftovers():
    """Every endpoint MUST use the named `current_user: CurrentUser`
    param so the gate helper can access it. A leftover `_: CurrentUser`
    would silently leave that endpoint auth-only."""
    src = _read_firmware_source()
    assert "\n    _: CurrentUser," not in src, (
        "firmware.py has a leftover `_: CurrentUser,` param — the gate "
        "helper cannot access it"
    )


def test_firmware_read_gates_are_wired_exactly_once():
    """3 firmware read endpoints must each call one of the two read
    gate helpers exactly once. 4 mutating firmware endpoints
    (create_artifact_url, upload_artifact, update_artifact,
    delete_artifact) keep their existing device:edit gate; 3 more
    (start_install, approve_reload, cancel_job) keep their existing
    config:push gate — the deferred mutating PR migrates those. So this
    PR only pins the read count."""
    src = _read_firmware_source()
    # Count CALLS only (indented) — the "def _require_..." line at the
    # top level also contains the substring but is not a gate call site.
    view_hits = src.count("    _require_firmware_view(current_user)")
    rollout_hits = src.count("    _require_firmware_rollout_status(current_user)")
    assert view_hits == 1, f"expected 1 firmware.view gate call, found {view_hits}"
    assert rollout_hits == 2, (
        f"expected 2 firmware.rollout_status gate calls, found {rollout_hits}"
    )


# --- K. Firmware read gate is called BEFORE any DB read ----------------


def test_firmware_view_gate_precedes_db_query_in_list_artifacts():
    src = _read_firmware_source()
    body_match = re.search(
        r"async def list_artifacts\([\s\S]*?\n\):[\s\S]*?(?=\n\n\n|\nasync def |\ndef )",
        src,
    )
    assert body_match is not None
    body = body_match.group(0)
    gate_idx = body.find("_require_firmware_view(current_user)")
    query_idx = body.find("await db.execute")
    assert gate_idx != -1
    assert query_idx != -1
    assert gate_idx < query_idx, (
        "firmware:view gate must run BEFORE the artifact SELECT"
    )


def test_firmware_rollout_status_gate_precedes_db_query_in_list_jobs():
    src = _read_firmware_source()
    body_match = re.search(
        r"async def list_jobs\([\s\S]*?\n\):[\s\S]*?(?=\n\n\n|\nasync def |\ndef )",
        src,
    )
    assert body_match is not None
    body = body_match.group(0)
    gate_idx = body.find("_require_firmware_rollout_status(current_user)")
    query_idx = body.find("await db.execute")
    assert gate_idx != -1
    assert query_idx != -1
    assert gate_idx < query_idx, (
        "firmware:rollout_status gate must run BEFORE the jobs SELECT"
    )


def test_firmware_rollout_status_gate_precedes_db_query_in_get_job():
    src = _read_firmware_source()
    body_match = re.search(
        r"async def get_job\([\s\S]*?\n\):[\s\S]*?(?=\n\n\n|\nasync def |\ndef )",
        src,
    )
    assert body_match is not None
    body = body_match.group(0)
    gate_idx = body.find("_require_firmware_rollout_status(current_user)")
    query_idx = body.find("await db.execute")
    assert gate_idx != -1
    assert query_idx != -1
    assert gate_idx < query_idx, (
        "firmware:rollout_status gate must run BEFORE the job SELECT so the "
        "SSH log is never returned to an unauthorized caller"
    )


# --- L. Firmware mutating endpoints keep their pre-2.2C-A gates --------


def test_firmware_mutating_gates_unchanged_by_this_pr():
    """Sprint 2.2C-A is READ-ONLY. Every mutating firmware endpoint MUST
    keep its pre-existing gate string exactly as it was."""
    src = _read_firmware_source()
    # 4 device:edit call sites on artifact CRUD.
    assert src.count('current_user.has_permission("device:edit")') == 4, (
        "firmware.py device:edit gate call count changed — Sprint 2.2C-A "
        "is READ-ONLY; the mutating gates are handled in a separate PR"
    )
    # 3 config:push call sites on install / approve-reload / cancel.
    assert src.count('current_user.has_permission("config:push")') == 3, (
        "firmware.py config:push gate call count changed — Sprint 2.2C-A "
        "is READ-ONLY; the mutating gates are handled in a separate PR"
    )
    # No firmware:upload / firmware:assign / firmware:install /
    # firmware:approve_reload wiring yet.
    for verb in ("firmware:upload", "firmware:assign",
                 "firmware:install", "firmware:approve_reload"):
        assert verb not in src, (
            f"{verb} MUST NOT be wired at the backend in Sprint 2.2C-A — "
            f"that's a deferred high-risk PR"
        )


# ─── 5. Port Control read-gate + inventory pins ─────────────────────────


def test_port_control_router_decorator_inventory():
    """O. Pin the full port_control @router decorator set so a future PR
    that adds a new endpoint MUST update this test — otherwise the new
    endpoint can silently ship auth-only."""
    src = _read_port_control_source()
    decorators = re.findall(r"^@router\.(get|post|patch|delete|put)\(", src, flags=re.MULTILINE)
    assert len(decorators) == 7, (
        f"expected 7 @router decorators in port_control.py; found {len(decorators)}"
    )
    # 6 POST + 1 GET.
    assert decorators.count("post") == 6
    assert decorators.count("get") == 1
    assert decorators.count("patch") == 0
    assert decorators.count("delete") == 0


def test_port_control_list_rollbacks_calls_require_edit():
    """M. GET /_rollbacks (previously auth-only) now calls the same
    device:edit gate helper as the mutating endpoints — temporary
    parity while port_control:view lives in the deferred mutating PR."""
    src = _read_port_control_source()
    body_match = re.search(
        r"async def list_rollbacks\([\s\S]*?\n\):[\s\S]*?(?=\n\n\n|\nasync def |\ndef |\Z)",
        src,
    )
    assert body_match is not None
    body = body_match.group(0)
    assert "_require_edit(current_user)" in body, (
        "GET /_rollbacks must call _require_edit(current_user)"
    )


def test_port_control_gate_precedes_db_query_in_list_rollbacks():
    """N. The gate MUST run before the SELECT so an unauthorized caller
    never sees rollback rows even if the query itself is cheap."""
    src = _read_port_control_source()
    body_match = re.search(
        r"async def list_rollbacks\([\s\S]*?\n\):[\s\S]*?(?=\n\n\n|\nasync def |\ndef |\Z)",
        src,
    )
    assert body_match is not None
    body = body_match.group(0)
    gate_idx = body.find("_require_edit(current_user)")
    query_idx = body.find("await db.execute")
    assert gate_idx != -1
    assert query_idx != -1
    assert gate_idx < query_idx


def test_port_control_mutating_helper_unchanged_by_this_pr():
    """P. Sprint 2.2C-A DOES NOT modify any mutating port_control code.
    _require_edit body is pinned verbatim so a future PR must update
    this test to touch that helper."""
    src = _read_port_control_source()
    # The helper body — two-line function that checks device:edit +
    # super_admin. Pinning it prevents accidental drift in this PR.
    assert 'not current_user.has_permission("device:edit") and not current_user.is_super_admin' in src
    assert 'raise HTTPException(status_code=403, detail="device:edit yetkisi yok")' in src
    # No new port_control:* verbs are wired at any has_permission call
    # site. The docstring may mention them in explanatory prose (e.g.
    # "the permanent port_control:view verb will land in Sprint 2.2C-B"),
    # so we search for the ACTUAL permission-check pattern, not the
    # substring alone.
    assert 'has_permission("port_control:' not in src, (
        "port_control:* verbs are reserved for the deferred mutating PR — "
        "no has_permission call site allowed in Sprint 2.2C-A"
    )


# ─── 6. Gate helper simulation — A/B/C/D scenarios ─────────────────────


class _FakeUser:
    def __init__(self, grants: set[str] | None = None):
        self._grants = grants or set()

    def has_permission(self, verb: str) -> bool:
        return verb in self._grants


def _import_helpers():
    import importlib
    return importlib.import_module("app.api.v1.endpoints.firmware")


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


# --- A. GET /artifacts requires firmware:view --------------------------


def test_A_firmware_view_gate_403_without_permission(helpers):
    _expect_403(helpers._require_firmware_view, _FakeUser(), "firmware.view")


# --- B. GET /jobs + /jobs/{id} require firmware:rollout_status ---------


def test_B_firmware_rollout_status_gate_403_without_permission(helpers):
    _expect_403(
        helpers._require_firmware_rollout_status,
        _FakeUser(),
        "firmware.rollout_status",
    )


# --- C. firmware:view alone does NOT grant rollout_status --------------


def test_C_firmware_view_isolates_from_rollout_status(helpers):
    user = _FakeUser({"firmware:view"})
    _expect_pass(helpers._require_firmware_view, user)
    _expect_403(
        helpers._require_firmware_rollout_status,
        user,
        "firmware.rollout_status",
    )


# --- D. firmware:rollout_status alone does NOT grant view --------------


def test_D_firmware_rollout_status_isolates_from_view(helpers):
    """A rollout_status grant lets an operator watch install progress
    without seeing every OS artifact in the catalog — asymmetric verb
    contract, matches the Sprint 2.2B2 view/manage isolation pattern."""
    user = _FakeUser({"firmware:rollout_status"})
    _expect_pass(helpers._require_firmware_rollout_status, user)
    _expect_403(helpers._require_firmware_view, user, "firmware.view")


def test_both_read_verbs_granted_passes_all_helpers(helpers):
    user = _FakeUser({"firmware:view", "firmware:rollout_status"})
    _expect_pass(helpers._require_firmware_view, user)
    _expect_pass(helpers._require_firmware_rollout_status, user)
