"""PLATFORM/OPERATIONS-PHASE1A (2026-06-22) — X-Org-Id resolver tests.

Pins the backend contract the Phase 1A frontend org switcher relies on:

  1. A super-admin who sends X-Org-Id is scoped INTO that organization.
     The super-admin RLS bypass (`sup` flag) is dropped — they then see
     exactly what an admin of that organization would see.

  2. A normal user who sends X-Org-Id is IGNORED. The bypass-drop only
     fires when the caller was a super-admin to begin with; an attacker
     who forges the header in a non-super-admin session cannot escape
     their own tenant.

  3. An X-Location-Id that belongs to a DIFFERENT organization than the
     resolved scope is REJECTED — fail-closed with an audit warning.

  4. `_accessible_locations` returns the scoped tenant's locations
     ONLY when X-Org-Id is set — the pre-fix behavior (super-admin
     sees ALL across-org locations) only fires when X-Org-Id is
     ABSENT.

This file does NOT touch:
  - production DB / VPS / migration
  - loc=9 / macm4 / movempic (the fixtures use distinct ids/names)
  - T1.04 / Windows Agent state
  - PR #103/#104/#105 frontend source
"""
from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.database import Base
import app.models  # noqa: F401 — registers every model + the scoping hook
from app.core.org_context import clear_org_context
from app.core.request_context import (
    LocationContext,
    is_super_admin,
    is_org_wide,
    resolve_location_context,
)
from app.models.user import SystemRole


# ── async SQLite harness — mirrors the pattern other backend tests use ──


def _create_tables(sync_conn):
    from app.models.shared.organization import Organization
    from app.models.location import Location
    from app.models.user import User
    from app.models.user_location import UserLocation
    Base.metadata.create_all(
        sync_conn,
        tables=[
            Organization.__table__,
            Location.__table__,
            User.__table__,
            UserLocation.__table__,
        ],
    )


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


async def _seed_org(db, oid, name):
    from app.models.shared.organization import Organization
    o = Organization(id=oid, name=name, slug=name.lower())
    db.add(o)
    await db.flush()
    return o


async def _seed_loc(db, lid, org_id, name):
    from app.models.location import Location
    loc = Location(id=lid, name=name, organization_id=org_id)
    db.add(loc)
    await db.flush()
    return loc


async def _seed_user(db, uid, org_id, role=SystemRole.SUPER_ADMIN):
    from app.models.user import User
    u = User(
        id=uid, username=f"u{uid}", email=f"u{uid}@x.io",
        hashed_password="h", organization_id=org_id, system_role=role,
    )
    db.add(u)
    await db.flush()
    return u


# ─── is_super_admin / is_org_wide predicates ─────────────────────────────


@pytest.mark.asyncio
async def test_is_super_admin_for_super_admin_role():
    async with _adb() as db:
        await _seed_org(db, 1, "alpha")
        user = await _seed_user(db, 1, 1, role=SystemRole.SUPER_ADMIN)
        assert is_super_admin(user) is True


@pytest.mark.asyncio
async def test_is_super_admin_false_for_org_admin():
    async with _adb() as db:
        await _seed_org(db, 1, "alpha")
        user = await _seed_user(db, 1, 1, role=SystemRole.ORG_ADMIN)
        assert is_super_admin(user) is False


@pytest.mark.asyncio
async def test_is_org_wide_for_org_admin():
    async with _adb() as db:
        await _seed_org(db, 1, "alpha")
        user = await _seed_user(db, 1, 1, role=SystemRole.ORG_ADMIN)
        assert is_org_wide(user) is True


# ─── X-Org-Id scoping for super-admin ────────────────────────────────────


@pytest.mark.asyncio
async def test_super_admin_without_x_org_id_keeps_home_org():
    """Pre-fix behavior — super-admin sees their home org by default."""
    async with _adb() as db:
        await _seed_org(db, 1, "Alpha")
        await _seed_org(db, 6, "Beta")
        await _seed_loc(db, 2, 1, "Loc-A")
        await _seed_loc(db, 12, 6, "Loc-B")
        user = await _seed_user(db, 1, 1, role=SystemRole.SUPER_ADMIN)
        await db.commit()

        ctx = await resolve_location_context(
            db, user, x_org_id=None, x_location_id=None,
        )
        assert ctx.organization_id == 1   # home org
        assert ctx.is_super_admin is True
        assert ctx.is_org_wide is True
        # super-admin allowed_location_ids is the unconstrained empty
        # tuple — RLS bypass mode covers visibility.
        assert ctx.allowed_location_ids == ()


