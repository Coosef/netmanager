"""WIN-INTEGRATE test package — scope-local DB URL override.

The root `backend/tests/conftest.py` defaults DATABASE_URL to SQLite,
which is what every other unit test wants. SQLAlchemy 2.0.36 then
refuses the `pool_size` + `max_overflow` kwargs that
`app.core.database` passes to `create_async_engine` at module-import
time (SQLite + NullPool combination is incompatible with those
kwargs).

We don't open a real database connection in these tests — we only
need `app.api.v1.endpoints.agents` to import cleanly. Switching the
URL to the production-shape `postgresql+asyncpg` dialect drops the
SQLite/NullPool path, the kwargs validate, no connection is opened.

Local notes:
  - This requires `asyncpg` and `psycopg2-binary` to be import-able
    (they're in backend/requirements.txt). Run pytest inside the
    backend venv.
  - CI installs requirements.txt before pytest, so both drivers are
    present there.
"""
import os

os.environ["DATABASE_URL"] = "postgresql+asyncpg://x:y@localhost/db"
os.environ["SYNC_DATABASE_URL"] = "postgresql+psycopg2://x:y@localhost/db"
