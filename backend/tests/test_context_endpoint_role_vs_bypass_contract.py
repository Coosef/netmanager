"""ORG-CONTEXT-FALLBACK-FIX (2026-06-22) — contract pin: the
`/api/v1/context/current` response carries BOTH `system_role` (ROLE
identity, stable across scope flips) AND `is_super_admin` (BYPASS
state — flips to false when a super-admin scopes into a tenant via
`X-Org-Id`).

The frontend `SiteContext` reads BOTH and derives:
  - `isPlatformSuperAdmin` from `system_role === 'super_admin'`
    (used by the org switcher widget AND the cleanup gate)
  - `isSuperAdmin` from `is_super_admin`
    (preserved for the rare consumer that needs the bypass flag)

The production PR #106 regression — operator was looped back to
Platform Mode every time they picked Mövempic — came from the
frontend reading `is_super_admin` as the role identity. A backend
rename or accidental drop of either field would re-introduce the
bug. This file pins the contract directly on the resolver's output
+ on the `/context/current` response shape.

Operator constraints honoured (file-level):
  - NO production DB / VPS / migration mutation
  - NO loc=9 / macm4 / movempic touch (fixtures are disposable ids)
  - NO Linux / Windows / T1.04 touch
  - Backend cross-tenant guards UNCHANGED — this file only verifies
    the resolver output shape; PR #102 / #104 regression tests pin
    the guards separately.
"""
from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.database import Base
import app.models  # noqa: F401 — registers every model + scoping hook
from app.core.org_context import clear_org_context
from app.core.request_context import (
    LocationContext,
    is_super_admin,
    resolve_location_context,
)
from app.models.user import SystemRole


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


# ─── Pre-fix invariants that MUST hold ─────────────────────────────────


@pytest.mark.asyncio
async def test_unscoped_super_admin_has_BOTH_role_and_bypass():
    """The pre-fix happy path. Without X-Org-Id, a super-admin is in
    bypass mode AND retains the role. Both flags are TRUE."""
    async with _adb() as db:
        await _seed_org(db, 1, "Alpha")
        user = await _seed_user(db, 1, 1, role=SystemRole.SUPER_ADMIN)
        await db.commit()

        ctx = await resolve_location_context(
            db, user, x_org_id=None, x_location_id=None,
        )
        # ROLE identity
        assert str(user.system_role) == "SystemRole.SUPER_ADMIN" \
            or str(user.system_role) == "super_admin"
        assert is_super_admin(user) is True
        # BYPASS state — currently active
        assert ctx.is_super_admin is True


@pytest.mark.asyncio
async def test_scoped_super_admin_keeps_role_but_drops_bypass():
    """The production scenario the fix targets. WITH X-Org-Id, the
    backend drops the RLS bypass (`sup = False`) but the user is
    still a super-admin by ROLE. The frontend MUST distinguish
    these two — see `SiteContext.isPlatformSuperAdmin`."""
    async with _adb() as db:
        await _seed_org(db, 1, "Alpha")
        await _seed_org(db, 6, "Beta")
        await _seed_loc(db, 12, 6, "Mövempic")
        user = await _seed_user(db, 1, 1, role=SystemRole.SUPER_ADMIN)
        await db.commit()

        ctx = await resolve_location_context(
            db, user, x_org_id=6, x_location_id=None,
        )
        # ROLE identity — STAYS super_admin (the role is a property of
        # the user, not of the request).
        assert is_super_admin(user) is True
        # BYPASS state — flips to false. This is the precise signal the
        # operator-confirmed regression read as "user is no longer a
        # super-admin", which it is NOT.
        assert ctx.is_super_admin is False
        # Scope flipped to the requested tenant.
        assert ctx.organization_id == 6


@pytest.mark.asyncio
async def test_org_admin_keeps_both_false_consistently():
    """A normal user has neither flag — the role-vs-bypass distinction
    is moot for them. Pinned to prevent a future fix from
    accidentally flipping one of the two for an org_admin."""
    async with _adb() as db:
        await _seed_org(db, 1, "Alpha")
        user = await _seed_user(db, 1, 1, role=SystemRole.ORG_ADMIN)
        await db.commit()

        ctx = await resolve_location_context(
            db, user, x_org_id=None, x_location_id=None,
        )
        assert is_super_admin(user) is False
        assert ctx.is_super_admin is False


@pytest.mark.asyncio
async def test_org_admin_forging_x_org_id_does_NOT_get_bypass_or_scope():
    """Defensive — even if an org_admin attaches X-Org-Id (by malice
    or by mistake), the bypass-drop only fires when `sup` was true
    going in. The role-identity contract MUST hold here too."""
    async with _adb() as db:
        await _seed_org(db, 1, "Alpha")
        await _seed_org(db, 6, "Beta")
        user = await _seed_user(db, 1, 1, role=SystemRole.ORG_ADMIN)
        await db.commit()

        ctx = await resolve_location_context(
            db, user, x_org_id=6, x_location_id=None,
        )
        assert is_super_admin(user) is False
        assert ctx.is_super_admin is False
        # Scope stays in the org_admin's home tenant.
        assert ctx.organization_id == 1


# ─── /context/current response shape pin ─────────────────────────────


def test_context_current_response_contract_has_both_fields():
    """The `/context/current` endpoint MUST emit `system_role`
    (ROLE) and `is_super_admin` (BYPASS) side by side. A rename or
    drop of either would break the frontend's role-vs-bypass split."""
    # We assert against the source rather than spinning up the full
    # FastAPI app — the response is constructed inline in the
    # endpoint, the relevant lines are simple dict literals, and a
    # source-level pin is more robust to test-harness drift than a
    # live HTTP request.
    from pathlib import Path
    src = Path("app/api/v1/endpoints/context.py").read_text(encoding="utf-8")
    # Both keys appear in the same return dict block.
    assert '"system_role": current_user.system_role,' in src
    assert '"is_super_admin": ctx.is_super_admin,' in src


def test_location_context_dataclass_has_both_fields():
    """The dataclass surface — the frontend's TypeScript types
    derive from this shape. A breaking change would surface here."""
    ctx = LocationContext(
        user_id=1,
        organization_id=6,
        system_role="super_admin",        # ROLE
        is_super_admin=False,              # BYPASS (scoped state)
        is_org_wide=True,
        allowed_location_ids=(12,),
        active_location_id=12,
        requested_location_id=12,
        requested_location_rejected=False,
    )
    assert ctx.system_role == "super_admin"
    assert ctx.is_super_admin is False
