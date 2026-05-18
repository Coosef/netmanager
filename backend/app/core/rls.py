"""
Row-Level Security enforcement layer — Faz 7.

PostgreSQL RLS policies (migration M5) scope every query on a tenant
table to the caller's organization / location. The policies read three
per-transaction session variables (GUCs):

    app.current_org_id        the active organization (NULL ⇒ no access)
    app.current_location_id   the active location  (NULL/'' ⇒ all locations)
    app.is_super_admin        'on' ⇒ bypass scoping (platform admin / jobs)

This module wires those GUCs automatically: a SQLAlchemy ``after_begin``
hook fires at the start of EVERY transaction and pushes the current
app.core.org_context values into the connection with set_config(...,
is_local := true) — so the values are transaction-scoped and a pooled
connection can never leak one request's context into the next.

The hook is a no-op on non-PostgreSQL backends (SQLite unit tests have
no RLS), and never raises — a failure to set context fails CLOSED (the
policies then see NULL ⇒ zero rows) rather than leaking data.
"""
from __future__ import annotations

import logging

from sqlalchemy import event, text
from sqlalchemy.orm import Session

from app.core.org_context import (
    get_current_location_id,
    get_current_org_id,
    get_is_super_admin,
)

log = logging.getLogger("netmanager.rls")

_SET_CONTEXT_SQL = text(
    "SELECT set_config('app.current_org_id', :org, true), "
    "       set_config('app.current_location_id', :loc, true), "
    "       set_config('app.is_super_admin', :sa, true)"
)

_installed = False


def _apply_rls_context(session, transaction, connection) -> None:
    """after_begin hook — push org_context into the transaction's GUCs."""
    if connection.dialect.name != "postgresql":
        return  # RLS is PostgreSQL-only; SQLite tests skip silently.
    org = get_current_org_id()
    loc = get_current_location_id()
    is_super = get_is_super_admin()
    try:
        connection.execute(_SET_CONTEXT_SQL, {
            "org": str(org) if org is not None else None,
            "loc": str(loc) if loc is not None else None,
            "sa": "on" if is_super else "off",
        })
    except Exception:
        # Fail closed: leave the GUCs unset → policies match zero rows.
        log.exception("rls: failed to apply session context")


def install_rls_hooks() -> None:
    """Register the after_begin hook on the global Session class. Idempotent.
    Called at import time (see the bottom of app/core/database.py)."""
    global _installed
    if _installed:
        return
    event.listen(Session, "after_begin", _apply_rls_context)
    _installed = True
    log.info("rls: session context hook installed")


# ── Diagnostics / dry-run verification helpers ────────────────────────────────

async def current_rls_context(db) -> dict:
    """Return the GUC values currently visible to `db`'s transaction —
    used to confirm the context propagated correctly."""
    row = (await db.execute(text(
        "SELECT current_setting('app.current_org_id', true), "
        "       current_setting('app.current_location_id', true), "
        "       current_setting('app.is_super_admin', true)"
    ))).first()
    return {
        "organization_id": row[0] if row else None,
        "location_id": row[1] if row else None,
        "is_super_admin": row[2] if row else None,
    }


async def rls_table_status(db) -> list[dict]:
    """Per-table RLS status (relrowsecurity / relforcerowsecurity) + policy
    count — for verifying M5 applied as intended."""
    rows = (await db.execute(text(
        "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, "
        "       (SELECT count(*) FROM pg_policies p "
        "        WHERE p.tablename = c.relname) AS policies "
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = 'public' AND c.relkind = 'r' "
        "  AND c.relrowsecurity "
        "ORDER BY c.relname"
    ))).all()
    return [
        {"table": r[0], "rls_enabled": r[1], "rls_forced": r[2],
         "policies": r[3]}
        for r in rows
    ]


async def visible_row_count(db, table: str) -> int:
    """Rows of `table` visible to `db`'s current RLS context. Dry-run
    verification: count under an org context, then under a super-admin
    context (or a different org) — the numbers must differ once M5 is on."""
    return (await db.execute(
        text(f"SELECT count(*) FROM {table}")  # noqa: S608 — caller-fixed name
    )).scalar() or 0
