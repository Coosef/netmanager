"""
Permission resolution engine.

Resolution order for a (user, location_id) pair:
  1. Location-specific row in user_location_perms (user_id=X, location_id=Y)
  2. Org-wide default row                         (user_id=X, location_id IS NULL)
  3. Role-based defaults (so users work without manual PermissionSet assignment)

Super admins and org admins bypass this and are always granted all permissions.
"""
import copy
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User, SystemRole
from app.models.shared.permission_set import PermissionSet, DEFAULT_PERMISSIONS
from app.models.shared.user_location_perm import UserLocationPerm

# Role-based fallback permissions — applied when no PermissionSet is assigned.
# Each entry only lists modules/actions that should be True; anything missing stays False.
_ROLE_GRANTS: dict[str, dict[str, list[str]]] = {
    "location_viewer": {
        "devices": ["view"], "topology": ["view"], "monitoring": ["view"],
    },
    "viewer": {
        "devices": ["view"], "topology": ["view"], "monitoring": ["view"],
    },
    "location_operator": {
        "devices": ["view", "ssh"], "topology": ["view"], "monitoring": ["view"],
        "tasks": ["view", "create"], "config_backups": ["view"],
    },
    "operator": {
        "devices": ["view", "edit", "ssh"], "topology": ["view"], "monitoring": ["view"],
        "tasks": ["view", "create"], "config_backups": ["view"],
        "driver_templates": ["view"],
    },
    "location_manager": {
        "devices": ["view", "edit", "ssh"], "topology": ["view"], "monitoring": ["view"],
        "tasks": ["view", "create", "cancel"], "config_backups": ["view", "edit"],
        "playbooks": ["view", "run"], "ipam": ["view"], "reports": ["view"],
        "agents": ["view"], "driver_templates": ["view"], "locations": ["view"],
    },
    "org_viewer": {
        "devices": ["view"], "topology": ["view"], "monitoring": ["view"],
        "config_backups": ["view"], "ipam": ["view", "edit"],
        "reports": ["view"], "audit_logs": ["view"],
    },
}


def _role_default_permissions(role: str) -> dict:
    """Build a full permissions dict from the role-grant table."""
    result = copy.deepcopy(DEFAULT_PERMISSIONS)
    grants = _ROLE_GRANTS.get(role, {})
    for module, actions in grants.items():
        if module in result["modules"]:
            for action in actions:
                if action in result["modules"][module]:
                    result["modules"][module][action] = True
    return result


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
        if perm_set is not None:
            return perm_set.permissions or copy.deepcopy(DEFAULT_PERMISSIONS)

        # No org-wide assignment — merge all location-specific assignments so the
        # sidebar can show the right menu items (OR-merge: grant if any location grants it).
        if location_id is None:
            merged = await self._merge_all_location_permissions(db, user.id)
            if merged is not None:
                return merged

        # Final fallback: role-based defaults so users work without manual assignment
        return _role_default_permissions(user.role)

    async def _merge_all_location_permissions(
        self,
        db: AsyncSession,
        user_id: int,
    ) -> Optional[dict]:
        """OR-merge permissions from every location-specific assignment."""
        rows = await db.execute(
            select(UserLocationPerm).where(UserLocationPerm.user_id == user_id)
        )
        ulps = rows.scalars().all()
        if not ulps:
            return None

        merged = copy.deepcopy(DEFAULT_PERMISSIONS)
        found_any = False
        for ulp in ulps:
            ps = await db.get(PermissionSet, ulp.permission_set_id)
            if ps and ps.permissions:
                found_any = True
                for mod, actions in ps.permissions.get("modules", {}).items():
                    if mod not in merged["modules"]:
                        merged["modules"][mod] = {}
                    for action, val in actions.items():
                        if val:
                            merged["modules"][mod][action] = True

        return merged if found_any else None

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
