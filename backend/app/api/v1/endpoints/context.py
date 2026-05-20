"""
Request context API — Faz 7 Phase 5, reworked in Faz 8 Phase E.

Tells the frontend who the caller is scoped to and which locations they
may switch between. Faz 8 Phase E: the location list is derived from
`user_locations` — the single source of truth — NOT from the caller's
organization. A normal user sees only their assigned locations; the
frontend location switcher is built from exactly this list.

Switching locations is done client-side by changing the X-Location-Id
request header; the backend validates that header against user_locations
on every request (app.core.request_context) and RLS enforces isolation.
"""
from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, RequestContext, ScopedDb, SuperAdminOnly
from app.core.org_context import superadmin_context
from app.core.request_context import _NO_ACCESS
from app.core.rls import apply_rls_context
from app.models.device import Device
from app.models.location import Location
from app.models.shared.organization import Organization

router = APIRouter()


async def _accessible_locations(ctx, db: AsyncSession) -> list[Location]:
    """The Location rows the caller may access. user_locations is the
    source of truth; a super-admin (unconstrained) sees every location in
    the RLS-visible scope."""
    q = select(Location).where(Location.deleted_at.is_(None))
    if not ctx.is_super_admin:
        # ctx.allowed_location_ids is already the user_locations ∩ org set
        # (org-wide for org-admins). An empty set → no rows.
        if not ctx.allowed_location_ids:
            return []
        q = q.where(Location.id.in_(ctx.allowed_location_ids))
    rows = (await db.execute(q.order_by(Location.name))).scalars().all()
    return list(rows)


async def _device_counts(db: AsyncSession, location_ids: list[int]) -> dict[int, int]:
    """Active device count per location. Counted under a super-admin
    context, filtered explicitly to the caller's own location ids — the
    request's single-location RLS GUC cannot span the user's full set."""
    if not location_ids:
        return {}
    with superadmin_context():
        await apply_rls_context(db)
        rows = (await db.execute(
            select(Device.location_id, func.count(Device.id))
            .where(
                Device.location_id.in_(location_ids),
                Device.is_active.is_(True),
                Device.deleted_at.is_(None),
            )
            .group_by(Device.location_id)
        )).all()
    return {loc_id: cnt for loc_id, cnt in rows}


def _active(ctx) -> int | None:
    """The resolved active location, normalised — the no-access sentinel
    is reported to the frontend as null."""
    loc = ctx.active_location_id
    return None if loc in (None, _NO_ACCESS) else loc


@router.get("/current")
async def get_current_context(current_user: CurrentUser, ctx: RequestContext, db: ScopedDb):
    """The caller's active org, the locations they may access (from
    user_locations), the resolved active location and system role —
    fetched by the frontend on load and after a location switch."""
    org = None
    if ctx.organization_id:
        org = await db.get(Organization, ctx.organization_id)

    locs = await _accessible_locations(ctx, db)
    counts = await _device_counts(db, [loc.id for loc in locs])

    return {
        "user_id": current_user.id,
        "username": current_user.username,
        "system_role": current_user.system_role,
        "is_super_admin": ctx.is_super_admin,
        "is_org_wide": ctx.is_org_wide,
        "organization": (
            {"id": org.id, "name": org.name, "slug": org.slug} if org else None
        ),
        "locations": [
            {
                "id": loc.id,
                "name": loc.name,
                "color": getattr(loc, "color", None),
                "city": getattr(loc, "city", None),
                "country": getattr(loc, "country", None),
                "device_count": counts.get(loc.id, 0),
            }
            for loc in locs
        ],
        "allowed_location_ids": list(ctx.allowed_location_ids),
        "active_location_id": _active(ctx),
        "has_location_access": ctx.has_location_access,
    }


@router.get("/locations")
async def list_accessible_locations(ctx: RequestContext, db: ScopedDb):
    """Locations the caller may switch to — derived from user_locations."""
    locs = await _accessible_locations(ctx, db)
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
