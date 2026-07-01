"""RBAC-SPRINT-2.2A — backend authorization hardening contract tests.

Follows the Sprint 2.1 test layout. Covers operator scenarios A–N:

  A. Each GET endpoint returns 403 without the correct :view gate.
  B. Each mutating endpoint returns 403 without the correct action gate.
  C. Correct permission grants access.
  D. `config:view` alone can NO LONGER pass the mac_arp collect gate
     (the pre-2.2A semantic bug); the migration carries over but the
     endpoint checks `mac_arp:collect`, not `config:view`.
  E. `mac_arp.collect = true` allows collect.
  F. `terminal_sessions.view` does NOT grant summarize.
  G. `security_audit.view` does NOT grant profile_manage or run.
  H. `asset_lifecycle.view` does NOT grant manage.
  I. `config_drift.view` does NOT grant manage or run.
  J. Tam Yetki / Org Admin backfill delivers every new-module verb.
  K. Carry-over backfill preserves explicit false.
  L. Malformed JSON fails closed regardless of opt-in.
  M. org_admin / super_admin retain access via PermissionEngine bypass
     (validated indirectly — the engine's short-circuit is a Phase 1
     invariant, exercised by the existing suite).
  N. Phase 1 + Sprint 2.1 tests remain green (this file adds; the
     existing suites are re-run in CI).
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


# ─── 1. DEFAULT_PERMISSIONS schema — 5 new modules exist + verb sets ─────


@pytest.mark.parametrize("module,expected_verbs", [
    ("config_drift",      {"view", "manage", "run"}),
    ("security_audit",    {"view", "profile_manage", "run"}),
    ("asset_lifecycle",   {"view", "manage"}),
    ("terminal_sessions", {"view", "summarize"}),
    ("mac_arp",           {"view", "collect"}),
])
def test_default_permissions_new_module_shape(module, expected_verbs):
    block = DEFAULT_PERMISSIONS["modules"][module]
    assert set(block.keys()) == expected_verbs
    for verb, val in block.items():
        assert val is False, f"{module}.{verb} default must be False"


def test_default_permissions_prior_modules_preserved():
    """Sprint 2.2A only adds modules; Phase 1 / Sprint 2.1 modules
    must not have regressed."""
    modules = DEFAULT_PERMISSIONS["modules"]
    for m in ("devices", "config_backups", "topology", "monitoring",
              "audit_logs", "notifications", "discovery", "vlan",
              "racks", "maps"):
        assert m in modules, f"{m} regressed"


# ─── 2. Migration pure-function contract ────────────────────────────────


def _load_sprint22a_migration_module():
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
        / "alembic" / "versions" / "f9aj_rbac_authorization_hardening.py"
    )
    spec = importlib.util.spec_from_file_location(
        "f9aj_rbac_authorization_hardening", path,
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def sprint22a_mig():
    return _load_sprint22a_migration_module()


def test_sprint22a_migration_revision_chain(sprint22a_mig):
    assert sprint22a_mig.revision == "f9ajauthhard"
    assert sprint22a_mig.down_revision == "f9ainotifmod"


# --- J. Tam Yetki / Org Admin opt-in: every new verb = true ----------------


@pytest.mark.parametrize("template_name", ["Tam Yetki", "Org Admin"])
def test_sprint22a_opt_in_grants_every_verb(sprint22a_mig, template_name):
    before = {"modules": {}}
    after = sprint22a_mig._backfill_row(before, template_name)
    for module, verbs in (
        ("config_drift",      ("view", "manage", "run")),
        ("security_audit",    ("view", "profile_manage", "run")),
        ("asset_lifecycle",   ("view", "manage")),
        ("terminal_sessions", ("view", "summarize")),
        ("mac_arp",           ("view", "collect")),
    ):
        for verb in verbs:
            assert after["modules"][module][verb] is True, (
                f"{template_name} must grant {module}.{verb} on opt-in"
            )


# --- Carry-over rules land only on VIEW verbs (never mutating) ---------


@pytest.mark.parametrize("source_module,source_verb,target_module,target_verb", [
    ("monitoring",     "view", "security_audit",    "view"),
    ("monitoring",     "view", "asset_lifecycle",   "view"),
    ("monitoring",     "view", "mac_arp",           "view"),
    ("audit_logs",     "view", "terminal_sessions", "view"),
    ("config_backups", "view", "config_drift",      "view"),
    # Semantic-fix carry-over — the only carry-over that lands on a
    # non-view verb: config:view → mac_arp:collect preserves the
    # existing (wrong-verb) operator access under the correct new
    # verb.
    ("config",         "view", "mac_arp",           "collect"),
])
def test_sprint22a_carry_over_lands_on_correct_target(
    sprint22a_mig, source_module, source_verb, target_module, target_verb,
):
    """When the source verb is TRUE on a custom set, the specific
    target verb defaults to TRUE via the carry-over rule."""
    before = {"modules": {source_module: {source_verb: True}}}
    after = sprint22a_mig._backfill_row(before, "Custom Operator Set")
    assert after["modules"][target_module][target_verb] is True


def test_sprint22a_carry_over_does_not_leak_to_mutating_verbs(sprint22a_mig):
    """monitoring.view=true carries over to security_audit.view=true
    but NOT to security_audit.profile_manage or security_audit.run —
    a viewer of monitoring dashboards must NOT become a compliance
    profile administrator by carry-over alone."""
    before = {"modules": {"monitoring": {"view": True}}}
    after = sprint22a_mig._backfill_row(before, "Custom Operator Set")
    assert after["modules"]["security_audit"]["view"] is True
    assert after["modules"]["security_audit"]["profile_manage"] is False
    assert after["modules"]["security_audit"]["run"] is False
    assert after["modules"]["asset_lifecycle"]["view"] is True
    assert after["modules"]["asset_lifecycle"]["manage"] is False
    assert after["modules"]["mac_arp"]["view"] is True
    # mac_arp.collect ONLY carries over from config.view — not
    # monitoring.view.
    assert after["modules"]["mac_arp"]["collect"] is False
    # audit_logs.view carry-over is separate.
    assert after["modules"]["terminal_sessions"]["view"] is False
    assert after["modules"]["terminal_sessions"]["summarize"] is False


# --- K. Existing explicit values ALWAYS win ---------------------------


def test_sprint22a_existing_false_never_overwritten(sprint22a_mig):
    """Tam Yetki (name opt-in TRUE) + explicit False on target verb
    → False survives. Idempotency contract."""
    before = {
        "modules": {
            "monitoring": {"view": True},  # carry-over would flip
            "security_audit": {"view": False, "profile_manage": False, "run": False},
        }
    }
    after = sprint22a_mig._backfill_row(before, "Tam Yetki")
    assert after["modules"]["security_audit"]["view"] is False
    assert after["modules"]["security_audit"]["profile_manage"] is False
    assert after["modules"]["security_audit"]["run"] is False


def test_sprint22a_partial_existing_wins(sprint22a_mig):
    """Some verbs on the module already present → keep them; only
    missing verbs get the default."""
    before = {
        "modules": {
            "monitoring": {"view": True},
            "security_audit": {"view": False},  # explicit deny on view
            # profile_manage, run missing → filled with opt-in default
        }
    }
    after = sprint22a_mig._backfill_row(before, "Tam Yetki")
    assert after["modules"]["security_audit"]["view"] is False
    # Missing verbs → Tam Yetki opt-in → True
    assert after["modules"]["security_audit"]["profile_manage"] is True
    assert after["modules"]["security_audit"]["run"] is True


# --- L. Malformed rows fail closed regardless of opt-in ---------------


def test_sprint22a_malformed_module_block_fails_closed(sprint22a_mig):
    """Non-dict module value → all verbs = False, ignore default_for_verb."""
    after = sprint22a_mig._backfill_module_block(
        "not-a-dict",
        ("view", "manage", "run"),
        lambda verb: True,  # default WAS True; must be ignored
    )
    assert after == {"view": False, "manage": False, "run": False}


def test_sprint22a_none_module_uses_default(sprint22a_mig):
    """None module (module absent pre-migration) → follow the default."""
    after_true = sprint22a_mig._backfill_module_block(
        None, ("view",), lambda verb: True,
    )
    assert after_true == {"view": True}
    after_false = sprint22a_mig._backfill_module_block(
        None, ("view",), lambda verb: False,
    )
    assert after_false == {"view": False}


# --- Strict True comparison prevents truthy coincidences --------------


def test_sprint22a_lookup_verb_true_is_strict(sprint22a_mig):
    assert sprint22a_mig._lookup_verb_true({"monitoring": {"view": True}}, "monitoring", "view") is True
    assert sprint22a_mig._lookup_verb_true({"monitoring": {"view": False}}, "monitoring", "view") is False
    assert sprint22a_mig._lookup_verb_true({"monitoring": {}}, "monitoring", "view") is False
    assert sprint22a_mig._lookup_verb_true({}, "monitoring", "view") is False
    # Non-True truthy values must NOT be treated as True
    assert sprint22a_mig._lookup_verb_true({"monitoring": {"view": 1}}, "monitoring", "view") is False
    assert sprint22a_mig._lookup_verb_true({"monitoring": {"view": "true"}}, "monitoring", "view") is False


# --- Idempotency + downgrade round-trip ------------------------------


def test_sprint22a_backfill_idempotent(sprint22a_mig):
    before = {"modules": {"monitoring": {"view": True}}}
    once = sprint22a_mig._backfill_row(before, "Tam Yetki")
    twice = sprint22a_mig._backfill_row(once, "Tam Yetki")
    assert once == twice


def test_sprint22a_downgrade_removes_new_modules(sprint22a_mig):
    before = {"modules": {"devices": {"view": True}, "topology": {"view": True}}}
    upgraded = sprint22a_mig._backfill_row(before, "Tam Yetki")
    for m in ("config_drift", "security_audit", "asset_lifecycle",
              "terminal_sessions", "mac_arp"):
        assert m in upgraded["modules"]
    downgraded = sprint22a_mig._downgrade_row(upgraded)
    for m in ("config_drift", "security_audit", "asset_lifecycle",
              "terminal_sessions", "mac_arp"):
        assert m not in downgraded["modules"]
    # Phase 1 modules preserved
    assert downgraded["modules"]["devices"] == {"view": True}
    assert downgraded["modules"]["topology"] == {"view": True}


# ─── 3. Provisioner presets ────────────────────────────────────────────


def test_viewer_preset_grants_only_view_across_new_modules():
    p = _viewer_permissions()["modules"]
    # viewer sets each key to (action == "view")
    for module, verbs, view_verb in (
        ("config_drift",      ("view", "manage", "run"), "view"),
        ("security_audit",    ("view", "profile_manage", "run"), "view"),
        ("asset_lifecycle",   ("view", "manage"), "view"),
        ("terminal_sessions", ("view", "summarize"), "view"),
        ("mac_arp",           ("view", "collect"), "view"),
    ):
        for verb in verbs:
            expected = (verb == view_verb)
            assert p[module][verb] is expected, (
                f"viewer {module}.{verb} expected {expected}"
            )


def test_operator_preset_leaves_new_modules_at_default_false():
    p = _operator_permissions()["modules"]
    for module in ("config_drift", "security_audit", "asset_lifecycle",
                   "terminal_sessions", "mac_arp"):
        for verb, val in p[module].items():
            assert val is False


def test_full_preset_grants_every_new_module_verb():
    p = _full_permissions()["modules"]
    for module, verbs in (
        ("config_drift",      ("view", "manage", "run")),
        ("security_audit",    ("view", "profile_manage", "run")),
        ("asset_lifecycle",   ("view", "manage")),
        ("terminal_sessions", ("view", "summarize")),
        ("mac_arp",           ("view", "collect")),
    ):
        for verb in verbs:
            assert p[module][verb] is True


# ─── 4. Endpoint source-grep contracts ─────────────────────────────────


def _read(name: str) -> str:
    path = (
        Path(__file__).resolve().parent.parent
        / "app" / "api" / "v1" / "endpoints" / name
    )
    return path.read_text(encoding="utf-8")


def test_terminal_sessions_has_no_ungated_endpoint():
    """4 endpoints total: 3 view-gated + 1 summarize-gated."""
    src = _read("terminal_sessions.py")
    view_hits = src.count("_require_terminal_sessions_view(current_user)")
    sum_hits = src.count("_require_terminal_sessions_summarize(current_user)")
    assert view_hits == 3, f"expected 3 view gate call sites, found {view_hits}"
    assert sum_hits == 1, f"expected 1 summarize gate call site, found {sum_hits}"


def test_mac_arp_has_no_legacy_config_view_gate_call_site():
    """The pre-2.2A CALL SITE
    `has_permission("config:view")` must be gone from mac_arp.py.
    (The literal string may still appear inside migration/comment
    references — we only ban the invocation pattern.)"""
    src = _read("mac_arp.py")
    assert 'has_permission("config:view")' not in src


def test_mac_arp_endpoint_gate_counts():
    src = _read("mac_arp.py")
    view_hits = src.count("_require_mac_arp_view(current_user)")
    collect_hits = src.count("_require_mac_arp_collect(current_user)")
    assert view_hits == 6, f"expected 6 view gates, found {view_hits}"
    assert collect_hits == 1, f"expected 1 collect gate, found {collect_hits}"


def test_asset_lifecycle_endpoint_gate_counts():
    src = _read("asset_lifecycle.py")
    view_hits = src.count("_require_asset_lifecycle_view(current_user)")
    manage_hits = src.count("_require_asset_lifecycle_manage(current_user)")
    assert view_hits == 4, f"expected 4 view gates, found {view_hits}"
    assert manage_hits == 4, f"expected 4 manage gates, found {manage_hits}"


def test_config_drift_backup_schedules_endpoint_gate_counts():
    src = _read("backup_schedules.py")
    view_hits = src.count("_require_config_drift_view(current_user)")
    manage_hits = src.count("_require_config_drift_manage(current_user)")
    run_hits = src.count("_require_config_drift_run(current_user)")
    # 3 view (list schedules + drift-report + drift-diff)
    # 3 manage (create + update + delete schedule)
    # 1 run (run-now)
    assert view_hits == 3, f"expected 3 view gates, found {view_hits}"
    assert manage_hits == 3, f"expected 3 manage gates, found {manage_hits}"
    assert run_hits == 1, f"expected 1 run gate, found {run_hits}"


def test_security_audit_endpoint_gate_counts():
    src = _read("security_audit.py")
    view_hits = src.count("_require_security_audit_view(current_user)")
    profile_hits = src.count("_require_security_audit_profile_manage(current_user)")
    run_hits = src.count("_require_security_audit_run(current_user)")
    # 8 view: /rules, /profiles(list), /stats, /export.csv, /(list),
    #         /{id}, /device/{id}/history, /fleet-trend
    # 3 profile_manage: POST /profiles, PUT /profiles/{id},
    #                   DELETE /profiles/{id}
    # 1 run: POST /run
    assert view_hits == 8, f"expected 8 view gates, found {view_hits}"
    assert profile_hits == 3, f"expected 3 profile_manage gates, found {profile_hits}"
    assert run_hits == 1, f"expected 1 run gate, found {run_hits}"


def test_no_underscore_current_user_leftovers():
    """The pre-2.2A `_: CurrentUser` discard param would leave gates
    unreachable. Every touched file must use `current_user:` inside
    endpoint parameter lists."""
    for name in ("terminal_sessions.py", "mac_arp.py",
                 "asset_lifecycle.py", "backup_schedules.py",
                 "security_audit.py"):
        src = _read(name)
        assert "\n    _: CurrentUser," not in src, (
            f"{name} has a leftover `_: CurrentUser,` param — the "
            f"gate helper cannot access it"
        )


# ─── 5. Gate helper simulation — A/C/D/E/F/G/H/I scenarios ────────────


class _FakeUser:
    """Minimal has_permission stand-in for gate-helper unit tests.
    Mirrors User.has_permission's string-match semantics."""
    def __init__(self, grants: set[str] | None = None):
        self._grants = grants or set()

    def has_permission(self, verb: str) -> bool:
        return verb in self._grants


