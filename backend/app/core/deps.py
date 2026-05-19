from typing import Annotated, Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.database import get_db
from app.core.org_context import set_org_context
from app.core.request_context import (
    LocationContext,
    is_super_admin as _is_super_admin,
    resolve_location_context,
)
from app.core.security import decode_access_token
from app.models.user import User, UserRole, SystemRole

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


# ---------------------------------------------------------------------------
# Core auth dependencies
# ---------------------------------------------------------------------------


def _parse_int_header(request: Request, name: str) -> Optional[int]:
    raw = request.headers.get(name)
    if not raw:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


async def get_current_user(
    request: Request,
    token: Annotated[str, Depends(oauth2_scheme)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    payload = decode_access_token(token)
    if payload is None:
        raise credentials_exception

    user_id: int = payload.get("sub")
    if user_id is None:
        raise credentials_exception

    result = await db.execute(select(User).where(User.id == int(user_id), User.is_active == True))
    user = result.scalar_one_or_none()
    if user is None:
        raise credentials_exception

    # Faz 8 Phase E — resolve the request's location scope from
    # user_locations (the source of truth). The X-Location-Id header is
    # validated against the user's accessible locations, never trusted as
    # given; a rejected/stale value fails closed. The resolved context is
    # stashed on request.state for the RequestContext dependency.
    ctx = await resolve_location_context(
        db, user,
        x_org_id=_parse_int_header(request, "X-Org-Id"),
        x_location_id=_parse_int_header(request, "X-Location-Id"),
        channel="http",
    )
    request.state.location_context = ctx

    # Publish the validated RLS context: the before_insert hook stamps new
    # rows from it; the rls.py session hook scopes every query to it.
    set_org_context(ctx.organization_id, ctx.active_location_id, ctx.is_super_admin)
    # Attribute org/location transitions to this user (tenant-audit hook).
    from app.core.org_context import set_current_user_id, set_current_username
    set_current_user_id(user.id)
    set_current_username(user.username)
    # The auth query above already opened this session's transaction, so
    # the after_begin hook fired before the org was known — re-apply now.
    from app.core.rls import apply_rls_context
    await apply_rls_context(db)

    # Faz 8 Phase H — organization lifecycle gate. A suspended org is
    # read-only; an archived org is fully closed. A platform super-admin
    # bypasses this entirely (they manage org lifecycle).
    if ctx.organization_id is not None and not _is_super_admin(user):
        from app.models.shared.organization import Organization
        from app.services.org_management import org_status_block
        org = await db.get(Organization, ctx.organization_id)
        blocked = org_status_block(org, request.method)
        if blocked:
            import logging
            logging.getLogger("netmanager.org_management").warning(
                "organization access blocked",
                extra={
                    "event": "org_access_blocked",
                    "organization_id": ctx.organization_id,
                    "user_id": user.id,
                    "method": request.method,
                    "org_status": getattr(org, "status", None),
                },
            )
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=blocked)
    return user


async def get_current_active_user(
    current_user: Annotated[User, Depends(get_current_user)],
) -> User:
    if not current_user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")
    return current_user


# ---------------------------------------------------------------------------
# Legacy role-based deps (kept for backward compat)
# ---------------------------------------------------------------------------

def require_roles(*roles: UserRole):
    async def _checker(user: Annotated[User, Depends(get_current_active_user)]) -> User:
        if user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions",
            )
        return user
    return _checker


async def get_tenant_context(
    current_user: Annotated[User, Depends(get_current_active_user)],
) -> Optional[int]:
    # Faz 7 — legacy tenant filtering is superseded by PostgreSQL RLS.
    # Returning None makes every `if tenant_filter is not None:` guard in
    # the endpoints skip its manual .where(Device.tenant_id == ...) — the
    # RLS policies (migration M5) now do the org scoping at the DB.
    return None


