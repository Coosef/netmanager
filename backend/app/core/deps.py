from typing import Annotated, Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.database import get_db
from app.core.security import decode_access_token
from app.models.user import User, UserRole

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


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
    """Returns tenant_id for row-level filtering. SUPER_ADMIN gets None (no filter)."""
    if current_user.role == UserRole.SUPER_ADMIN:
        return None
    return current_user.tenant_id


async def get_accessible_location_ids(
    current_user: Annotated[User, Depends(get_current_active_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> Optional[list[int]]:
    """
    Returns None for unrestricted access (super_admin, admin).
    Returns list[int] of allowed location IDs for scoped roles.
    org_viewer gets all tenant locations; location_* roles get only assigned ones.
    """
    from app.models.location import Location
    from app.models.user_location import UserLocation

    if current_user.role in (UserRole.SUPER_ADMIN, UserRole.ADMIN):
        return None

    if current_user.role == UserRole.ORG_VIEWER:
        rows = (await db.execute(
            select(Location.id).where(Location.tenant_id == current_user.tenant_id)
        )).fetchall()
        return [r[0] for r in rows]

    # location_* and legacy operator/viewer: only explicitly assigned locations
    rows = (await db.execute(
        select(UserLocation.location_id).where(UserLocation.user_id == current_user.id)
    )).fetchall()
    return [r[0] for r in rows]


CurrentUser = Annotated[User, Depends(get_current_active_user)]
TenantFilter = Annotated[Optional[int], Depends(get_tenant_context)]
LocationFilter = Annotated[Optional[list[int]], Depends(get_accessible_location_ids)]
