"""RBAC-PHASE-1 — feature module catalog (discovery/vlan/racks/maps)
schema + backfill + endpoint-gate contract tests.

Mirrors the P2-CATALOG-A test layout (test_p2_catalog_canonical_permissions.py)
so future drift between the migration file and the runtime DEFAULT
catalog is caught here.

Three scopes covered:

  1. DEFAULT_PERMISSIONS schema. The four new module blocks
     (discovery / vlan / racks / maps) exist with the expected verbs
     defaulting to False; pre-existing modules did not regress.

  2. Provisioner presets. After Phase 1 the four new modules ride the
     same `_full_permissions()` skip rule as everything else — the
     `Tam Yetki` preset emits every new verb True, while the viewer
     preset only emits view=True for each.

  3. Migration backfill pure-function contract. The migration
     factors the backfill logic into pure functions so the policy
     can be tested without a live database; we exercise the same
     idempotent / opt-in / no-overwrite rules as the P2-CATALOG-A
     migration.

  4. racks.py endpoint gates. Every router function uses the
     correct verb-bound dependency string (view / edit / delete).
     Catches a regression where a future refactor drops the
     dependency or wires the wrong verb.
"""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest

from app.models.shared.permission_set import DEFAULT_PERMISSIONS
from app.services.rbac.provisioner import (
    _full_permissions,
    _operator_permissions,
    _viewer_permissions,
)


# ─── 1. DEFAULT_PERMISSIONS schema ────────────────────────────────────────


def test_default_permissions_discovery_block():
    discovery = DEFAULT_PERMISSIONS["modules"]["discovery"]
    assert set(discovery.keys()) == {"view", "run"}
    for key, value in discovery.items():
        assert value is False, f"discovery.{key} default must be False"


def test_default_permissions_vlan_block():
    vlan = DEFAULT_PERMISSIONS["modules"]["vlan"]
    assert set(vlan.keys()) == {"view", "edit", "push"}
    for key, value in vlan.items():
        assert value is False, f"vlan.{key} default must be False"


def test_default_permissions_racks_block():
    racks = DEFAULT_PERMISSIONS["modules"]["racks"]
    assert set(racks.keys()) == {"view", "edit", "delete"}
    for key, value in racks.items():
        assert value is False, f"racks.{key} default must be False"


def test_default_permissions_maps_block():
    maps = DEFAULT_PERMISSIONS["modules"]["maps"]
    assert set(maps.keys()) == {"view"}
    assert maps["view"] is False


def test_default_permissions_pre_existing_modules_preserved():
    """Phase 1 only ADDS modules; pre-existing modules must not
    have changed shape (P2-CATALOG-A keys + the legacy verbs)."""
    modules = DEFAULT_PERMISSIONS["modules"]
    # P2-CATALOG-A canonical keys still present
    for k in ("view", "create", "edit", "delete", "ssh", "connect", "move"):
        assert k in modules["devices"], f"devices.{k} must remain after Phase 1"
    for k in ("view", "edit", "delete", "backup", "restore"):
        assert k in modules["config_backups"]
    # Other modules unchanged
    assert modules["ipam"] == {"view": False, "edit": False, "delete": False}
    assert modules["topology"] == {"view": False}


# ─── 2. Provisioner presets ────────────────────────────────────────────────


def test_viewer_preset_grants_only_view_on_new_modules():
    p = _viewer_permissions()["modules"]
    # Viewer iterates DEFAULT_PERMISSIONS and sets each action to
    # `action == "view"`. The four new modules must follow the same
    # rule.
    assert p["discovery"]["view"] is True
    assert p["discovery"]["run"] is False
    assert p["vlan"]["view"] is True
    assert p["vlan"]["edit"] is False
    assert p["vlan"]["push"] is False
    assert p["racks"]["view"] is True
    assert p["racks"]["edit"] is False
    assert p["racks"]["delete"] is False
    assert p["maps"]["view"] is True


def test_operator_preset_does_not_grant_new_modules_by_default():
    """Operator preset only enumerates explicit grants; the four new
    modules are NOT in that list, so all verbs stay False (the
    deepcopy of DEFAULT_PERMISSIONS gives them False)."""
    p = _operator_permissions()["modules"]
    for module, expected_keys in (
        ("discovery", {"view", "run"}),
        ("vlan",      {"view", "edit", "push"}),
        ("racks",     {"view", "edit", "delete"}),
        ("maps",      {"view"}),
    ):
        assert set(p[module].keys()) == expected_keys
        for verb, val in p[module].items():
            assert val is False, f"operator preset must not grant {module}.{verb} by default"


