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
