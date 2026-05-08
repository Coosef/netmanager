"""
TenantProvisioner — creates the PostgreSQL schema + role for a new organization.

On new org creation:
  1. INSERT into organizations (get id)
  2. Create schema org_{id}
  3. Create PG role org_role_{id} with a random password
  4. Grant schema usage + table privileges to the role
  5. Update organizations.schema_name, pg_role_name, pg_pass_enc
"""
import copy
import secrets
import string

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import encrypt_credential
from app.models.shared.organization import Organization
from app.models.shared.permission_set import PermissionSet, DEFAULT_PERMISSIONS


def _random_password(length: int = 32) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


class TenantProvisioner:
    async def provision(self, db: AsyncSession, org: Organization) -> None:
        """
        Called after the Organization row is flushed (org.id is available).
        Creates the PostgreSQL schema and role, then grants privileges.
        """
        schema = f"org_{org.id}"
        role = f"org_role_{org.id}"
        password = _random_password()

        # Create schema
        await db.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{schema}"'))

        # Create PG role
        await db.execute(text(
            f"DO $$ BEGIN "
            f"  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{role}') "
            f"  THEN CREATE ROLE \"{role}\" LOGIN PASSWORD '{password}'; "
            f"  END IF; "
            f"END $$"
        ))

        # Grant schema + future tables
        await db.execute(text(f'GRANT USAGE ON SCHEMA "{schema}" TO "{role}"'))
        await db.execute(text(
            f'ALTER DEFAULT PRIVILEGES IN SCHEMA "{schema}" '
            f'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "{role}"'
        ))

        # Update org record
        org.schema_name = schema
        org.pg_role_name = role
        org.pg_pass_enc = encrypt_credential(password)
        db.add(org)

    async def create_default_permission_sets(
        self, db: AsyncSession, org: Organization
    ) -> None:
        """Create starter permission sets for the org (read-only, operator, full)."""
        presets = [
            {
                "name": "Sadece Görüntüle",
                "description": "Tüm modüllerde yalnızca okuma yetkisi",
                "is_default": True,
                "permissions": _viewer_permissions(),
            },
            {
                "name": "Operatör",
                "description": "Cihazlara bağlanabilir, komut çalıştırabilir, yedek alabilir",
                "is_default": False,
                "permissions": _operator_permissions(),
            },
            {
                "name": "Tam Yetki",
                "description": "Tüm modüllerde tam yetki (kullanıcı yönetimi hariç)",
                "is_default": False,
                "permissions": _full_permissions(),
            },
        ]
        for preset in presets:
            ps = PermissionSet(
                org_id=org.id,
                **preset,
            )
            db.add(ps)


def _viewer_permissions() -> dict:
    p = copy.deepcopy(DEFAULT_PERMISSIONS)
    for mod, actions in p["modules"].items():
        for action in list(actions.keys()):
            p["modules"][mod][action] = (action == "view")
    return p


def _operator_permissions() -> dict:
    p = copy.deepcopy(DEFAULT_PERMISSIONS)
    grants = {
        "devices":        {"view": True, "ssh": True},
        "config_backups": {"view": True, "edit": True},
        "tasks":          {"view": True, "create": True},
        "playbooks":      {"view": True, "run": True},
        "topology":       {"view": True},
        "monitoring":     {"view": True},
        "ipam":           {"view": True},
        "audit_logs":     {"view": True},
        "reports":        {"view": True},
    }
    for mod, actions in grants.items():
        for action, val in actions.items():
            p["modules"][mod][action] = val
    return p


def _full_permissions() -> dict:
    p = copy.deepcopy(DEFAULT_PERMISSIONS)
    skip_full = {"users"}
    for mod, actions in p["modules"].items():
        for action in list(actions.keys()):
            if mod not in skip_full:
                p["modules"][mod][action] = True
    return p


tenant_provisioner = TenantProvisioner()
