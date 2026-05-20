"""
Faz 8 Phase E — user_locations as the single source of truth.

A user's location access is derived from user_locations, never from the
organization. The X-Location-Id header (HTTP) and the location query
parameter (WebSocket) are validated against that set on every request;
a stale / forged / revoked value fails closed. Org-wide roles
(super-admin, org-admin) are exempt — explicitly, not by fallback.

These tests pin:
  * resolve_location_context — one / many / no locations, missing &
    invalid header, super-admin, org-admin, revoked-after-session
  * assert_location_allowed / require_active_location — cross-location
    rejection (403) and no-location rejection
  * the WebSocket frame filter — a location-scoped connection only sees
    its own locations' events
  * the background-task scope envelope — scoped vs system-owned runs,
    and stale-scope (revoked location) revalidation

Pure-Python enforcement — SQLite is sufficient (RLS is a no-op there).
"""
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.database import Base
import app.models  # noqa: F401 — registers every model + the scoping hook
from app.core.org_context import (
    clear_org_context, get_current_location_id, get_current_org_id,
    get_is_super_admin,
)
from app.core.request_context import (
    LocationAccessError, _NO_ACCESS, assert_location_allowed,
    require_active_location, resolve_location_context,
)
from app.models.user import SystemRole


# ── async SQLite harness ─────────────────────────────────────────────────────

def _create_tables(sync_conn):
    from app.models.shared.organization import Organization
    from app.models.location import Location
    from app.models.user import User
    from app.models.user_location import UserLocation
    from app.models.device import Device
    from app.models.audit_log import AuditLog
    Base.metadata.create_all(sync_conn, tables=[
        Organization.__table__, Location.__table__, User.__table__,
        UserLocation.__table__, Device.__table__, AuditLog.__table__,
    ])


class _adb:
    async def __aenter__(self):
        self._engine = create_async_engine("sqlite+aiosqlite://")
        async with self._engine.begin() as conn:
            await conn.run_sync(_create_tables)
        self._session = async_sessionmaker(self._engine, expire_on_commit=False)()
        return self._session

    async def __aexit__(self, *exc):
        await self._session.close()
        await self._engine.dispose()


@pytest.fixture(autouse=True)
def _clean_ctx():
    clear_org_context()
    yield
    clear_org_context()


async def _org(db, oid, slug):
    from app.models.shared.organization import Organization
    o = Organization(id=oid, name=slug.title(), slug=slug)
    db.add(o)
    await db.flush()
    return o


async def _location(db, lid, org_id, name, deleted=False):
    from datetime import datetime, timezone
    from app.models.location import Location
    loc = Location(
        id=lid, name=name, organization_id=org_id,
        deleted_at=datetime.now(timezone.utc) if deleted else None,
    )
    db.add(loc)
    await db.flush()
    return loc


async def _user(db, uid, org_id, system_role=SystemRole.VIEWER):
    # M6 final drop — legacy `role` column gone; tests use `system_role` only.
    from app.models.user import User
    u = User(
        id=uid, username=f"u{uid}", email=f"u{uid}@x.io", hashed_password="h",
        organization_id=org_id, system_role=system_role,
    )
    db.add(u)
    await db.flush()
    return u


async def _assign(db, user_id, location_id, loc_role="location_viewer"):
    from app.models.user_location import UserLocation
    ul = UserLocation(user_id=user_id, location_id=location_id, loc_role=loc_role)
    db.add(ul)
    await db.flush()
    return ul


# ── resolve_location_context — the user_locations source of truth ────────────

@pytest.mark.asyncio
async def test_user_with_one_location_no_header_gets_that_location():
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 5, 1, "HQ")
        u = await _user(db, 1, 1)
        await _assign(db, 1, 5)
        ctx = await resolve_location_context(db, u, x_location_id=None)
    assert ctx.allowed_location_ids == (5,)
    assert ctx.active_location_id == 5          # deterministic — the one
    assert ctx.has_location_access is True


@pytest.mark.asyncio
async def test_user_with_many_locations_no_header_gets_deterministic_default():
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 9, 1, "C")
        await _location(db, 5, 1, "A")
        await _location(db, 7, 1, "B")
        u = await _user(db, 1, 1)
        for lid in (9, 5, 7):
            await _assign(db, 1, lid)
        ctx = await resolve_location_context(db, u, x_location_id=None)
    assert ctx.allowed_location_ids == (5, 7, 9)
    assert ctx.active_location_id == 5          # lowest id — deterministic


@pytest.mark.asyncio
async def test_user_with_many_locations_valid_header_is_honoured():
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 5, 1, "A")
        await _location(db, 7, 1, "B")
        u = await _user(db, 1, 1)
        await _assign(db, 1, 5)
        await _assign(db, 1, 7)
        ctx = await resolve_location_context(db, u, x_location_id=7)
    assert ctx.active_location_id == 7
    assert ctx.requested_location_rejected is False


