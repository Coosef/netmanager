from typing import AsyncGenerator, Optional

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from app.core.config import settings


# ---------------------------------------------------------------------------
# Declarative bases
# ---------------------------------------------------------------------------

class SharedBase(DeclarativeBase):
    """Base for tables in the public (shared) schema: plans, organizations, users, etc."""
    pass


class TenantBase(DeclarativeBase):
    """Base for tables that live in a per-org schema (org_{id})."""
    pass


# Keep legacy alias so existing model imports don't break during migration
Base = SharedBase


# ---------------------------------------------------------------------------
# Async engine / sessions — FastAPI
# ---------------------------------------------------------------------------

async_engine = create_async_engine(
    settings.DATABASE_URL,
    echo=settings.DEBUG,
    pool_size=settings.DB_POOL_SIZE,
    max_overflow=settings.DB_MAX_OVERFLOW,
    pool_pre_ping=True,
)

AsyncSessionLocal = async_sessionmaker(
    async_engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


# ---------------------------------------------------------------------------
# Sync engine / sessions — Celery workers
# ---------------------------------------------------------------------------

sync_engine = create_engine(
    settings.SYNC_DATABASE_URL,
    pool_size=settings.DB_POOL_SIZE,
    max_overflow=settings.DB_MAX_OVERFLOW,
    pool_pre_ping=True,
)

SyncSessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=sync_engine,
)


# ---------------------------------------------------------------------------
# FastAPI dependencies
# ---------------------------------------------------------------------------

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Shared-schema session (public). Used by all shared-model endpoints."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


# Convenience alias — use get_shared_db in new code, get_db for legacy compat
get_shared_db = get_db


async def get_tenant_db(schema_name: str) -> AsyncGenerator[AsyncSession, None]:
    """
    Yield an async session with search_path set to the given tenant schema.
    Caller must know the schema_name (e.g. 'org_7').
    """
    async with AsyncSessionLocal() as session:
        await session.execute(text(f"SET search_path = {schema_name}, public"))
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


def get_sync_db():
    db = SyncSessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Celery worker helpers
# ---------------------------------------------------------------------------

def make_worker_session(schema_name: Optional[str] = None):
    """
    Return a fresh async sessionmaker using NullPool — safe for Celery worker event loops.
    If schema_name is provided, SET search_path is called on each new session.
    """
    engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    if schema_name:
        # Wrap to inject search_path
        original_factory = factory

        class _SchemaFactory:
            def __call__(self):
                return _SchemaSession(original_factory, schema_name)

        return _SchemaFactory()
    return factory


class _SchemaSession:
    """Async context manager that sets search_path on enter."""
    def __init__(self, factory, schema_name: str):
        self._factory = factory
        self._schema = schema_name
        self._session: Optional[AsyncSession] = None

    async def __aenter__(self) -> AsyncSession:
        self._session = self._factory()
        await self._session.__aenter__()
        await self._session.execute(text(f"SET search_path = {self._schema}, public"))
        return self._session

    async def __aexit__(self, *args):
        await self._session.__aexit__(*args)
