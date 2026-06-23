"""P2-CATALOG-A — canonical permission keys schema + backfill contract.

Three scopes covered:

  1. DEFAULT_PERMISSIONS schema. Verifies that the five new keys are
     present + default to False, and that pre-existing keys did not
     regress.

  2. Provisioner presets. Verifies that the three starter
     PermissionSets (Sadece Görüntüle / Operatör / Tam Yetki) emit
     the new keys with the operator-specified default values.

  3. Alembic migration pure-function transforms. The migration body
     factors the backfill logic into a pair of pure functions
     (`_backfill_devices_block`, `_backfill_config_backups_block`) so
     the policy can be tested without a live database.
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


def test_default_permissions_devices_has_canonical_keys():
    devices = DEFAULT_PERMISSIONS["modules"]["devices"]
    for key in ("view", "create", "edit", "delete", "ssh", "connect", "move"):
        assert key in devices, f"devices.{key} missing from DEFAULT_PERMISSIONS"
        assert devices[key] is False, f"devices.{key} default must be False"


def test_default_permissions_config_backups_has_canonical_keys():
    cb = DEFAULT_PERMISSIONS["modules"]["config_backups"]
    for key in ("view", "edit", "delete", "backup", "restore"):
        assert key in cb, f"config_backups.{key} missing from DEFAULT_PERMISSIONS"
        assert cb[key] is False, f"config_backups.{key} default must be False"


def test_default_permissions_pre_existing_keys_preserved():
    # Pre-canonical keys must not have regressed.
    modules = DEFAULT_PERMISSIONS["modules"]
    assert "tasks" in modules and modules["tasks"] == {
        "view": False, "create": False, "cancel": False,
    }
    assert "agents" in modules
    for key in ("view", "install", "download_installer", "update", "remove"):
        assert key in modules["agents"]


# ─── 2. Provisioner presets ────────────────────────────────────────────────


def test_viewer_preset_has_all_new_keys_false():
    p = _viewer_permissions()["modules"]
    # Görüntüleyici sets every key to (action == "view") — every NEW
    # action key must therefore evaluate to False.
    for key in ("create", "edit", "delete", "ssh", "connect", "move"):
        assert p["devices"][key] is False, f"viewer devices.{key} should be False"
    for key in ("edit", "delete", "backup", "restore"):
        assert p["config_backups"][key] is False, f"viewer config_backups.{key} should be False"


def test_operator_preset_grants_connect_and_backup_restore():
    p = _operator_permissions()["modules"]
    # Operator preset historically grants devices.ssh. The canonical
    # devices.connect rides alongside it (Bilgi Çek must be enabled
    # for the operator who already opens SSH sessions for commands).
    assert p["devices"]["view"] is True
    assert p["devices"]["ssh"] is True
    assert p["devices"]["connect"] is True
    # Destructive ownership verbs stay OFF on the operator preset —
    # operator brief: "Operatör setinde devices.move=false, devices.create=false".
    assert p["devices"]["move"] is False
    assert p["devices"]["create"] is False
    # config_backups: backup + restore inherit alongside edit (existing
    # edit grant covered both flows in production).
    assert p["config_backups"]["edit"] is True
    assert p["config_backups"]["backup"] is True
    assert p["config_backups"]["restore"] is True


def test_full_preset_grants_every_new_key():
    p = _full_permissions()["modules"]
    # "Tam Yetki" iterates DEFAULT_PERMISSIONS and sets every action
    # True (except `users`). Every NEW canonical key MUST therefore
    # be True on this preset — including the destructive
    # ownership verbs.
    for key in ("view", "create", "edit", "delete", "ssh", "connect", "move"):
        assert p["devices"][key] is True, f"Tam Yetki devices.{key} should be True"
    for key in ("view", "edit", "delete", "backup", "restore"):
        assert p["config_backups"][key] is True, f"Tam Yetki config_backups.{key} should be True"


# ─── 3. Migration backfill — pure-function unit tests ─────────────────────


def _load_migration_module():
    """Load the f9ag_canonical_permission_keys migration as a module
    object so its pure helpers can be exercised without alembic.

    The migration imports `from alembic import op` at module scope.
    Alembic's runtime `op` proxy is only valid inside an active
    migration context — for pure-function unit testing we stub a
    minimal `alembic.op` so the import resolves without bringing the
    actual alembic dependency into the test virtualenv.
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
        / "alembic" / "versions" / "f9ag_canonical_permission_keys.py"
    )
    spec = importlib.util.spec_from_file_location(
        "f9ag_canonical_permission_keys", path,
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def migration_mod():
    return _load_migration_module()


def test_migration_revision_chain(migration_mod):
    assert migration_mod.revision == "f9agcanonperms"
    assert migration_mod.down_revision == "f9afuserlangperms"


def test_backfill_devices_connect_inherits_ssh(migration_mod):
    before = {"view": True, "edit": False, "delete": False, "ssh": True}
    after = migration_mod._backfill_devices_block(before, "Operatör")
    assert after["connect"] is True, "devices.connect should inherit ssh=True"
    # ssh value not regressed
    assert after["ssh"] is True


def test_backfill_devices_connect_inherits_ssh_false(migration_mod):
    before = {"view": True, "edit": False, "delete": False, "ssh": False}
    after = migration_mod._backfill_devices_block(before, "Sadece Görüntüle")
    assert after["connect"] is False
    assert after["ssh"] is False


def test_backfill_devices_move_create_false_by_default(migration_mod):
    """Operator preset / custom set should get move=create=False."""
    before = {"view": True, "edit": True, "delete": False, "ssh": True}
    after = migration_mod._backfill_devices_block(before, "Operatör")
    assert after["move"] is False, "devices.move must default to False on Operatör"
    assert after["create"] is False, "devices.create must default to False on Operatör"


def test_backfill_devices_move_create_true_on_tam_yetki(migration_mod):
    before = {"view": True, "edit": True, "delete": True, "ssh": True}
    after = migration_mod._backfill_devices_block(before, "Tam Yetki")
    assert after["move"] is True, "Tam Yetki must default devices.move=True"
    assert after["create"] is True, "Tam Yetki must default devices.create=True"
    assert after["connect"] is True


def test_backfill_devices_move_create_true_on_org_admin(migration_mod):
    before = {"view": True, "edit": True, "delete": True, "ssh": True}
    after = migration_mod._backfill_devices_block(before, "Org Admin")
    assert after["move"] is True
    assert after["create"] is True


def test_backfill_existing_canonical_value_wins(migration_mod):
    """An already-canonical row keeps its explicit toggle even when
    the inherited default differs. This is the idempotency guarantee."""
    # Operator deliberately set connect=False even though ssh=True.
    before = {"view": True, "edit": False, "ssh": True, "connect": False}
    after = migration_mod._backfill_devices_block(before, "Sadece Görüntüle")
    assert after["connect"] is False, (
        "existing connect=False must NOT be overwritten by ssh=True"
    )
    # Operator deliberately set move=True on a non-template set.
    before = {"view": True, "ssh": True, "move": True}
    after = migration_mod._backfill_devices_block(before, "Operatör")
    assert after["move"] is True


def test_backfill_unknown_keys_preserved(migration_mod):
    """Forward-compat: unknown keys on the row must survive the
    transform untouched."""
    before = {
        "view": True, "edit": True, "delete": False, "ssh": True,
        "future_unknown_key": True,
    }
    after = migration_mod._backfill_devices_block(before, "Tam Yetki")
    assert after["future_unknown_key"] is True


def test_backfill_config_backups_inherits_edit(migration_mod):
    before = {"view": True, "edit": True, "delete": False}
    after = migration_mod._backfill_config_backups_block(before)
    assert after["backup"] is True
    assert after["restore"] is True


def test_backfill_config_backups_inherits_edit_false(migration_mod):
    before = {"view": True, "edit": False, "delete": False}
    after = migration_mod._backfill_config_backups_block(before)
    assert after["backup"] is False
    assert after["restore"] is False


def test_backfill_config_backups_existing_value_wins(migration_mod):
    before = {"view": True, "edit": True, "backup": False}
    after = migration_mod._backfill_config_backups_block(before)
    assert after["backup"] is False, "explicit backup=False must NOT be overwritten"
    assert after["restore"] is True


def test_backfill_row_full_transform(migration_mod):
    """End-to-end transform on a full permissions dict."""
    before = {
        "modules": {
            "devices":        {"view": True, "edit": True, "delete": False, "ssh": True},
            "config_backups": {"view": True, "edit": True, "delete": False},
            "tasks":          {"view": True, "create": True, "cancel": False},
        }
    }
    after = migration_mod._backfill_row(before, "Tam Yetki")
    # devices block fully canonical
    d = after["modules"]["devices"]
    for key in ("view", "edit", "delete", "ssh", "connect", "move", "create"):
        assert key in d
    assert d["connect"] is True       # ssh=True → connect=True
    assert d["move"] is True          # Tam Yetki opt-in
    assert d["create"] is True        # Tam Yetki opt-in
    # config_backups block fully canonical
    cb = after["modules"]["config_backups"]
    for key in ("view", "edit", "delete", "backup", "restore"):
        assert key in cb
    assert cb["backup"] is True       # inherits edit
    assert cb["restore"] is True
    # Other modules untouched
    assert after["modules"]["tasks"] == before["modules"]["tasks"]


def test_backfill_idempotent(migration_mod):
    """Running the transform twice on the same row yields the same
    result. This is the property the migration body relies on for its
    `before == after → skip` short-circuit."""
    before = {
        "modules": {
            "devices":        {"view": True, "edit": True, "delete": True, "ssh": True},
            "config_backups": {"view": True, "edit": True, "delete": True},
        }
    }
    once = migration_mod._backfill_row(before, "Tam Yetki")
    twice = migration_mod._backfill_row(once, "Tam Yetki")
    assert once == twice


def test_downgrade_round_trip(migration_mod):
    """upgrade(row) → downgrade(.) returns to the row's pre-migration
    shape for any row that had no canonical keys at upgrade time."""
    before = {
        "modules": {
            "devices":        {"view": True, "edit": True, "delete": True, "ssh": True},
            "config_backups": {"view": True, "edit": True, "delete": True},
        }
    }
    upgraded = migration_mod._backfill_row(before, "Tam Yetki")
    downgraded = migration_mod._downgrade_row(upgraded)
    # devices: only the pre-migration keys remain
    d = downgraded["modules"]["devices"]
    assert set(d.keys()) == {"view", "edit", "delete", "ssh"}
    # config_backups: same
    cb = downgraded["modules"]["config_backups"]
    assert set(cb.keys()) == {"view", "edit", "delete"}
