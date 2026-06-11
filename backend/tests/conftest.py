"""
Global test configuration — sets required environment variables before any
app module is imported, so pydantic Settings can instantiate without error.

The DATABASE_URL points to SQLite so no PostgreSQL driver is needed.
All engines created by app.core.database are never used in unit tests
(each test builds its own in-memory engine), but they must not fail at
import time.
"""
import os

# Generate a valid Fernet key if none is set (previous key decoded to 33 bytes — invalid)
if "CREDENTIAL_ENCRYPTION_KEY" not in os.environ:
    from cryptography.fernet import Fernet as _F
    os.environ["CREDENTIAL_ENCRYPTION_KEY"] = _F.generate_key().decode()

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///test_app.db")
os.environ.setdefault("SYNC_DATABASE_URL", "sqlite:///test_app.db")
os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-unit-tests")
os.environ.setdefault("CREDENTIAL_ENCRYPTION_KEY_OLD", "")
# Faz 5C: suppress log noise in tests, disable prometheus multiprocess dir
os.environ.setdefault("LOG_LEVEL", "WARNING")
os.environ.setdefault("LOG_FORMAT", "console")
os.environ.setdefault("PROMETHEUS_MULTIPROC_DIR", "")

import pytest


@pytest.fixture(autouse=True)
def _default_org_context():
    """
    Faz 7: scoped tables now have NOT NULL organization_id / location_id.
    Unit tests build ad-hoc rows without an org; give every test a default
    org/location context so the before_insert hook can stamp them. Tests
    that exercise org derivation explicitly (test_faz7_org_stamping.py)
    manage their own context and are unaffected — parent-derived and
    explicit values take precedence over this fallback.
    """
    from app.core.org_context import set_org_context, clear_org_context
    set_org_context(1, 1)
    yield
    clear_org_context()
