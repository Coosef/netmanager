"""
Permission resolution engine.

Resolution order for a (user, location_id) pair:
  1. Location-specific row in user_location_perms (user_id=X, location_id=Y)
  2. Org-wide default row                         (user_id=X, location_id IS NULL)
  3. Deny all (no matching row)

Super admins and org admins bypass this and are always granted all permissions.
"""
import copy
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User, SystemRole
from app.models.shared.permission_set import PermissionSet, DEFAULT_PERMISSIONS
from app.models.shared.user_location_perm import UserLocationPerm


class PermissionEngine:
    async def resolve(
        self,
        db: AsyncSession,
        user: User,
        module: str,
        action: str,
        location_id: Optional[int] = None,
    ) -> bool:
        """Return True if the user has module.action permission."""
        if user.system_role == SystemRole.SUPER_ADMIN:
            return True
        if user.system_role == SystemRole.ORG_ADMIN:
            return True

        perm_set = await self._find_permission_set(db, user.id, location_id)
        if perm_set is None:
            return False

        return self._check(perm_set.permissions, module, action)

    async def get_permissions(
        self,
        db: AsyncSession,
        user: User,
        location_id: Optional[int] = None,
    ) -> dict:
        """Return the full permissions dict for the user (or all-true for admins)."""
        if user.system_role in (SystemRole.SUPER_ADMIN, SystemRole.ORG_ADMIN):
            return self._all_true()

        perm_set = await self._find_permission_set(db, user.id, location_id)
        if perm_set is None:
            return copy.deepcopy(DEFAULT_PERMISSIONS)

        return perm_set.permissions or copy.deepcopy(DEFAULT_PERMISSIONS)

    async def _find_permission_set(
        self,
        db: AsyncSession,
        user_id: int,
        location_id: Optional[int],
    ) -> Optional[PermissionSet]:
        # Try location-specific first
        if location_id is not None:
            row = await db.execute(
                select(UserLocationPerm).where(
                    UserLocationPerm.user_id == user_id,
                    UserLocationPerm.location_id == location_id,
                )
            )
            ulp = row.scalar_one_or_none()
            if ulp:
                ps = await db.get(PermissionSet, ulp.permission_set_id)
                if ps:
                    return ps

        # Fall back to org-wide default
        row = await db.execute(
            select(UserLocationPerm).where(
                UserLocationPerm.user_id == user_id,
                UserLocationPerm.location_id.is_(None),
            )
        )
        ulp = row.scalar_one_or_none()
        if ulp:
            return await db.get(PermissionSet, ulp.permission_set_id)

        return None

    @staticmethod
    def _check(permissions: dict, module: str, action: str) -> bool:
        modules = permissions.get("modules", {})
        module_perms = modules.get(module, {})
        return bool(module_perms.get(action, False))

    @staticmethod
    def _all_true() -> dict:
        result = copy.deepcopy(DEFAULT_PERMISSIONS)
        for mod_perms in result.get("modules", {}).values():
            for key in mod_perms:
                mod_perms[key] = True
        return result


permission_engine = PermissionEngine()
