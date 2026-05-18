from typing import Annotated, Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.database import get_db
from app.core.org_context import set_org_context
from app.core.security import decode_access_token
from app.models.user import User, UserRole, SystemRole

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


# ---------------------------------------------------------------------------
# Core auth dependencies (unchanged)
# ---------------------------------------------------------------------------

def _is_super_admin(user: User) -> bool:
    return (
        user.system_role == SystemRole.SUPER_ADMIN
        or user.role == UserRole.SUPER_ADMIN
    )


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

    # Faz 7 — publish the full RLS context for this request. The
    # before_insert hook stamps new rows from it; the RLS session hook
    # (app/core/rls.py) scopes every query to it.
    is_super = _is_super_admin(user)
    org_id = user.organization_id
    # A super-admin may scope to one org via X-Org-Id (else they bypass RLS).
    x_org = request.headers.get("X-Org-Id")
    if is_super and x_org:
        try:
            org_id = int(x_org)
            is_super = False
        except (TypeError, ValueError):
            pass
    # Active location (X-Location-Id) — empty ⇒ all locations in the org.
    # A foreign location_id is harmless: RLS still requires the org to
    # match, so it simply yields no rows.
    location_id: Optional[int] = None
    x_loc = request.headers.get("X-Location-Id")
    if x_loc:
        try:
            location_id = int(x_loc)
        except (TypeError, ValueError):
            location_id = None

    set_org_context(org_id, location_id, is_super)
    # The auth query above already opened this session's transaction, so
    # the after_begin hook fired before the org was known — re-apply now.
    from app.core.rls import apply_rls_context
    await apply_rls_context(db)
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


# ---------------------------------------------------------------------------
# New RBAC dependencies
# ---------------------------------------------------------------------------

async def get_current_user_rbac(
    token: Annotated[str, Depends(oauth2_scheme)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    """Like get_current_user but loads org_id into context for new RBAC system."""
    return await get_current_user(token, db)


def require_permission(module: str, action: str):
    """
    Dependency factory that checks module.action permission via PermissionEngine.
    Usage: Depends(require_permission("devices", "edit"))
    """
    async def _checker(
        user: Annotated[User, Depends(get_current_active_user)],
        db: Annotated[AsyncSession, Depends(get_db)],
    ) -> User:
        from app.services.rbac.engine import permission_engine
        allowed = await permission_engine.resolve(db, user, module, action)
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