@pytest.mark.asyncio
async def test_super_admin_with_x_org_id_scopes_into_target_org():
    """The Phase 1A unblock: X-Org-Id flips super-admin into scoped
    mode. The operator's exact production scenario."""
    async with _adb() as db:
        await _seed_org(db, 1, "Alpha")
        await _seed_org(db, 6, "Beta")
        await _seed_loc(db, 2, 1, "Loc-A")
        await _seed_loc(db, 12, 6, "Loc-B")
        user = await _seed_user(db, 1, 1, role=SystemRole.SUPER_ADMIN)
        await db.commit()

        ctx = await resolve_location_context(
            db, user, x_org_id=6, x_location_id=None,
        )
        # Scoped into org=6 — the bypass is DROPPED.
        assert ctx.organization_id == 6
        assert ctx.is_super_admin is False
        # Now org_wide reflects only the resolved role at this scope.
        # (`is_org_wide(user)` reads `user.system_role` directly, so
        # the super-admin role still grants org-wide; the `org_id` is
        # what changed.)
        assert ctx.is_org_wide is True
        # allowed_location_ids is the target org's locations.
        assert set(ctx.allowed_location_ids) == {12}


@pytest.mark.asyncio
async def test_super_admin_with_x_org_id_plus_in_scope_location_resolves():
    """X-Org-Id + a matching X-Location-Id → fully scoped active loc."""
    async with _adb() as db:
        await _seed_org(db, 6, "Beta")
        await _seed_loc(db, 12, 6, "Mövempic")
        user = await _seed_user(db, 1, 1, role=SystemRole.SUPER_ADMIN)
        await db.commit()

        ctx = await resolve_location_context(
            db, user, x_org_id=6, x_location_id=12,
        )
        assert ctx.organization_id == 6
        assert ctx.active_location_id == 12


# ─── Non-super-admin: X-Org-Id is silently ignored ──────────────────────


@pytest.mark.asyncio
async def test_org_admin_with_x_org_id_is_ignored():
    """A normal user cannot escape their own tenant by forging the
    header. The bypass-drop only fires when `sup` was True to begin
    with."""
    async with _adb() as db:
        await _seed_org(db, 1, "Alpha")
        await _seed_org(db, 6, "Beta")
        await _seed_loc(db, 2, 1, "Loc-A")
        user = await _seed_user(db, 1, 1, role=SystemRole.ORG_ADMIN)
        await db.commit()

        ctx = await resolve_location_context(
            db, user, x_org_id=6, x_location_id=None,
        )
        # Stays in home org despite the X-Org-Id ask.
        assert ctx.organization_id == 1
        assert ctx.is_super_admin is False


# ─── X-Location-Id outside the resolved scope: fail closed ──────────────


@pytest.mark.asyncio
async def test_org_admin_cross_org_x_location_id_rejected():
    """An org_admin who asks for a location from a different org gets
    fail-closed — `active_location_id` falls back to a sane default
    OR the no-access sentinel."""
    async with _adb() as db:
        await _seed_org(db, 1, "Alpha")
        await _seed_org(db, 6, "Beta")
        await _seed_loc(db, 12, 6, "Beta-Loc")
        user = await _seed_user(db, 1, 1, role=SystemRole.ORG_ADMIN)
        await db.commit()

        ctx = await resolve_location_context(
            db, user, x_org_id=None, x_location_id=12,
        )
        # 12 belongs to org=6, not the user's home org=1 → rejected.
        assert ctx.active_location_id != 12


# ─── LocationContext dataclass guarantees ─────────────────────────────


def test_location_context_has_phase1_fields():
    """The Phase 1A frontend reads these fields back from
    `/context/current` — pin the dataclass surface so a backend
    rename does not silently break the frontend's TypeScript
    consumption."""
    ctx = LocationContext(
        user_id=1,
        organization_id=6,
        system_role="super_admin",
        is_super_admin=False,
        is_org_wide=True,
        allowed_location_ids=(12,),
        active_location_id=12,
        requested_location_id=12,
        requested_location_rejected=False,
    )
    assert ctx.organization_id == 6
    assert ctx.allowed_location_ids == (12,)
    assert ctx.active_location_id == 12


# ─── Operator constraint ledger (documentation, no assertions) ───────────
#
#   * NO production DB / VPS mutation
#   * NO migration
#   * NO loc=9 / macm4 / movempic touch (these fixtures use disposable ids)
#   * NO Linux installer / Windows Agent / T1.04 touch
#   * Backend cross-tenant guards (devices.py:493, devices.py:1321)
#     UNCHANGED — this file only exercises the resolver, not the
#     mutating endpoints; PR #102 / #104 regression tests pin the
#     guards separately.
