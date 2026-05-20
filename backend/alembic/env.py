from logging.config import fileConfig
import os
import sys

from sqlalchemy import engine_from_config, pool, text

from alembic import context

# Make app importable from /app (container) or backend/ (host)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.config import settings
from app.core.database import Base  # SharedBase alias

# Import ALL models so their tables register on Base.metadata
import app.models  # noqa: F401 — side-effect import populates metadata

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Target metadata for autogenerate
target_metadata = Base.metadata


def get_url() -> str:
    """
    Connection URL for Alembic (psycopg2 / synchronous).

    Faz 7: migrations need the SUPERUSER role — they run DDL, create
    roles, and must not be row-filtered by RLS. The application connects
    with a non-superuser role (netmgr_app) via SYNC_DATABASE_URL, so
    Alembic uses MIGRATION_DATABASE_URL when set (the superuser). Falls
    back to SYNC_DATABASE_URL / DATABASE_URL for dev convenience.
    """
    url = os.environ.get("MIGRATION_DATABASE_URL") or settings.SYNC_DATABASE_URL
    if not url:
        url = settings.DATABASE_URL.replace("+asyncpg", "+psycopg2")
    return url


def run_migrations_offline() -> None:
    """
    Offline mode: emit SQL to stdout without a live DB connection.
    Useful for generating migration scripts to review before applying.
    """
    url = get_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_schemas=False,
    )
    with context.begin_transaction():
        context.run_migrations()


def _include_object(obj, name, type_, reflected, compare_to):
    """Exclude TimescaleDB internal tables and hypertable chunks from autogenerate diff."""
    if type_ == "table":
        if name.startswith("_hyper_") or name.startswith("_timescaledb"):
            return False
    return True


def run_migrations_online() -> None:
    """
    Online mode: connect to the DB and apply migrations directly.
    """
    configuration = config.get_section(config.config_ini_section, {})
    configuration["sqlalchemy.url"] = get_url()

    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_object=_include_object,
            compare_server_default=True,
            compare_type=True,
        )

        with context.begin_transaction():
            context.run_migrations()
        # Faz 7 — RLS note: migration DDL is never row-filtered by a
        # policy. A future *data*-touching revision that runs after M5
        # must bypass RLS itself, e.g. at the top of its upgrade():
        #     op.execute("SET LOCAL app.is_super_admin = 'on'")


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
