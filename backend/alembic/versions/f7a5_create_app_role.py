"""faz7 M5b — dedicated non-superuser application DB role

Row-Level Security is bypassed unconditionally for PostgreSQL
superusers and for any role with BYPASSRLS — FORCE ROW LEVEL SECURITY
does not change that. The platform role (POSTGRES_USER, e.g. netmgr) is
a superuser, so as long as the application connects with it, the M5
policies have no effect.

This migration creates a dedicated login role — netmgr_app — that is
NOSUPERUSER + NOBYPASSRLS, and grants it CRUD on the application tables.
The application services connect with THIS role (docker-compose
DATABASE_URL / SYNC_DATABASE_URL), so RLS actually applies to them.
Alembic keeps using the superuser role for DDL.

The role password comes from the APP_DB_PASSWORD environment variable
(the same value docker-compose puts in the app DATABASE_URL); a dev
default is used if unset. Rotate in production.

Revision ID: f7a5approle
Revises: f7a4rls
Create Date: 2026-05-18
"""
import os

from alembic import op

revision = "f7a5approle"
down_revision = "f7a4rls"
branch_labels = None
depends_on = None

_APP_ROLE = "netmgr_app"


def _password() -> str:
    pw = os.environ.get("APP_DB_PASSWORD", "netmgr_app_dev_pw")
    return pw.replace("'", "''")  # escape for the SQL literal


def upgrade() -> None:
    pw = _password()
    # Idempotent role creation — NOSUPERUSER + NOBYPASSRLS is what makes
    # RLS bite. Refresh the password on every run so it tracks the env.
    op.execute(
        f"DO $$ BEGIN "
        f"  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{_APP_ROLE}') THEN "
        f"    CREATE ROLE {_APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS "
        f"      NOCREATEDB NOCREATEROLE PASSWORD '{pw}'; "
        f"  ELSE "
        f"    ALTER ROLE {_APP_ROLE} WITH LOGIN NOSUPERUSER NOBYPASSRLS "
        f"      NOCREATEDB NOCREATEROLE PASSWORD '{pw}'; "
        f"  END IF; "
        f"END $$;"
    )
    # CRUD on every current + future application table / sequence.
    op.execute(f"GRANT USAGE ON SCHEMA public TO {_APP_ROLE}")
    op.execute(
        f"GRANT SELECT, INSERT, UPDATE, DELETE "
        f"ON ALL TABLES IN SCHEMA public TO {_APP_ROLE}"
    )
    op.execute(
        f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {_APP_ROLE}"
    )
    op.execute(
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public "
        f"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {_APP_ROLE}"
    )
    op.execute(
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public "
        f"GRANT USAGE, SELECT ON SEQUENCES TO {_APP_ROLE}"
    )
    # TimescaleDB routes hypertable writes to chunks in this schema.
    op.execute(
        f"GRANT USAGE ON SCHEMA _timescaledb_internal TO {_APP_ROLE}"
    )
    op.execute(
        f"GRANT SELECT, INSERT, UPDATE, DELETE "
        f"ON ALL TABLES IN SCHEMA _timescaledb_internal TO {_APP_ROLE}"
    )
    op.execute(
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA _timescaledb_internal "
        f"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {_APP_ROLE}"
    )


def downgrade() -> None:
    op.execute(
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public "
        f"REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM {_APP_ROLE}"
    )
    op.execute(
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public "
        f"REVOKE USAGE, SELECT ON SEQUENCES FROM {_APP_ROLE}"
    )
    op.execute(
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA _timescaledb_internal "
        f"REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM {_APP_ROLE}"
    )
    # Drop privileges then the role. REASSIGN/DROP OWNED not needed — the
    # role owns nothing (it only has granted privileges).
    op.execute(f"REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {_APP_ROLE}")
    op.execute(f"REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM {_APP_ROLE}")
    op.execute(f"REVOKE ALL ON SCHEMA public FROM {_APP_ROLE}")
    op.execute(
        f"REVOKE ALL ON ALL TABLES IN SCHEMA _timescaledb_internal "
        f"FROM {_APP_ROLE}"
    )
    op.execute(f"REVOKE ALL ON SCHEMA _timescaledb_internal FROM {_APP_ROLE}")
    op.execute(f"DROP ROLE IF EXISTS {_APP_ROLE}")
