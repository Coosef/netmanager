"""
Tenant context API — Faz 7 Phase 5.

Tells the frontend who the caller is scoped to and which organizations /
locations they may switch between. The location list drives the top-bar
location switcher; switching is done client-side by changing the
X-Location-Id request header (validated + RLS-enforced server-side).
"""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, ScopedDb, SuperAdminOnly
from app.models.location import Location
from app.models.shared.organization import Organization
from app.models.user import SystemRole

router = APIRouter()


def _is_super(user) -> bool:
    return user.system_role == SystemRole.SUPER_ADMIN


@router.get("/current")
async def get_current_context(current_user: CurrentUser, db: ScopedDb):
    """The caller's active org, their accessible (non-deleted) locations,
    and system role — fetched once by the frontend on load / after a
    location switch. The Location query is RLS-scoped to the caller's org."""
    org = None
    if current_user.organization_id:
        org = await db.get(Organization, current_user.organization_id)

    locs = (await db.execute(
        select(Location)
        .where(Location.deleted_at.is_(None))
        .order_by(Location.name)
    )).scalars().all()

    return {
        "user_id": current_user.id,
        "username": current_user.username,
        "system_role": current_user.system_role,
        "is_super_admin": _is_super(current_user),
        "organization": (
            {"id": org.id, "name": org.name, "slug": org.slug} if org else None
        ),
        "locations": [
            {"id": loc.id, "name": loc.name} for loc in locs
        ],
    }


@router.get("/locations")
async def list_accessible_locations(current_user: CurrentUser, db: ScopedDb):
    """Locations the caller may switch to (RLS-scoped to their org)."""
    locs = (await db.execute(
        select(Location)
        .where(Location.deleted_at.is_(None))
        .order_by(Location.name)
    )).scalars().all()
    return [
        {"id": loc.id, "name": loc.name, "city": loc.city, "country": loc.country}
        for loc in locs
    ]


@router.get("/organizations")
async def list_organizations(
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    """All organizations — super-admin only (for the org switcher).
    `organizations` is not an RLS table; an unscoped session is used."""
    orgs = (await db.execute(
        select(Organization)
        .where(Organization.deleted_at.is_(None))
        .order_by(Organization.name)
    )).scalars().all()
    return [
        {"id": o.id, "name": o.name, "slug": o.slug, "is_active": o.is_active}
        for o in orgs
    ]
