"""
TenantProvisioner — creates the PostgreSQL schema + role for a new organization.

On new org creation:
  1. INSERT into organizations (get id)
  2. Create schema org_{id}
  3. Create PG role org_role_{id} with a random password
  4. Grant schema usage + table privileges to the role
  5. Update organizations.schema_name, pg_role_name, pg_pass_enc

Faz 7 RLS uses the shared `public` schema for isolation; the per-org
schema + role infrastructure here is pre-RLS legacy that nothing in the
runtime path currently reads. Org creation must NOT fail if the
runtime DB user lacks `CREATE SCHEMA / CREATE ROLE` privileges (the
secure-by-default app role won't have those — only the migration
superuser does). We log + skip in that case; the org row + permission
sets land normally, and the schema_name/pg_role_name columns stay NULL.
"""
import copy
import logging
import secrets
import string

from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import encrypt_credential
from app.models.shared.organization import Organization
from app.models.shared.permission_set import PermissionSet, DEFAULT_PERMISSIONS

log = logging.getLogger("netmanager.provisioner")


def _random_password(length: int = 32) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


class TenantProvisioner:
    async def provision(self, db: AsyncSession, org: Organization) -> None:
        """
        Called after the Organization row is flushed (org.id is available).
        Creates the PostgreSQL schema and role, then grants privileges.

        Soft-fails if the DB user lacks the privilege to CREATE SCHEMA /
        CREATE ROLE — the org_X schema is legacy infrastructure and the
        runtime relies on RLS row-isolation in `public` instead. Schema
        + role columns stay NULL in that branch.
        """
        schema = f"org_{org.id}"
        role = f"org_role_{org.id}"
        password = _random_password()

        # Wrap the DDL in a SAVEPOINT so a privilege failure only rolls back
        # the per-org schema/role attempt — the surrounding transaction
        # (the Organization row + DEFAULT permission sets inserted by the
        # caller right after) survives intact.
        try:
            async with db.begin_nested():
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

                # Update org record (only on success — SAVEPOINT commits with
                # the exit; on failure these fields stay NULL)
                org.schema_name = schema
                org.pg_role_name = role
                org.pg_pass_enc = encrypt_credential(password)
                db.add(org)

        except ProgrammingError as e:
            # InsufficientPrivilege — runtime app user can't CREATE
            # SCHEMA/ROLE (correct in a security-hardened deployment).
            # Faz 7 RLS in `public` supersedes this isolation layer.
            log.warning(
                "tenant_provisioner: skipping per-org schema/role provision "
                "(runtime DB user lacks CREATE privilege — Faz 7 RLS in "
                "public schema is the active isolation layer): %s",
                str(e.orig)[:200] if hasattr(e, "orig") else str(e)[:200],
            )

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
    # RBAC-SPRINT-2.2C-A — firmware.rollout_status is a READ verb whose
    # name is not literally "view" (it reads /firmware/jobs + logs, not
    # the artifact catalog). The viewer preset already grants
    # monitoring.view = True, and the f9am migration says a monitoring
    # viewer keeps firmware.view + firmware.rollout_status. Keep freshly
    # provisioned tenants aligned with post-migration tenants by
    # explicitly turning rollout_status on for viewer.
    p["modules"]["firmware"]["rollout_status"] = True
    return p


def _operator_permissions() -> dict:
    # P2-CATALOG-A — `devices.connect` rides alongside `devices.ssh`
    # (the operator preset has always opened the SSH session for
    # commands), and the freshly-canonical backup/restore verbs map to
    # the legacy `edit` grant. `devices.move` + `devices.create` stay
    # FALSE on the operator preset — destructive ownership-class verbs
    # that need explicit opt-in via the permission set editor.
    p = copy.deepcopy(DEFAULT_PERMISSIONS)
    grants = {
        "devices":        {"view": True, "ssh": True, "connect": True},
        "config_backups": {"view": True, "edit": True, "backup": True, "restore": True},
        "tasks":          {"view": True, "create": True},
        "playbooks":      {"view": True, "run": True},
        "topology":       {"view": True},
        "monitoring":     {"view": True},
        "ipam":           {"view": True},
        "audit_logs":     {"view": True},
        "reports":        {"view": True},
        # RBAC-SPRINT-2.2C-A — Operators already have monitoring.view;
        # keep them aligned with the f9am migration carry-over so a
        # freshly provisioned operator can also see the firmware
        # artifact catalog + install job rollout status. Mutating
        # firmware verbs (upload/assign/install/approve_reload) stay
        # FALSE on the operator preset — those are org_admin-only.
        "firmware":       {"view": True, "rollout_status": True},
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
