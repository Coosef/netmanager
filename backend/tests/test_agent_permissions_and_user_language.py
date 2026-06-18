"""Unit tests for the location-agent-permissions + user-language-profile work.

Two scopes covered here:

  1. Agent permission catalogue + alias map. Verifies that the new
     five-verb catalogue grants the right operations to each system
     role, that the legacy `agents:edit` verb still satisfies an
     `agents:update` check (and vice-versa), and that the
     PermissionEngine module-action alias honours the same rule for
     PermissionSet rows that have not yet been migrated.

  2. UserPreferencesUpdate / SUPPORTED_LANGUAGES contract. Verifies
     enum validation, empty-string rejection, NULL clearing, and
     mass-assignment safety (Pydantic `extra='forbid'`).

The tests are pure-Python / pydantic-only — no DB, no FastAPI client.
They are the minimal contract guard that any future refactor of the
catalogue or the preferences schema does not silently widen access or
allow an unsupported locale through.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.models.user import (
    AGENT_PERMISSION_ALIASES,
    SYSTEM_ROLE_PERMISSIONS,
    SystemRole,
    User,
)
from app.models.shared.permission_set import DEFAULT_PERMISSIONS
from app.services.rbac.engine import PermissionEngine
from app.schemas.user import (
    SUPPORTED_LANGUAGES,
    UserPreferencesUpdate,
)


# ────────────────────────────────────────────────────────────────────────────
# Agent permission catalogue — five verbs, role grants, alias map
# ────────────────────────────────────────────────────────────────────────────


def _check_permission(role: str, verb: str) -> bool:
    """Call User.has_permission with a stand-in receiver.

    We can't instantiate `User` here — it's a SQLAlchemy declarative
    model whose attribute set requires an active ORM session. Pass a
    plain SimpleNamespace as the receiver; `has_permission` only ever
    reads `self.system_role`, so any attribute-bearing object works.
    """
    return User.has_permission(SimpleNamespace(system_role=role), verb)


def _fake_user(role: str):
    """Wrap `_check_permission` so each test reads `u.has_permission(...)`
    the same way the real call sites do."""
    return SimpleNamespace(
        system_role=role,
        has_permission=lambda verb, r=role: _check_permission(r, verb),
    )


class TestAgentPermissionCatalog:
    def test_super_admin_has_every_agent_verb(self):
        u = _fake_user(SystemRole.SUPER_ADMIN)
        for verb in ("agents:view", "agents:install",
                     "agents:download_installer", "agents:update",
                     "agents:remove"):
            assert u.has_permission(verb), verb

    def test_org_admin_has_every_agent_verb(self):
        u = _fake_user(SystemRole.ORG_ADMIN)
        for verb in ("agents:view", "agents:install",
                     "agents:download_installer", "agents:update",
                     "agents:remove"):
            assert u.has_permission(verb), verb

    def test_location_admin_has_four_agent_verbs_but_not_remove(self):
        u = _fake_user(SystemRole.LOCATION_ADMIN)
        assert u.has_permission("agents:view")
        assert u.has_permission("agents:install")
        assert u.has_permission("agents:download_installer")
        assert u.has_permission("agents:update")
        # `remove` is destructive — withheld by default; org_admin must
        # opt in explicitly via a permission_set override.
        assert not u.has_permission("agents:remove")

    def test_viewer_can_only_see_agents(self):
        u = _fake_user(SystemRole.VIEWER)
        assert u.has_permission("agents:view")
        for verb in ("agents:install", "agents:download_installer",
                     "agents:update", "agents:remove"):
            assert not u.has_permission(verb), verb

    def test_unknown_role_denies_every_agent_verb(self):
        u = _fake_user("alien_role_value")
        for verb in ("agents:view", "agents:install",
                     "agents:download_installer", "agents:update",
                     "agents:remove"):
            assert not u.has_permission(verb), verb


class TestAgentPermissionAliasMap:
    def test_edit_and_update_alias_in_both_directions(self):
        # The alias map must be symmetric — a role granted ONLY the
        # legacy `agents:edit` verb must satisfy a check for the
        # canonical `agents:update`, and vice versa.
        assert "agents:edit" in AGENT_PERMISSION_ALIASES["agents:update"]
        assert "agents:update" in AGENT_PERMISSION_ALIASES["agents:edit"]

    def test_role_with_only_legacy_edit_satisfies_update_check(self):
        # Synth a role whose grants list carries ONLY `agents:edit`.
        SYSTEM_ROLE_PERMISSIONS["_test_legacy_edit_only"] = ["agents:edit"]
        try:
            u = _fake_user("_test_legacy_edit_only")
            assert u.has_permission("agents:edit")
            assert u.has_permission("agents:update"), \
                "legacy `agents:edit` must satisfy canonical `agents:update`"
        finally:
            SYSTEM_ROLE_PERMISSIONS.pop("_test_legacy_edit_only", None)

    def test_role_with_only_canonical_update_satisfies_edit_check(self):
        SYSTEM_ROLE_PERMISSIONS["_test_canonical_update_only"] = ["agents:update"]
        try:
            u = _fake_user("_test_canonical_update_only")
            assert u.has_permission("agents:update")
            assert u.has_permission("agents:edit"), \
                "canonical `agents:update` must satisfy legacy `agents:edit`"
        finally:
            SYSTEM_ROLE_PERMISSIONS.pop("_test_canonical_update_only", None)


class TestPermissionEngineModuleAliasing:
    def test_engine_check_legacy_edit_in_permset_grants_update(self):
        # A PermissionSet row still on the pre-migration schema toggles
        # {"agents": {"edit": true}}. The PermissionEngine alias map
        # makes that grant satisfy a check for `agents.update` too.
        perms = {
            "modules": {
                "agents": {"view": False, "edit": True},
            },
        }
        assert PermissionEngine._check(perms, "agents", "update")
        # The reverse direction also holds — a row migrated to the
        # canonical key grants the legacy verb.
        perms_canonical = {
            "modules": {"agents": {"view": False, "update": True}},
        }
        assert PermissionEngine._check(perms_canonical, "agents", "edit")

    def test_engine_check_alias_is_module_scoped(self):
        # The alias map for `agents` must not bleed into other modules.
        perms = {
            "modules": {
                "devices": {"edit": True},
            },
        }
        # `devices` has no alias map → no spurious grant.
        assert not PermissionEngine._check(perms, "devices", "update")


class TestDefaultPermissionsShape:
    def test_default_permissions_agents_block_has_all_five_verbs(self):
        agents = DEFAULT_PERMISSIONS["modules"]["agents"]
        assert set(agents.keys()) == {
            "view", "install", "download_installer", "update", "remove",
        }
        for verb in agents:
            assert agents[verb] is False, "Default must deny every verb"


# ────────────────────────────────────────────────────────────────────────────
# User preferences — language enum + mass-assignment safety
# ────────────────────────────────────────────────────────────────────────────


class TestUserPreferencesLanguageEnum:
    def test_supported_locales_are_exactly_four(self):
        assert SUPPORTED_LANGUAGES == {"tr", "en", "de", "ru"}

    @pytest.mark.parametrize("code", ["tr", "en", "de", "ru"])
    def test_accepts_each_supported_locale(self, code: str):
        payload = UserPreferencesUpdate(preferred_language=code)
        assert payload.preferred_language == code

    def test_accepts_null_to_clear_preference(self):
        payload = UserPreferencesUpdate(preferred_language=None)
        assert payload.preferred_language is None

    def test_normalises_casing_and_whitespace(self):
        payload = UserPreferencesUpdate(preferred_language="  EN  ")
        assert payload.preferred_language == "en"

    def test_rejects_empty_string(self):
        with pytest.raises(ValidationError):
            UserPreferencesUpdate(preferred_language="")

    def test_rejects_whitespace_only(self):
        with pytest.raises(ValidationError):
            UserPreferencesUpdate(preferred_language="   ")

    @pytest.mark.parametrize("code", ["fr", "es", "zh", "ja",
                                     "pt", "ar", "tr-TR", "en_US"])
    def test_rejects_unsupported_locale(self, code: str):
        with pytest.raises(ValidationError):
            UserPreferencesUpdate(preferred_language=code)

    def test_rejects_html_injection_attempt(self):
        with pytest.raises(ValidationError):
            UserPreferencesUpdate(preferred_language="<script>")

    def test_rejects_long_payload(self):
        with pytest.raises(ValidationError):
            UserPreferencesUpdate(preferred_language="x" * 64)


class TestMigrationJSONRoundTrip:
    """The `f9af_user_lang_agent_perms` migration backfills the
    permission_sets.permissions JSON column. The earlier version
    smuggled a Python dict through psycopg2 bound parameters, which
    raises `can't adapt type 'dict'` at runtime because psycopg2 has
    no default adapter for `dict`. The fix:

      1. `json.dumps()` the dict on the Python side
      2. `CAST(:p AS json)` in the SQL

    These tests load the migration via importlib (Alembic versions
    are not part of any importable package) and confirm:

      a) `_transform_agents_block_upgrade` returns a dict whose
         contents survive a `json.dumps()` → `json.loads()` round
         trip without loss (the actual production fix path).
      b) The serialised form is a JSON object (not a quoted string
         or list) so Postgres' `CAST(:p AS json)` parses it as an
         object node, not a scalar.
    """

    @staticmethod
    def _load_migration():
        # The migration file does `from alembic import op` at top
        # level, but `alembic.op` is only available inside an active
        # Alembic context. We mock it just enough for module load so
        # the pure-function transforms (which never touch `op`) are
        # callable from tests.
        import sys
        import types
        if "alembic" not in sys.modules:
            sys.modules["alembic"] = types.ModuleType("alembic")
        sys.modules["alembic"].op = types.SimpleNamespace(
            add_column=lambda *a, **kw: None,
            drop_column=lambda *a, **kw: None,
            get_bind=lambda: None,
        )
        path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "f9af_user_lang_agent_perms.py"
        spec = importlib.util.spec_from_file_location("f9af_migration", path)
        assert spec is not None and spec.loader is not None
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_legacy_to_canonical_block_round_trips_through_json(self):
        mod = self._load_migration()
        legacy = {"view": True, "edit": True}
        canonical = mod._transform_agents_block_upgrade(legacy)
        # The upgrade transform must produce a dict json.dumps can
        # serialise without TypeError (no datetime / set / bytes
        # leaking in from the original row).
        encoded = json.dumps(canonical)
        decoded = json.loads(encoded)
        assert decoded == canonical
        # Sanity — the new 5-verb shape is present.
        for k in ("view", "install", "download_installer", "update", "remove"):
            assert k in canonical

    def test_downgrade_block_round_trips_through_json(self):
        mod = self._load_migration()
        canonical = {
            "view": True, "install": False, "download_installer": True,
            "update": True, "remove": False,
        }
        legacy = mod._transform_agents_block_downgrade(canonical)
        encoded = json.dumps(legacy)
        decoded = json.loads(encoded)
        assert decoded == legacy
        assert set(legacy.keys()) == {"view", "edit"}

    def test_serialised_payload_is_a_json_object_not_a_quoted_string(self):
        # Postgres' CAST(:p AS json) on a Python-encoded string MUST
        # parse into a json object node, not a scalar string.
        # `json.dumps()` of a dict yields the string '{"...":...}'.
        # Postgres CAST then re-reads it as an object. If we instead
        # passed `str(d)` (Python repr), Postgres would fail because
        # repr uses single quotes which are not valid JSON.
        mod = self._load_migration()
        canonical = mod._transform_agents_block_upgrade({"view": False, "edit": True})
        # Mimic the production wrap: the migration wraps the agents
        # block in the full permissions dict before calling
        # json.dumps(permissions). Sanity-check that step.
        wrapper = {"modules": {"agents": canonical}}
        encoded = json.dumps(wrapper)
        assert encoded.startswith('{"modules"')
        # Round-trip the wrapper.
        assert json.loads(encoded) == wrapper

    def test_idempotent_transform_does_not_double_wrap_legacy_key(self):
        # Running the migration twice on already-migrated rows must
        # not append duplicate keys or corrupt the JSON shape — the
        # production deploy retry path relies on this.
        mod = self._load_migration()
        legacy = {"view": True, "edit": True}
        first = mod._transform_agents_block_upgrade(legacy)
        second = mod._transform_agents_block_upgrade(first)
        # The second pass MUST equal the first — no drift.
        assert first == second
        # And both must json-round-trip.
        assert json.loads(json.dumps(first)) == first
        assert json.loads(json.dumps(second)) == second


class TestUserPreferencesMassAssignment:
    def test_rejects_role_field(self):
        # Mass-assignment safety: an attacker who tries to smuggle a
        # role escalation through the preferences endpoint must be
        # rejected by Pydantic's `extra='forbid'` config.
        with pytest.raises(ValidationError):
            UserPreferencesUpdate.model_validate({
                "preferred_language": "tr",
                "role": "super_admin",
            })

    def test_rejects_organization_id_field(self):
        with pytest.raises(ValidationError):
            UserPreferencesUpdate.model_validate({
                "preferred_language": "tr",
                "organization_id": 999,
            })

    def test_rejects_system_role_field(self):
        with pytest.raises(ValidationError):
            UserPreferencesUpdate.model_validate({
                "preferred_language": "tr",
                "system_role": "super_admin",
            })

    def test_rejects_password_field(self):
        with pytest.raises(ValidationError):
            UserPreferencesUpdate.model_validate({
                "preferred_language": "tr",
                "password": "new_password",
            })

    def test_rejects_allowed_ips_field(self):
        with pytest.raises(ValidationError):
            UserPreferencesUpdate.model_validate({
                "preferred_language": "tr",
                "allowed_ips": "0.0.0.0/0",
            })

    def test_rejects_arbitrary_extra_field(self):
        with pytest.raises(ValidationError):
            UserPreferencesUpdate.model_validate({
                "preferred_language": "tr",
                "is_active": False,
            })

    def test_empty_payload_is_accepted_and_clears_preference(self):
        # An empty payload is a no-op — preferred_language defaults to
        # None which the endpoint treats as "clear the preference".
        payload = UserPreferencesUpdate.model_validate({})
        assert payload.preferred_language is None
