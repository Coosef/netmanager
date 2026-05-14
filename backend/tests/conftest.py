"""
Global test configuration — sets required environment variables before any
app module is imported, so pydantic Settings can instantiate without error.

The DATABASE_URL points to SQLite so no PostgreSQL driver is needed.
All engines created by app.core.database are never used in unit tests
(each test builds its own in-memory engine), but they must not fail at
import time.
"""
import os

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///test_app.db")
os.environ.setdefault("SYNC_DATABASE_URL", "sqlite:///test_app.db")
os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-unit-tests")
os.environ.setdefault(
    "CREDENTIAL_ENCRYPTION_KEY",
    "dGVzdC1jcmVkZW50aWFsLWtleS0zMi1ieXRlcy14eHh4"
)
# Faz 5C: suppress log noise in tests, disable prometheus multiprocess dir
os.environ.setdefault("LOG_LEVEL", "WARNING")
os.environ.setdefault("LOG_FORMAT", "console")
os.environ.setdefault("PROMETHEUS_MULTIPROC_DIR", "")