def test_full_preset_grants_every_new_module_verb():
    """`_full_permissions` sets every action of every non-skipped
    module to True. The four new modules MUST therefore be fully on."""
    p = _full_permissions()["modules"]
    for verb in ("view", "run"):
        assert p["discovery"][verb] is True, f"Tam Yetki discovery.{verb} must be True"
    for verb in ("view", "edit", "push"):
        assert p["vlan"][verb] is True, f"Tam Yetki vlan.{verb} must be True"
    for verb in ("view", "edit", "delete"):
        assert p["racks"][verb] is True, f"Tam Yetki racks.{verb} must be True"
    assert p["maps"]["view"] is True


def test_full_preset_users_module_still_withheld():
    """Phase 1 must not regress the existing `users` skip rule."""
    p = _full_permissions()["modules"]
    for verb in ("view", "edit", "delete", "invite"):
        assert p["users"][verb] is False, (
            f"Tam Yetki users.{verb} must remain False (existing skip rule)"
        )


# ─── 3. Migration backfill — pure-function unit tests ─────────────────────


def _load_phase1_migration_module():
    """Load the f9ah_feature_module_catalog migration as a module
    object so its pure helpers can be exercised without alembic.

    The stub is identical to the one in test_p2_catalog_canonical_permissions.
    """
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
        / "alembic" / "versions" / "f9ah_feature_module_catalog.py"
    )
    spec = importlib.util.spec_from_file_location(
        "f9ah_feature_module_catalog", path,
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def phase1_mig():
    return _load_phase1_migration_module()


def test_phase1_migration_revision_chain(phase1_mig):
    """The migration must descend from the latest pre-Phase-1 head."""
    assert phase1_mig.revision == "f9ahfeatmod"
    assert phase1_mig.down_revision == "f9agcanonperms"


def test_phase1_backfill_default_false_for_unknown_set(phase1_mig):
    before = {}
    after = phase1_mig._backfill_module_block(before, ("view", "edit"), False)
    assert after == {"view": False, "edit": False}


def test_phase1_backfill_opt_in_true_for_tam_yetki(phase1_mig):
    """Tam Yetki rows get default=True on missing keys via _backfill_row."""
    before = {"modules": {}}
    after = phase1_mig._backfill_row(before, "Tam Yetki")
    assert after["modules"]["discovery"] == {"view": True, "run": True}
    assert after["modules"]["vlan"] == {"view": True, "edit": True, "push": True}
    assert after["modules"]["racks"] == {"view": True, "edit": True, "delete": True}
    assert after["modules"]["maps"] == {"view": True}


def test_phase1_backfill_opt_in_true_for_org_admin(phase1_mig):
    before = {"modules": {}}
    after = phase1_mig._backfill_row(before, "Org Admin")
    assert after["modules"]["vlan"]["push"] is True
    assert after["modules"]["racks"]["delete"] is True


def test_phase1_backfill_default_false_for_custom_set(phase1_mig):
    """Operator-defined custom set (any name not in opt-in list) gets
    every new verb FALSE — explicit operator opt-in required to flip."""
    before = {"modules": {}}
    after = phase1_mig._backfill_row(before, "Operatör")
    for module in ("discovery", "vlan", "racks", "maps"):
        for verb, val in after["modules"][module].items():
            assert val is False, f"Operatör {module}.{verb} must default to False"


def test_phase1_backfill_existing_value_wins(phase1_mig):
    """Pre-existing keys are preserved. Idempotency core invariant."""
    before = {
        "modules": {
            "discovery": {"view": False, "run": False},   # explicit deny on Tam Yetki
            "vlan":      {"view": True,  "edit": False},  # partially set
        }
    }
    after = phase1_mig._backfill_row(before, "Tam Yetki")
    # discovery: explicit False values must NOT be overwritten to True
    assert after["modules"]["discovery"]["view"] is False
    assert after["modules"]["discovery"]["run"] is False
    # vlan: existing keys preserved, missing 'push' filled in (Tam Yetki → True)
    assert after["modules"]["vlan"]["view"] is True
    assert after["modules"]["vlan"]["edit"] is False
    assert after["modules"]["vlan"]["push"] is True


def test_phase1_backfill_unknown_modules_preserved(phase1_mig):
    """Forward-compat: future modules already on the row survive."""
    before = {
        "modules": {
            "devices": {"view": True, "edit": True},
            "future_unknown_module": {"some_verb": True},
        }
    }
    after = phase1_mig._backfill_row(before, "Tam Yetki")
    assert after["modules"]["devices"] == {"view": True, "edit": True}
    assert after["modules"]["future_unknown_module"] == {"some_verb": True}


def test_phase1_backfill_idempotent(phase1_mig):
    """Running the transform twice yields the same result; the
    migration body's `before == after → skip` short-circuit relies
    on this property."""
    before = {
        "modules": {
            "devices": {"view": True, "edit": True, "delete": True, "ssh": True},
        }
    }
    once = phase1_mig._backfill_row(before, "Tam Yetki")
    twice = phase1_mig._backfill_row(once, "Tam Yetki")
    assert once == twice


def test_phase1_downgrade_round_trip(phase1_mig):
    """upgrade(row) → downgrade(.) returns the row to a state where
    none of the four new module blocks exist. Pre-Phase-1 modules
    untouched."""
    before = {
        "modules": {
            "devices": {"view": True, "edit": True},
            "topology": {"view": True},
        }
    }
    upgraded = phase1_mig._backfill_row(before, "Tam Yetki")
    # Sanity: upgrade actually added the modules
    assert "discovery" in upgraded["modules"]
    assert "vlan" in upgraded["modules"]
    assert "racks" in upgraded["modules"]
    assert "maps" in upgraded["modules"]
    # Downgrade strips them
    downgraded = phase1_mig._downgrade_row(upgraded)
    for module in ("discovery", "vlan", "racks", "maps"):
        assert module not in downgraded["modules"], (
            f"downgrade must remove {module}"
        )
    # Pre-Phase-1 modules untouched
    assert downgraded["modules"]["devices"] == {"view": True, "edit": True}
    assert downgraded["modules"]["topology"] == {"view": True}


def test_phase1_backfill_malformed_row_fails_closed(phase1_mig):
    """A row whose module value isn't a dict gets a fail-closed
    block. NEVER inherits the Tam Yetki opt-in TRUE — a corrupt row
    must not silently elevate access."""
    after = phase1_mig._backfill_module_block(
        "not-a-dict", ("view", "edit"), True,  # opt-in default WAS True
    )
    assert after == {"view": False, "edit": False}


# ─── 4. racks.py endpoint gates ──────────────────────────────────────────


def _read_racks_source() -> str:
    racks_path = (
        Path(__file__).resolve().parent.parent
        / "app" / "api" / "v1" / "endpoints" / "racks.py"
    )
    return racks_path.read_text(encoding="utf-8")


def test_racks_module_imports_require_permission():
    """The require_permission helper must be imported (regression
    against a refactor that drops the gate import without updating
    the dependencies attribute)."""
    src = _read_racks_source()
    assert "require_permission" in src, (
        "racks.py must import require_permission for gate coverage"
    )
    assert 'require_permission("racks", "view")' in src
    assert 'require_permission("racks", "edit")' in src
    assert 'require_permission("racks", "delete")' in src


def _verb_for_route(src: str, decorator_pattern: str) -> str | None:
    """Extract the verb from a router decorator line.

    Returns the `verb` from `dependencies=[_RACK_<verb>]` or None
    if the decorator does not contain a dependencies entry.
    """
    line_match = re.search(decorator_pattern, src)
    if not line_match:
        return None
    line = line_match.group(0)
    verb_match = re.search(r"_RACK_(VIEW|EDIT|DELETE)", line)
    return verb_match.group(1).lower() if verb_match else None


@pytest.mark.parametrize("decorator_re,expected_verb", [
    # POST "" — create rack            → edit
    (r"@router\.post\(\"\",[^\)]+", "edit"),
    # GET ""  — list racks             → view
    (r"@router\.get\(\"\",[^\)]+",  "view"),
    # GET /unassigned/devices          → view
    (r"@router\.get\(\"/unassigned/devices\",[^\)]+", "view"),
    # GET {rack_name}                  → view
    (r"@router\.get\(\"/\{rack_name\}\",[^\)]+", "view"),
    # DELETE {rack_name}               → delete
    (r"@router\.delete\(\"/\{rack_name\}\",[^\)]+", "delete"),
    # PUT /devices/{device_id}/placement → edit
    (r"@router\.put\(\"/devices/\{device_id\}/placement\",[^\)]+", "edit"),
    # DELETE /devices/{device_id}/placement → edit (revoking placement is an edit, not a destructive delete)
    (r"@router\.delete\(\"/devices/\{device_id\}/placement\",[^\)]+", "edit"),
    # POST /{rack_name}/items           → edit
    (r"@router\.post\(\"/\{rack_name\}/items\",[^\)]+", "edit"),
    # PUT /{rack_name}/items/{item_id}  → edit
    (r"@router\.put\(\"/\{rack_name\}/items/\{item_id\}\",[^\)]+", "edit"),
    # DELETE /{rack_name}/items/{item_id} → delete (sub-item destructive)
    (r"@router\.delete\(\"/\{rack_name\}/items/\{item_id\}\",[^\)]+", "delete"),
])
def test_racks_endpoint_has_correct_verb_gate(decorator_re: str, expected_verb: str):
    src = _read_racks_source()
    verb = _verb_for_route(src, decorator_re)
    assert verb == expected_verb, (
        f"racks endpoint matching {decorator_re!r} should use _RACK_{expected_verb.upper()}; "
        f"found _RACK_{(verb or '?').upper()}"
    )