@pytest.mark.asyncio
async def test_user_with_no_locations_fails_closed():
    """A location-scoped user with no user_locations row gets the
    no-access sentinel — RLS then scopes every location query to zero."""
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 5, 1, "HQ")
        u = await _user(db, 1, 1)  # no _assign
        ctx = await resolve_location_context(db, u, x_location_id=None)
    assert ctx.allowed_location_ids == ()
    assert ctx.active_location_id == _NO_ACCESS
    assert ctx.has_location_access is False


@pytest.mark.asyncio
async def test_invalid_location_header_is_rejected_and_fails_closed():
    """A header naming a location the user may not access is rejected
    (audited) and degrades to the user's own default — never honoured."""
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 5, 1, "mine")
        await _location(db, 8, 1, "not-mine")
        u = await _user(db, 1, 1)
        await _assign(db, 1, 5)
        ctx = await resolve_location_context(db, u, x_location_id=8)
    assert ctx.requested_location_rejected is True
    assert ctx.requested_location_id == 8
    assert ctx.active_location_id == 5          # fell back to the allowed one


@pytest.mark.asyncio
async def test_cross_org_location_in_user_locations_grants_nothing():
    """A user_locations row pointing at another org's location is
    intersected away — it never widens access."""
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _org(db, 2, "bravo")
        await _location(db, 5, 1, "alpha-hq")
        await _location(db, 99, 2, "bravo-hq")
        u = await _user(db, 1, 1)
        await _assign(db, 1, 5)
        await _assign(db, 1, 99)               # cross-org — must be ignored
        ctx = await resolve_location_context(db, u, x_location_id=None)
    assert ctx.allowed_location_ids == (5,)


@pytest.mark.asyncio
async def test_deleted_location_is_not_accessible():
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 5, 1, "live")
        await _location(db, 6, 1, "archived", deleted=True)
        u = await _user(db, 1, 1)
        await _assign(db, 1, 5)
        await _assign(db, 1, 6)
        ctx = await resolve_location_context(db, u, x_location_id=None)
    assert ctx.allowed_location_ids == (5,)


@pytest.mark.asyncio
async def test_org_admin_is_org_wide_not_constrained_by_user_locations():
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 5, 1, "A")
        await _location(db, 7, 1, "B")
        u = await _user(db, 1, 1, system_role=SystemRole.ORG_ADMIN)
        # no user_locations rows — an org-admin still sees the whole org
        ctx = await resolve_location_context(db, u, x_location_id=None)
    assert ctx.is_org_wide is True
    assert set(ctx.allowed_location_ids) == {5, 7}
    assert ctx.active_location_id is None       # None = all org locations


@pytest.mark.asyncio
async def test_super_admin_is_unconstrained():
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 5, 1, "A")
        u = await _user(db, 99, None, system_role=SystemRole.SUPER_ADMIN)
        ctx = await resolve_location_context(db, u, x_location_id=None)
    assert ctx.is_super_admin is True
    assert ctx.allowed_location_ids == ()       # () = unconstrained
    assert ctx.has_location_access is True


@pytest.mark.asyncio
async def test_super_admin_x_org_scopes_into_one_org():
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _org(db, 2, "bravo")
        await _location(db, 7, 2, "bravo-hq")
        u = await _user(db, 99, None, system_role=SystemRole.SUPER_ADMIN)
        ctx = await resolve_location_context(db, u, x_org_id=2, x_location_id=None)
    assert ctx.organization_id == 2
    assert ctx.is_super_admin is False          # dropped the bypass
    assert ctx.is_org_wide is True
    assert ctx.allowed_location_ids == (7,)


@pytest.mark.asyncio
async def test_revoked_location_access_after_session_fails_closed():
    """A user holds location 5; the user_locations row is later removed.
    Re-resolving the context (every request / WS revalidation does this)
    no longer grants 5 — the session cannot keep using the stale scope."""
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 5, 1, "HQ")
        u = await _user(db, 1, 1)
        ul = await _assign(db, 1, 5)
        first = await resolve_location_context(db, u, x_location_id=5)
        assert first.active_location_id == 5

        await db.delete(ul)                     # access revoked
        await db.flush()
        second = await resolve_location_context(db, u, x_location_id=5)
    assert second.allowed_location_ids == ()
    assert second.active_location_id == _NO_ACCESS
    assert second.requested_location_rejected is True
    assert second.has_location_access is False


# ── assert_location_allowed / require_active_location ────────────────────────

