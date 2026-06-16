"""Architecture-test package — scope-local DB URL override.

Mirrors `backend/tests/win_integrate/conftest.py`. The architecture
model itself does not touch the database, but importing
`app.services.windows_runtime.manifest` (for the manifest-extension
tests) walks the same app-import chain that the root conftest's SQLite
default trips on. Setting the URLs here keeps the test package
self-contained.
"""
import os

os.environ["DATABASE_URL"] = "postgresql+asyncpg://x:y@localhost/db"
os.environ["SYNC_DATABASE_URL"] = "postgresql+psycopg2://x:y@localhost/db"
