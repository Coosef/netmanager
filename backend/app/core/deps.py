from typing import Annotated, Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.database import get_db
from app.core.security import decode_access_token
from app.models.user import User, UserRole, SystemRole

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


# ---------------------------------------------------------------------------
# Core auth dependencies (unchanged)
# ---------------------------------------------------------------------------

async def get_current_user(
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
    if current_user.role == UserRole.SUPER_ADMIN:
        return None
    if current_user.role == UserRole.ADMIN:
        return current_user.tenant_id
    return current_user.tenant_id if current_user.tenant_id is not None else -1


async def get_accessible_location_ids(
    current_user: Annotated[User, Depends(get_current_active_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> Optional[list[int]]:
    from app.models.location import Location
    from app.models.user_location import UserLocation

    if current_user.role in (UserRole.SUPER_ADMIN, UserRole.ADMIN):
        return None

    if current_user.role == UserRole.ORG_VIEWER:
        if not current_user.tenant_id:
            return []
        rows = (await db.execute(
            select(Location.id).where(Location.tenant_id == current_user.tenant_id)
        )).fetchall()
        return [r[0] for r in rows]

    rows = (await db.execute(
        select(UserLocation.location_id).where(UserLocation.user_id == current_user.id)
    )).fetchall()
    return [r[0] for r in rows]


async def get_accessible_location_names(
    current_user: Annotated[User, Depends(get_current_active_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> Optional[list[str]]:
    from app.models.location import Location
    from app.models.user_location import UserLocation

    if current_user.role in (UserRole.SUPER_ADMIN, UserRole.ADMIN):
        return None

    if current_user.role == UserRole.ORG_VIEWER:
        if not current_user.tenant_id:
            return []
        rows = (await db.execute(
            select(Location.name).where(Location.tenant_id == current_user.tenant_id)
        )).fetchall()
        return [r[0] for r in rows]

    rows = (await db.execute(
        select(Location.name)
        .join(UserLocation, Location.id == UserLocation.location_id)
        .where(UserLocation.user_id == current_user.id)
    )).fetchall()
    return [r[0] for r in rows]


CurrentUser = Annotated[User, Depends(get_current_active_user)]
TenantFilter = Annotated[Optional[int], Depends(get_tenant_context)]
LocationFilter = Annotated[Optional[list[int]], Depends(get_accessible_location_ids)]
LocationNameFilter = Annotated[Optional[list[str]], Depends(get_accessible_location_names)]


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
    """Require one of the given system-level roles (super_admin, org_admin, member).

    Falls back to legacy `role` field so existing users whose system_role
    defaulted to 'member' before the RBAC migration are not locked out.
    """
    async def _checker(user: Annotated[User, Depends(get_current_active_user)]) -> User:
        if user.system_role in roles:
            return user
        # Legacy fallback: map old `role` values to new system roles
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
