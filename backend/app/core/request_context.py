"""
Request-scoped location context — Faz 8 Phase E.

``user_locations`` is the single source of truth for which locations a
user may access. This module resolves, for one request (or one realtime
connection), the user's:

  * organization_id
  * allowed_location_ids   — derived from user_locations; org-wide for
    org-admins, unconstrained for super-admins
  * active_location_id     — the X-Location-Id header, *validated*
    against allowed_location_ids — never trusted as given
  * system role / super-admin flag

Resolution fails closed. A location-scoped user who has no user_locations
row, or who asks for a location outside their set, is given the
``_NO_ACCESS`` sentinel — RLS then scopes every location-bound query to
nothing. There is NO organization-level fallback, NO default
organization, NO implicit membership and NO trust of the client-supplied
location beyond validation against user_locations.

Org-wide roles (super-admin, org-admin) are deliberately exempt from the
user_locations constraint — that is an *explicit* role property, audited
here, not an accidental fallback.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

log = logging.getLogger("netmanager.location_context")

# Active-location value handed to RLS for a location-scoped user who has
# no valid location access. No location row has id 0, so every
# location-bound RLS predicate yields zero rows — fail closed.
_NO_ACCESS = 0


class LocationAccessError(Exception):
    """A request named a location the user may not access, or a
    location-scoped request could not resolve any active location.
    Carries the HTTP status the API layer should return."""

    def __init__(self, detail: str, status_code: int = 403):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


@dataclass(frozen=True)
class LocationContext:
    """The resolved location scope of one request / connection."""

    user_id: int
    organization_id: Optional[int]
    system_role: str
    is_super_admin: bool
    # Org-wide users (super-admin, org-admin) are not constrained by
    # user_locations — they legitimately operate across the whole org.
    is_org_wide: bool
    # The user's accessible locations. Empty tuple for a super-admin means
    # "unconstrained"; empty for anyone else means "no access".
    allowed_location_ids: tuple[int, ...]
    # The validated active location. None = all locations in the org
    # (org-wide users only). _NO_ACCESS for a location-scoped user with
    # no valid location.
    active_location_id: Optional[int]
    # The raw X-Location-Id the client sent — kept for audit only.
    requested_location_id: Optional[int]
    # True when the client sent a location it is not allowed to use.
    requested_location_rejected: bool = False

    @property
    def has_location_access(self) -> bool:
        """False for a location-scoped user with no usable location."""
        if self.is_super_admin:
            return True
        if self.is_org_wide:
            return self.organization_id is not None
        return bool(self.allowed_location_ids)


# ── role helpers ─────────────────────────────────────────────────────────────

def is_super_admin(user) -> bool:
    # M6 final drop — UserRole + legacy `role` column gone.
    from app.models.user import SystemRole
    return user.system_role == SystemRole.SUPER_ADMIN


def is_org_wide(user) -> bool:
    """True for roles that operate across the whole organization and are
    therefore not constrained by individual user_locations rows —
    super-admin and org-admin. This is an explicit role property."""
    from app.models.user import SystemRole
    return user.system_role in (SystemRole.SUPER_ADMIN, SystemRole.ORG_ADMIN)


# ── resolution ───────────────────────────────────────────────────────────────

async def _org_location_ids(db, org_id: int) -> set[int]:
    """Every non-deleted location id in `org_id`. Read under a super-admin
    context so the bootstrap is not itself RLS-gated."""
    from sqlalchemy import select

    from app.core.org_context import superadmin_context
    from app.core.rls import apply_rls_context
    from app.models.location import Location

    with superadmin_context():
        await apply_rls_context(db)
        rows = (await db.execute(
            select(Location.id).where(
                Location.organization_id == org_id,
                Location.deleted_at.is_(None),
            )
        )).scalars().all()
    return set(rows)


async def _user_location_ids(db, user_id: int) -> set[int]:
    """The location ids assigned to `user_id` via user_locations — the
    source of truth. user_locations is not an RLS table."""
    from sqlalchemy import select

    from app.models.user_location import UserLocation

    rows = (await db.execute(
        select(UserLocation.location_id).where(UserLocation.user_id == user_id)
    )).scalars().all()
    return set(rows)


async def resolve_location_context(
    db,
    user,
    *,
    x_org_id: Optional[int] = None,
    x_location_id: Optional[int] = None,
    channel: str = "http",
) -> LocationContext:
    """Resolve the active location scope for `user`.

    Never raises — a rejected/stale location degrades to a fail-closed
    context (the request keeps working so the client can self-correct),
    and the rejection is audit-logged. Endpoints that must hard-reject a
    cross-location request call ``assert_location_allowed`` afterwards.
    """
    sup = is_super_admin(user)
    org_id = user.organization_id

    # A super-admin may scope into one organization via X-Org-Id. Doing so
    # drops the bypass — they then see exactly that org, like its admin.
    if sup and x_org_id is not None:
        org_id = x_org_id
        sup = False

    org_wide = sup or is_org_wide(user)

    # ── allowed locations — the user_locations source of truth ───────────
    if sup:
        allowed: tuple[int, ...] = ()                      # unconstrained
    elif org_id is None:
        allowed = ()                                       # no org → no access
    elif org_wide:
        allowed = tuple(sorted(await _org_location_ids(db, org_id)))
    else:
        org_locs = await _org_location_ids(db, org_id)
        user_locs = await _user_location_ids(db, user.id)
        # Intersect: a user_locations row pointing at a deleted or
        # cross-org location grants nothing.
        allowed = tuple(sorted(user_locs & org_locs))

    # ── active location — validate the client header, never trust it ────
    active: Optional[int] = None
    rejected = False

    if x_location_id is not None:
        if sup:
            active = x_location_id                         # explicit, audited
        elif x_location_id in allowed:
            active = x_location_id
        else:
            # The client asked for a location it may not use — stale
            # tab, revoked access, or tampering. Fail closed + audit.
            rejected = True
            log.warning(
                "location access denied",
                extra={
                    "event": "location_access_denied",
                    "channel": channel,
                    "user_id": user.id,
                    "organization_id": org_id,
                    "requested_location_id": x_location_id,
                    "allowed_location_ids": list(allowed),
                },
            )
            active = allowed[0] if (allowed and not org_wide) else None

    if active is None and not org_wide:
        # A location-scoped user must always resolve to a concrete
        # location — pick a deterministic default, or fail closed.
        if allowed:
            active = allowed[0]
        else:
            active = _NO_ACCESS
            log.warning(
                "no location access",
                extra={
                    "event": "location_resolution_failed",
                    "channel": channel,
                    "user_id": user.id,
                    "organization_id": org_id,
                    "reason": "user has no user_locations rows",
                },
            )

    return LocationContext(
        user_id=user.id,
        organization_id=org_id,
        system_role=str(user.system_role),
        is_super_admin=sup,
        is_org_wide=org_wide,
        allowed_location_ids=allowed,
        active_location_id=active,
        requested_location_id=x_location_id,
        requested_location_rejected=rejected,
    )


def assert_location_allowed(ctx: LocationContext, location_id: int) -> None:
    """Hard-reject an operation that explicitly targets `location_id` when
    the user may not access it. Raises ``LocationAccessError`` (HTTP 403).
    Super-admins and (within their org) org-admins pass."""
    if ctx.is_super_admin:
        return
    if ctx.is_org_wide and location_id is not None:
        # An org-admin may act on any location in their org.
        if location_id in ctx.allowed_location_ids:
            return
    if location_id in ctx.allowed_location_ids:
        return
    log.warning(
        "cross-location operation rejected",
        extra={
            "event": "cross_location_rejected",
            "user_id": ctx.user_id,
            "organization_id": ctx.organization_id,
            "target_location_id": location_id,
            "allowed_location_ids": list(ctx.allowed_location_ids),
        },
    )
    raise LocationAccessError(
        f"Location {location_id} is not in your accessible locations.",
        status_code=403,
    )


def require_active_location(ctx: LocationContext) -> int:
    """Return the active location for an endpoint that needs a concrete
    one. Raises ``LocationAccessError`` (HTTP 400/403) when a
    location-scoped user has none."""
    if ctx.is_org_wide and ctx.active_location_id is None:
        raise LocationAccessError(
            "This operation requires a specific active location — "
            "select one (X-Location-Id).",
            status_code=400,
        )
    if ctx.active_location_id in (None, _NO_ACCESS):
        raise LocationAccessError(
            "You have no accessible location. Contact an administrator.",
            status_code=403,
        )
    return ctx.active_location_id