def _ctx(**kw):
    from app.core.request_context import LocationContext
    base = dict(
        user_id=1, organization_id=1, system_role="viewer",
        is_super_admin=False, is_org_wide=False,
        allowed_location_ids=(5, 7), active_location_id=5,
        requested_location_id=None, requested_location_rejected=False,
    )
    base.update(kw)
    return LocationContext(**base)


def test_assert_location_allowed_passes_for_held_location():
    assert_location_allowed(_ctx(), 7)          # no raise


def test_assert_location_allowed_rejects_cross_location():
    with pytest.raises(LocationAccessError) as exc:
        assert_location_allowed(_ctx(), 999)
    assert exc.value.status_code == 403


def test_assert_location_allowed_super_admin_passes():
    assert_location_allowed(_ctx(is_super_admin=True, allowed_location_ids=()), 999)


def test_require_active_location_rejects_no_access_user():
    with pytest.raises(LocationAccessError) as exc:
        require_active_location(_ctx(allowed_location_ids=(), active_location_id=_NO_ACCESS))
    assert exc.value.status_code == 403


def test_require_active_location_returns_active():
    assert require_active_location(_ctx(active_location_id=7)) == 7


# ── WebSocket frame filter — location-scoped delivery ────────────────────────

def _ws(**kw):
    from app.api.v1.endpoints.ws import WsScope
    base = dict(
        user_id=1, organization_id=1, is_super_admin=False, is_org_wide=False,
        allowed_location_ids=(5, 7), active_location_id=None, ok=True,
    )
    base.update(kw)
    return WsScope(**base)


def test_ws_frame_location_scoped_sees_only_held_locations():
    from app.api.v1.endpoints.ws import _frame_visible
    scope = _ws(allowed_location_ids=(5, 7))
    assert _frame_visible('{"location_id": 5}', scope) is True
    assert _frame_visible('{"location_id": 7}', scope) is True
    assert _frame_visible('{"location_id": 9}', scope) is False   # not held
    assert _frame_visible('{"location_id": null}', scope) is False  # org-level


def test_ws_frame_location_scoped_active_filter_narrows():
    from app.api.v1.endpoints.ws import _frame_visible
    scope = _ws(allowed_location_ids=(5, 7), active_location_id=5)
    assert _frame_visible('{"location_id": 5}', scope) is True
    assert _frame_visible('{"location_id": 7}', scope) is False   # not active


def test_ws_frame_org_wide_sees_whole_org():
    from app.api.v1.endpoints.ws import _frame_visible
    scope = _ws(is_org_wide=True)
    assert _frame_visible('{"location_id": 9}', scope) is True
    assert _frame_visible('{"location_id": null}', scope) is True


def test_ws_frame_super_admin_sees_everything():
    from app.api.v1.endpoints.ws import _frame_visible
    scope = _ws(is_super_admin=True)
    assert _frame_visible('{"location_id": 12345}', scope) is True
    assert _frame_visible("not-json", scope) is True


# ── background task scope envelope ───────────────────────────────────────────

def test_apply_task_scope_scoped_run_sets_real_context():
    from app.workers.task_scope import apply_task_scope, build_task_scope
    scoped = apply_task_scope(build_task_scope(3, 8))
    assert scoped is True
    assert get_current_org_id() == 3
    assert get_current_location_id() == 8
    assert get_is_super_admin() is False


def test_apply_task_scope_system_owned_run_is_super_admin():
    from app.workers.task_scope import apply_task_scope
    assert apply_task_scope(None) is False
    assert get_is_super_admin() is True
    # a scope with no organization_id is also treated as system-owned
    assert apply_task_scope({"organization_id": None}) is False
    assert get_is_super_admin() is True


def test_scope_from_request_reads_the_envelope():
    from app.workers.task_scope import SCOPE_HEADER, scope_from_request
    env = {"organization_id": 1, "location_id": 2}
    assert scope_from_request(SimpleNamespace(**{SCOPE_HEADER: env})) == env
    assert scope_from_request(SimpleNamespace(headers={SCOPE_HEADER: env})) == env
    assert scope_from_request(SimpleNamespace(headers={})) is None
    assert scope_from_request(None) is None


@pytest.mark.asyncio
async def test_task_scope_valid_rejects_revoked_location():
    """A replayed/delayed task whose location was deleted must not run."""
    from app.workers.task_scope import build_task_scope, task_scope_valid
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 5, 1, "live")
        await _location(db, 6, 1, "gone", deleted=True)
        assert await task_scope_valid(db, build_task_scope(1, 5)) is True
        assert await task_scope_valid(db, build_task_scope(1, 6)) is False
        assert await task_scope_valid(db, None) is True            # system-owned
        assert await task_scope_valid(db, build_task_scope(1, None)) is True  # org-wide
