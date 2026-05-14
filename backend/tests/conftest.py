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