def _import_helpers():
    """Import the gate helpers from the touched endpoint modules.
    Each module imports FastAPI + SQLAlchemy at module top; we
    load the module the same way pytest would."""
    import importlib
    return {
        "config_drift": importlib.import_module("app.api.v1.endpoints.backup_schedules"),
        "security_audit": importlib.import_module("app.api.v1.endpoints.security_audit"),
        "asset_lifecycle": importlib.import_module("app.api.v1.endpoints.asset_lifecycle"),
        "terminal_sessions": importlib.import_module("app.api.v1.endpoints.terminal_sessions"),
        "mac_arp": importlib.import_module("app.api.v1.endpoints.mac_arp"),
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
    # Gate helpers return None on success.
    result = fn(user)
    assert result is None


# --- A/B. Empty grants → every gate 403 ------------------------------


def test_empty_grants_denies_every_gate(helpers):
    user = _FakeUser()
    _expect_403(helpers["config_drift"]._require_config_drift_view, user, "config_drift.view")
    _expect_403(helpers["config_drift"]._require_config_drift_manage, user, "config_drift.manage")
    _expect_403(helpers["config_drift"]._require_config_drift_run, user, "config_drift.run")
    _expect_403(helpers["security_audit"]._require_security_audit_view, user, "security_audit.view")
    _expect_403(helpers["security_audit"]._require_security_audit_profile_manage, user, "security_audit.profile_manage")
    _expect_403(helpers["security_audit"]._require_security_audit_run, user, "security_audit.run")
    _expect_403(helpers["asset_lifecycle"]._require_asset_lifecycle_view, user, "asset_lifecycle.view")
    _expect_403(helpers["asset_lifecycle"]._require_asset_lifecycle_manage, user, "asset_lifecycle.manage")
    _expect_403(helpers["terminal_sessions"]._require_terminal_sessions_view, user, "terminal_sessions.view")
    _expect_403(helpers["terminal_sessions"]._require_terminal_sessions_summarize, user, "terminal_sessions.summarize")
    _expect_403(helpers["mac_arp"]._require_mac_arp_view, user, "mac_arp.view")
    _expect_403(helpers["mac_arp"]._require_mac_arp_collect, user, "mac_arp.collect")


# --- C. Correct permission grants access ------------------------------


def test_correct_permission_grants_access(helpers):
    _expect_pass(helpers["config_drift"]._require_config_drift_view,
                 _FakeUser({"config_drift:view"}))
    _expect_pass(helpers["config_drift"]._require_config_drift_manage,
                 _FakeUser({"config_drift:manage"}))
    _expect_pass(helpers["config_drift"]._require_config_drift_run,
                 _FakeUser({"config_drift:run"}))
    _expect_pass(helpers["security_audit"]._require_security_audit_view,
                 _FakeUser({"security_audit:view"}))
    _expect_pass(helpers["security_audit"]._require_security_audit_profile_manage,
                 _FakeUser({"security_audit:profile_manage"}))
    _expect_pass(helpers["security_audit"]._require_security_audit_run,
                 _FakeUser({"security_audit:run"}))
    _expect_pass(helpers["asset_lifecycle"]._require_asset_lifecycle_view,
                 _FakeUser({"asset_lifecycle:view"}))
    _expect_pass(helpers["asset_lifecycle"]._require_asset_lifecycle_manage,
                 _FakeUser({"asset_lifecycle:manage"}))
    _expect_pass(helpers["terminal_sessions"]._require_terminal_sessions_view,
                 _FakeUser({"terminal_sessions:view"}))
    _expect_pass(helpers["terminal_sessions"]._require_terminal_sessions_summarize,
                 _FakeUser({"terminal_sessions:summarize"}))
    _expect_pass(helpers["mac_arp"]._require_mac_arp_view,
                 _FakeUser({"mac_arp:view"}))
    _expect_pass(helpers["mac_arp"]._require_mac_arp_collect,
                 _FakeUser({"mac_arp:collect"}))


# --- D. `config:view` alone can NOT pass mac_arp.collect --------------


def test_semantic_fix_config_view_alone_no_longer_passes_mac_arp_collect(helpers):
    """Pre-2.2A the mac_arp.py:311 gate was `config:view`. Post-2.2A
    the endpoint checks `mac_arp:collect` — an operator whose only
    permission is `config:view` must NOT bypass the collect gate."""
    user = _FakeUser({"config:view"})
    _expect_403(helpers["mac_arp"]._require_mac_arp_collect, user, "mac_arp.collect")


# --- E. mac_arp.collect = true allows collect ------------------------


def test_mac_arp_collect_grants_collect(helpers):
    _expect_pass(helpers["mac_arp"]._require_mac_arp_collect,
                 _FakeUser({"mac_arp:collect"}))


# --- F. terminal_sessions.view does NOT grant summarize --------------


def test_terminal_sessions_view_does_not_grant_summarize(helpers):
    user = _FakeUser({"terminal_sessions:view"})
    _expect_pass(helpers["terminal_sessions"]._require_terminal_sessions_view, user)
    _expect_403(helpers["terminal_sessions"]._require_terminal_sessions_summarize,
                user, "terminal_sessions.summarize")


# --- G. security_audit.view does NOT grant profile_manage or run -----


def test_security_audit_view_isolates_from_mutating_verbs(helpers):
    user = _FakeUser({"security_audit:view"})
    _expect_pass(helpers["security_audit"]._require_security_audit_view, user)
    _expect_403(helpers["security_audit"]._require_security_audit_profile_manage,
                user, "security_audit.profile_manage")
    _expect_403(helpers["security_audit"]._require_security_audit_run,
                user, "security_audit.run")


# --- H. asset_lifecycle.view does NOT grant manage -------------------


def test_asset_lifecycle_view_isolates_from_manage(helpers):
    user = _FakeUser({"asset_lifecycle:view"})
    _expect_pass(helpers["asset_lifecycle"]._require_asset_lifecycle_view, user)
    _expect_403(helpers["asset_lifecycle"]._require_asset_lifecycle_manage,
                user, "asset_lifecycle.manage")


# --- I. config_drift.view does NOT grant manage or run ---------------


def test_config_drift_view_isolates_from_mutating_verbs(helpers):
    user = _FakeUser({"config_drift:view"})
    _expect_pass(helpers["config_drift"]._require_config_drift_view, user)
    _expect_403(helpers["config_drift"]._require_config_drift_manage,
                user, "config_drift.manage")
    _expect_403(helpers["config_drift"]._require_config_drift_run,
                user, "config_drift.run")
