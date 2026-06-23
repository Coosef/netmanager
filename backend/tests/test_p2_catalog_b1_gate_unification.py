"""P2-CATALOG-B1 — canonical engine gate unification (4 endpoints).

Closes the proven mismatch where the role-default `SYSTEM_ROLE_PERMISSIONS`
table withheld a verb (or used a typo verb) for a system_role even
though the explicit PermissionSet granted the canonical module.action.
For these four endpoints — and ONLY these four in this PR — the
authorization decision is now routed through
`permission_engine.resolve(module, action, location_id)` so the
PermissionSet toggle is the source of truth.

Endpoints touched:
  DELETE /devices/{id}              → devices.delete
  POST   /agents/{id}/snmp-get      → devices.view
  POST   /agents/{id}/discover      → devices.view
  POST   /agents/{id}/refresh-vault → devices.edit

The previous `device:read` / `device:update` typo verbs are not used
in these four endpoints anymore — the test suite pins their removal at
the source level.

Scope OUT:
  - fetch-info, move-location, lifecycle, backup, restore, task,
    playbook, terminal: still on legacy `has_permission()` gates;
    will be migrated in a later round.
  - PR #113 frontend: untouched.
  - PermissionSet schema / Alembic migrations / frontend: no change.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.models.user import SystemRole


# ─── 1. Source-level pins ────────────────────────────────────────────────


def _read(path: str) -> str:
    return (Path(__file__).resolve().parents[1] / path).read_text()


@pytest.fixture(scope="module")
def devices_src() -> str:
    return _read("app/api/v1/endpoints/devices.py")


@pytest.fixture(scope="module")
def agents_src() -> str:
    return _read("app/api/v1/endpoints/agents.py")


def test_devices_imports_require_permission(devices_src: str):
    assert "from app.core.deps import" in devices_src
    assert "require_permission" in devices_src
    # Annotated + User imports must exist so the Depends() signature
    # type-checks under Pydantic / FastAPI.
    assert "from typing import Annotated, Optional" in devices_src
    assert "from app.models.user import User" in devices_src


def test_agents_imports_require_permission(agents_src: str):
    assert "from app.core.deps import CurrentUser, require_permission" in agents_src
    assert "from app.models.user import User" in agents_src
    assert "from typing import Annotated, Optional" in agents_src


def test_delete_device_uses_require_permission_devices_delete(devices_src: str):
    """DELETE /devices/{id} must hand authorization to permission_engine
    via require_permission. The previous inline
    `current_user.has_permission("device:delete")` is gone."""
    # Locate the canonical DELETE endpoint declaration.
    canonical_route = '@router.delete("/{device_id}", status_code=204)'
    idx = devices_src.find(canonical_route)
    assert idx > 0, "DELETE /devices/{device_id} declaration missing"
    # Window covering the function signature.
    block = devices_src[idx:idx + 2200]
    assert (
        'require_permission("devices", "delete")' in block
    ), "DELETE endpoint must wire require_permission(devices, delete)"
    # The inline has_permission check inside this function body must be gone.
    # (Strip comments first so the rationale comment isn't matched.)
    import re
    block_no_comments = re.sub(r"#[^\n]*", "", block)
    # The endpoint body ends at the next `@router.` declaration.
    next_decl = block_no_comments.find("@router.")
    body = block_no_comments[:next_decl] if next_decl > 0 else block_no_comments
    assert 'has_permission("device:delete")' not in body, (
        "DELETE endpoint must NOT inline has_permission anymore"
    )


def test_snmp_get_uses_require_permission_devices_view(agents_src: str):
    canonical_route = '@router.post("/{agent_id}/snmp-get", response_model=dict)'
    idx = agents_src.find(canonical_route)
    assert idx > 0
    block = agents_src[idx:idx + 1400]
    assert 'require_permission("devices", "view")' in block
    # Pre-existing typo verb gone from THIS endpoint body.
    import re
    block_no_comments = re.sub(r"#[^\n]*", "", block)
    next_decl = block_no_comments.find("@router.")
    body = block_no_comments[:next_decl] if next_decl > 0 else block_no_comments
    assert 'has_permission("device:read")' not in body


def test_discover_uses_require_permission_devices_view(agents_src: str):
    canonical_route = '@router.post("/{agent_id}/discover", response_model=dict)'
    idx = agents_src.find(canonical_route)
    assert idx > 0
    block = agents_src[idx:idx + 1400]
    assert 'require_permission("devices", "view")' in block
    import re
    block_no_comments = re.sub(r"#[^\n]*", "", block)
    next_decl = block_no_comments.find("@router.")
    body = block_no_comments[:next_decl] if next_decl > 0 else block_no_comments
    assert 'has_permission("device:read")' not in body


def test_refresh_vault_uses_require_permission_devices_edit(agents_src: str):
    canonical_route = '@router.post("/{agent_id}/refresh-vault", response_model=dict)'
    idx = agents_src.find(canonical_route)
    assert idx > 0
    block = agents_src[idx:idx + 1500]
    assert 'require_permission("devices", "edit")' in block
    import re
    block_no_comments = re.sub(r"#[^\n]*", "", block)
    next_decl = block_no_comments.find("@router.")
    body = block_no_comments[:next_decl] if next_decl > 0 else block_no_comments
    assert 'has_permission("device:update")' not in body


def test_no_or_fallback_pattern_introduced(devices_src: str, agents_src: str):
    """The operator brief forbids any
        has_permission(...) OR engine.resolve(...)
    fallback pattern. Pin its absence in the touched files (allowing
    no false positives on unrelated `or` expressions)."""
    import re
    pattern = re.compile(
        r"has_permission\([^)]+\)\s+or\s+(?:await\s+)?permission_engine\.resolve",
        re.IGNORECASE,
    )
    for src in (devices_src, agents_src):
        assert pattern.search(src) is None, (
            "Forbidden OR-fallback combining has_permission with engine.resolve"
        )


def test_typo_verbs_not_used_by_b1_endpoints(devices_src: str, agents_src: str):
    """Pin a tighter invariant: the four endpoints touched by this PR
    must not reference `device:read` / `device:update` anywhere in
    their bodies."""
    blocks = []
    for src, decl in (
        (devices_src, '@router.delete("/{device_id}", status_code=204)'),
        (agents_src,  '@router.post("/{agent_id}/snmp-get", response_model=dict)'),
        (agents_src,  '@router.post("/{agent_id}/discover", response_model=dict)'),
        (agents_src,  '@router.post("/{agent_id}/refresh-vault", response_model=dict)'),
    ):
        idx = src.find(decl)
        assert idx > 0
        next_decl_idx = src.find("@router.", idx + len(decl))
        block_end = next_decl_idx if next_decl_idx > 0 else idx + 2000
        blocks.append(src[idx:block_end])
    import re
    for block in blocks:
        body_only = re.sub(r"#[^\n]*", "", block)
        body_only = re.sub(r"\"\"\"[\s\S]*?\"\"\"", "", body_only)
        assert 'device:read' not in body_only
        assert 'device:update' not in body_only


# ─── 2. Behavioral matrix (require_permission semantics) ──────────────────
#
# The full HTTP test path needs the FastAPI app + DB session + auth.
# In the unit-test environment that fixture stack is heavy; instead
# we exercise require_permission's `_checker` closure directly with a
# mocked PermissionEngine + RequestContext. This proves the gate's
# decision matrix matches what the four endpoints will see at
# runtime.


from app.core.deps import require_permission


def _make_ctx(
    *,
    has_location_access: bool = True,
    is_org_wide: bool = False,
    active_location_id: int | None = 12,
) -> SimpleNamespace:
    return SimpleNamespace(
        has_location_access=has_location_access,
        is_org_wide=is_org_wide,
        active_location_id=active_location_id,
    )


def _make_user(
    *,
    user_id: int = 10,
    username: str = "emre",
    system_role: str = SystemRole.LOCATION_ADMIN,
) -> SimpleNamespace:
    return SimpleNamespace(id=user_id, username=username, system_role=system_role)


def _patch_engine(monkeypatch: pytest.MonkeyPatch, returns: bool) -> AsyncMock:
    """Patch `permission_engine.resolve` to return `returns` once."""
    from app.services.rbac import engine as engine_mod
    mock = AsyncMock(return_value=returns)
    monkeypatch.setattr(engine_mod.permission_engine, "resolve", mock)
    return mock


@pytest.mark.asyncio
async def test_emre_tam_yetki_can_delete_device(monkeypatch: pytest.MonkeyPatch):
    """Case 1 — Emre (location_admin) + Tam Yetki perm_set
    (devices.delete=true) → DELETE authorization succeeds."""
    mock = _patch_engine(monkeypatch, returns=True)
    checker = require_permission("devices", "delete")
    user = _make_user(system_role=SystemRole.LOCATION_ADMIN)
    db = MagicMock()
    result = await checker(_make_ctx(active_location_id=12), user, db)
    assert result is user
    mock.assert_awaited_once_with(db, user, "devices", "delete", location_id=12)


@pytest.mark.asyncio
async def test_emre_sadece_goruntule_cannot_delete_device(monkeypatch: pytest.MonkeyPatch):
    """Case 2 — Emre (location_admin) + Sadece Görüntüle perm_set
    (devices.delete=false) → DELETE authorization rejected with 403."""
    from fastapi import HTTPException
    mock = _patch_engine(monkeypatch, returns=False)
    checker = require_permission("devices", "delete")
    user = _make_user(system_role=SystemRole.LOCATION_ADMIN)
    db = MagicMock()
    with pytest.raises(HTTPException) as exc_info:
        await checker(_make_ctx(active_location_id=12), user, db)
    assert exc_info.value.status_code == 403
    assert "devices.delete" in str(exc_info.value.detail)
    mock.assert_awaited_once_with(db, user, "devices", "delete", location_id=12)


@pytest.mark.asyncio
async def test_viewer_cannot_call_snmp_get(monkeypatch: pytest.MonkeyPatch):
    """Case 3a — viewer with no PermissionSet grants → snmp-get rejected."""
    from fastapi import HTTPException
    _patch_engine(monkeypatch, returns=False)
    checker = require_permission("devices", "view")
    user = _make_user(system_role=SystemRole.VIEWER, username="viewer")
    with pytest.raises(HTTPException) as exc_info:
        await checker(_make_ctx(active_location_id=12), user, MagicMock())
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_viewer_cannot_call_discover(monkeypatch: pytest.MonkeyPatch):
    """Case 3b — viewer → discover rejected."""
    from fastapi import HTTPException
    _patch_engine(monkeypatch, returns=False)
    checker = require_permission("devices", "view")
    with pytest.raises(HTTPException) as exc_info:
        await checker(_make_ctx(), _make_user(system_role=SystemRole.VIEWER), MagicMock())
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_viewer_cannot_call_refresh_vault(monkeypatch: pytest.MonkeyPatch):
    """Case 3c — viewer → refresh-vault rejected."""
    from fastapi import HTTPException
    _patch_engine(monkeypatch, returns=False)
    checker = require_permission("devices", "edit")
    with pytest.raises(HTTPException) as exc_info:
        await checker(_make_ctx(), _make_user(system_role=SystemRole.VIEWER), MagicMock())
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_tam_yetki_can_call_snmp_get(monkeypatch: pytest.MonkeyPatch):
    """Case 4a — Tam Yetki (devices.view=true) → snmp-get authorized."""
    mock = _patch_engine(monkeypatch, returns=True)
    checker = require_permission("devices", "view")
    user = _make_user()
    db = MagicMock()
    result = await checker(_make_ctx(active_location_id=12), user, db)
    assert result is user
    mock.assert_awaited_once_with(db, user, "devices", "view", location_id=12)


@pytest.mark.asyncio
async def test_tam_yetki_can_call_discover(monkeypatch: pytest.MonkeyPatch):
    """Case 4b — Tam Yetki → discover authorized."""
    _patch_engine(monkeypatch, returns=True)
    checker = require_permission("devices", "view")
    result = await checker(_make_ctx(active_location_id=12), _make_user(), MagicMock())
    assert result is not None


@pytest.mark.asyncio
async def test_tam_yetki_can_call_refresh_vault(monkeypatch: pytest.MonkeyPatch):
    """Case 4c — Tam Yetki (devices.edit=true) → refresh-vault authorized."""
    _patch_engine(monkeypatch, returns=True)
    checker = require_permission("devices", "edit")
    result = await checker(_make_ctx(active_location_id=12), _make_user(), MagicMock())
    assert result is not None


@pytest.mark.asyncio
async def test_cross_location_user_with_no_access_denied(monkeypatch: pytest.MonkeyPatch):
    """Case 5 — location-scoped user with no usable location (e.g.
    cross-location target whose `user_locations` row was revoked) is
    rejected BEFORE the permission lookup even runs."""
    from fastapi import HTTPException
    mock = _patch_engine(monkeypatch, returns=True)  # would say yes if asked
    checker = require_permission("devices", "delete")
    user = _make_user(system_role=SystemRole.LOCATION_ADMIN)
    with pytest.raises(HTTPException) as exc_info:
        await checker(_make_ctx(has_location_access=False), user, MagicMock())
    assert exc_info.value.status_code == 403
    # The engine MUST NOT be consulted when has_location_access is False.
    mock.assert_not_called()


@pytest.mark.asyncio
async def test_org_admin_gets_engine_call_with_loc_none(monkeypatch: pytest.MonkeyPatch):
    """Case 6a — org_admin is org-wide → require_permission calls
    engine.resolve with location_id=None so the engine's role-bypass
    short-circuit applies (Tam Yetki across the whole org)."""
    mock = _patch_engine(monkeypatch, returns=True)
    checker = require_permission("devices", "delete")
    user = _make_user(system_role=SystemRole.ORG_ADMIN)
    result = await checker(
        _make_ctx(is_org_wide=True, active_location_id=None),
        user,
        MagicMock(),
    )
    assert result is user
    mock.assert_awaited_once_with(
        MagicMock.__call__,  # placeholder for db arg position
        user,
        "devices",
        "delete",
        location_id=None,
    ) if False else mock.assert_awaited_once()
    # Inspect the call args specifically — keyword `location_id` is None.
    _, kwargs = mock.await_args
    assert kwargs.get("location_id") is None


@pytest.mark.asyncio
async def test_super_admin_engine_short_circuit(monkeypatch: pytest.MonkeyPatch):
    """Case 6b — super_admin: engine.resolve always returns True at the
    top of its body (regardless of perm_set). require_permission still
    calls it; the True return passes the gate."""
    _patch_engine(monkeypatch, returns=True)
    checker = require_permission("devices", "delete")
    result = await checker(
        _make_ctx(is_org_wide=True, active_location_id=None),
        _make_user(system_role=SystemRole.SUPER_ADMIN, username="admin"),
        MagicMock(),
    )
    assert result is not None


@pytest.mark.asyncio
async def test_agents_remove_still_requires_explicit_grant():
    """Case 6c — agents.remove is NOT touched by this PR. The
    `_require_agent_perm(user, "agents:remove", "device:delete")`
    gate at the agent DELETE endpoint stays on has_permission, so a
    location_admin without an explicit grant is still rejected. This
    test pins that the agents.py DELETE endpoint was not accidentally
    swept into this PR's scope."""
    src = _read("app/api/v1/endpoints/agents.py")
    # The DELETE agent endpoint declaration.
    idx = src.find('@router.delete("/{agent_id}", status_code=204)')
    assert idx > 0
    block = src[idx:idx + 2000]
    # Still uses _require_agent_perm with the legacy verbs.
    assert '_require_agent_perm(current_user, "agents:remove"' in block
    # Did NOT switch to require_permission for agents in this PR.
    assert 'require_permission("agents"' not in block
