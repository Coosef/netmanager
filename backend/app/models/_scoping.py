"""
Automatic organization_id / location_id stamping — Faz 7.

Registers a single SQLAlchemy ``before_insert`` hook on the declarative
Mapper (fires for every model). When a row is inserted into a scoped
table and its organization_id / location_id are still unset, they are
resolved — so the M3 NOT NULL constraints are safe and no insert site
can be missed.

Resolution order for each row:
  1. A device-bound row (non-null device_id) inherits organization_id
     AND location_id from its parent device.
  2. Otherwise organization_id is inherited from a known parent row
     (agent / synthetic probe / playbook / escalation rule /
     notification channel / user) via whichever FK column is present.
  3. Anything still unset falls back to the request/task context
     (app.core.org_context).

Values the caller set explicitly are never overwritten — batch ingest
code that stamps rows itself is unaffected. Parent lookups are
best-effort: a failure never breaks the insert.

Imported for its side effect by app/models/__init__.py.
"""
from __future__ import annotations

from sqlalchemy import event, text
from sqlalchemy.orm import Mapper

from app.core.org_context import get_current_org_id, get_current_location_id

_SENTINEL = "n/a"

# org-only parent FKs, tried in order — first that yields an org wins.
# (device_id is handled separately above — it also carries location.)
_PARENT_ORG_FK = (
    ("agent_id", "agents"),
    ("agent_to", "agents"),
    ("probe_id", "synthetic_probes"),
    ("playbook_id", "playbooks"),
    ("rule_id", "escalation_rules"),
    ("channel_id", "notification_channels"),
    ("user_id", "users"),
)


def _lookup(connection, table: str, key, columns: str):
    """Best-effort SELECT of scoping columns from a parent row."""
    try:
        return connection.execute(
            text(f"SELECT {columns} FROM {table} WHERE id = :k"),
            {"k": key},
        ).first()
    except Exception:
        return None


# Last-resort defaults, cached per process. Used only when a NOT NULL
# scoping column could not be resolved any other way — so a scoped insert
# can never fail on the constraint (worst case: the row lands on the
# default org / its "Unassigned" location).
_default_org_cache = None
_default_loc_cache = None


def _default_org(connection):
    global _default_org_cache
    if _default_org_cache is None:
        row = _lookup_first(
            connection, "SELECT id FROM organizations ORDER BY id LIMIT 1"
        )
        if row is not None:
            _default_org_cache = row[0]
    return _default_org_cache


def _default_location(connection):
    global _default_loc_cache
    if _default_loc_cache is None:
        row = _lookup_first(
            connection,
            "SELECT l.id FROM locations l JOIN organizations o "
            "  ON o.id = l.organization_id "
            "WHERE l.name = 'Unassigned — ' || o.slug "
            "ORDER BY o.id LIMIT 1",
        )
        if row is not None:
            _default_loc_cache = row[0]
    return _default_loc_cache


def _lookup_first(connection, sql: str):
    try:
        return connection.execute(text(sql)).first()
    except Exception:
        return None


def _guc_int(connection, name: str):
    """Read an RLS session GUC as an int — empty / unset yields None."""
    try:
        row = connection.execute(text(
            f"SELECT NULLIF(current_setting('{name}', true), '')::int"
        )).first()
        return row[0] if row is not None else None
    except Exception:
        return None


def _column_not_null(target, name: str) -> bool:
    try:
        col = target.__table__.columns.get(name)
        return col is not None and not col.nullable
    except Exception:
        return False


def _stamp_scoping(_mapper, connection, target) -> None:
    needs_org = getattr(target, "organization_id", _SENTINEL) is None
    needs_loc = getattr(target, "location_id", _SENTINEL) is None
    if not needs_org and not needs_loc:
        return

    # 1. Device-bound row → inherit organization_id + location_id.
    device_id = getattr(target, "device_id", None)
    if device_id is not None:
        row = _lookup(connection, "devices", device_id, "organization_id, location_id")
        if row is not None:
            if needs_org and row[0] is not None:
                target.organization_id = row[0]
                needs_org = False
            if needs_loc and row[1] is not None:
                target.location_id = row[1]
                needs_loc = False

    # 2. Inherit organization_id from another known parent row.
    if needs_org:
        for col, parent in _PARENT_ORG_FK:
            val = getattr(target, col, None)
            if val is None:
                continue
            row = _lookup(connection, parent, val, "organization_id")
            if row is not None and row[0] is not None:
                target.organization_id = row[0]
                needs_org = False
                break

    # 3. Fall back to the request/task context. ContextVars do not always
    #    cross into SQLAlchemy's async flush greenlet, so when they read
    #    empty we consult the RLS session GUCs — those are reliably set on
    #    the connection (apply_rls_context for requests, the after_begin
    #    hook for sync workers) and are the source of truth at flush time.
    if needs_org:
        org_id = get_current_org_id()
        if org_id is None:
            org_id = _guc_int(connection, "app.current_org_id")
        if org_id is not None:
            target.organization_id = org_id
            needs_org = False
    if needs_loc:
        loc_id = get_current_location_id()
        if loc_id is None:
            loc_id = _guc_int(connection, "app.current_location_id")
        if loc_id is not None:
            target.location_id = loc_id
            needs_loc = False

    # 4. Last-resort safety net — a NOT NULL scoping column that is still
    #    unresolved gets the default org / Unassigned location, so the
    #    insert can never fail on the constraint. Nullable columns
    #    (audit_logs / api_tokens / users) are left as-is.
    if needs_org and _column_not_null(target, "organization_id"):
        target.organization_id = _default_org(connection)
    if needs_loc and _column_not_null(target, "location_id"):
        target.location_id = _default_location(connection)


# Registering on Mapper fires the hook for every mapped class in the app.
event.listen(Mapper, "before_insert", _stamp_scoping)