async def get_accessible_location_ids(
    current_user: Annotated[User, Depends(get_current_active_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> Optional[list[int]]:
    # Faz 7 — superseded by RLS (the active-location GUC scopes rows).
    return None


async def get_accessible_location_names(
    current_user: Annotated[User, Depends(get_current_active_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> Optional[list[str]]:
    # Faz 7 — superseded by RLS.
    return None


CurrentUser = Annotated[User, Depends(get_current_active_user)]
TenantFilter = Annotated[Optional[int], Depends(get_tenant_context)]
LocationFilter = Annotated[Optional[list[int]], Depends(get_accessible_location_ids)]
LocationNameFilter = Annotated[Optional[list[str]], Depends(get_accessible_location_names)]


# ── Faz 7 — RLS-scoped DB session ─────────────────────────────────────────────

async def get_scoped_db(
    db: Annotated[AsyncSession, Depends(get_db)],
    _user: Annotated[User, Depends(get_current_active_user)],
) -> AsyncSession:
    """
    A DB session with the RLS org/location context guaranteed in place —
    get_current_user publishes it and the rls.py session hook pushes it
    into PostgreSQL GUCs, so every query is policy-scoped. Endpoints can
    depend on this instead of get_db; existing endpoints that already take
    `CurrentUser` are scoped automatically (the context is set the moment
    the user is resolved).
    """
    return db


ScopedDb = Annotated[AsyncSession, Depends(get_scoped_db)]


# ── Faz 8 Phase E — request location context ──────────────────────────────────

async def get_request_context(
    request: Request,
    _user: Annotated[User, Depends(get_current_active_user)],
) -> LocationContext:
    """The validated location scope of this request — user_locations is
    the source of truth (see app.core.request_context). get_current_user
    resolves it and stashes it on request.state; this exposes it to
    endpoints and to the RBAC / location-enforcement dependencies."""
    ctx = getattr(request.state, "location_context", None)
    if ctx is None:  # defensive — get_current_active_user always runs first
        raise HTTPException(status_code=401, detail="Unresolved request context")
    return ctx


RequestContext = Annotated[LocationContext, Depends(get_request_context)]


def require_location_access():
    """Dependency — fail closed when a location-scoped user has no usable
    location (HTTP 403). Use on endpoints that read/write location-scoped
    data so an un-located user is rejected explicitly, not served an empty
    list that looks like 'no data'."""
    async def _checker(ctx: RequestContext) -> LocationContext:
        if not ctx.has_location_access:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You have no accessible location. Contact an administrator.",
            )
        return ctx
    return _checker


LocationScoped = Annotated[LocationContext, Depends(require_location_access())]


# ---------------------------------------------------------------------------
# New RBAC dependencies
# ---------------------------------------------------------------------------

async def get_current_user_rbac(
    request: Request,
    token: Annotated[str, Depends(oauth2_scheme)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    """Like get_current_user but loads org_id into context for new RBAC system."""
    return await get_current_user(request, token, db)


def require_permission(module: str, action: str):
    """
    Dependency factory that checks module.action permission via PermissionEngine.
    Usage: Depends(require_permission("devices", "edit"))

    Faz 8 Phase E — the check is evaluated against the request's *active
    location* (request_context), so a location-scoped grant cannot
    accidentally pass under another location. A location-scoped user with
    no usable location is rejected before the permission lookup.
    """
    async def _checker(
        ctx: RequestContext,
        user: Annotated[User, Depends(get_current_active_user)],
        db: Annotated[AsyncSession, Depends(get_db)],
    ) -> User:
        from app.services.rbac.engine import permission_engine
        if not ctx.has_location_access:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You have no accessible location. Contact an administrator.",
            )
        active_loc = ctx.active_location_id if not ctx.is_org_wide else None
        allowed = await permission_engine.resolve(
            db, user, module, action, location_id=active_loc,
        )
        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission denied: {module}.{action}",
            )
        return user
    return _checker


def require_system_role(*roles: SystemRole):
    """
    Require one of the given system roles — Faz 7 4-role model
    (super_admin / org_admin / location_admin / viewer).

    A 'member' value (the pre-Faz-7 default, before migration M4 ran) is
    treated as 'viewer'. The legacy `role` column is still consulted as a
    fallback so an un-migrated user is never wrongly locked out.
    """
    async def _checker(user: Annotated[User, Depends(get_current_active_user)]) -> User:
        sr = user.system_role
        if sr == SystemRole.MEMBER:          # pre-M4 value
            sr = SystemRole.VIEWER
        if sr in roles:
            return user
        # Legacy fallback — un-migrated user whose system_role is stale.
        if user.role == UserRole.SUPER_ADMIN and SystemRole.SUPER_ADMIN in roles:
            return user
        if user.role in (UserRole.SUPER_ADMIN, UserRole.ADMIN) and SystemRole.ORG_ADMIN in roles:
            return user
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient system role",
        )
    return _checker


RbacUser = Annotated[User, Depends(get_current_active_user)]
SuperAdminOnly = Annotated[User, Depends(require_system_role(SystemRole.SUPER_ADMIN))]
OrgAdminOrAbove = Annotated[
    User,
    Depends(require_system_role(SystemRole.SUPER_ADMIN, SystemRole.ORG_ADMIN)),
]
LocationAdminOrAbove = Annotated[
    User,
    Depends(require_system_role(
        SystemRole.SUPER_ADMIN, SystemRole.ORG_ADMIN, SystemRole.LOCATION_ADMIN,
    )),
]
