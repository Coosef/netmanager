"""
Automatic organization_id / location_id stamping — Faz 7, hardened in Faz 8.

A single SQLAlchemy ``before_insert`` hook (fires for every model). When a
row is inserted into a scoped table and its organization_id /
location_id are still unset, they are resolved from an explicit source.

Resolution order for each row:
  1. A device-bound row (non-null device_id) inherits organization_id
     AND location_id from its parent device.
  2. Otherwise organization_id is inherited from a known parent row
     (agent / synthetic probe / playbook / escalation rule /
     notification channel / user) via whichever FK column is present.
  3. Anything still unset falls back to the request/task context
     (app.core.org_context — ContextVars, or the RLS session GUCs).

Faz 8 — **fail closed**: if a NOT NULL scoping column cannot be resolved
by ANY of the three explicit sources, the insert is REJECTED with a
``ScopedContextError`` and a structured log line. There is NO silent
default-organization / "Unassigned"-location fallback any more — a row
can never be misattributed to the wrong tenant.

Values the caller set explicitly are never overwritten — endpoints and
batch ingest that stamp rows themselves are unaffected (and, per Faz 8,
the scoped endpoints now do exactly that).

Imported for its side effect by app/models/__init__.py.
"""
from __future__ import annotations

import logging

from sqlalchemy import event, text
from sqlalchemy.orm import Mapper

from app.core.org_context import get_current_org_id, get_current_location_id

log = logging.getLogger("netmanager.scoping")

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


class ScopedContextError(RuntimeError):
    """A scoped row was inserted without a resolvable organization /
    location. Faz 8: such writes fail closed rather than defaulting."""


def _lookup(connection, table: str, key, columns: str):
    """Best-effort SELECT of scoping columns from a parent row."""
    try:
        return connection.execute(
            text(f"SELECT {columns} FROM {table} WHERE id = :k"),  # noqa: S608 — fixed table
            {"k": key},
        ).first()
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


def _reject(target, column: str) -> None:
    """Fail closed — refuse a scoped insert with no resolvable context."""
    table = getattr(target, "__tablename__", type(target).__name__)
    log.error(
        "scoped-write rejected: %s.%s unresolved",
        table, column,
        extra={
            "operation": "insert",
            "model": table,
            "missing_context": column,
            "reason": "no device parent, no parent FK, no org/location context",
        },
    )
    raise ScopedContextError(
        f"Scoped write rejected: {table}.{column} could not be resolved from a "
        f"device parent, a parent FK, or the request/task context. "
        f"Resolve organization/location explicitly before inserting — there is "
        f"no default-organization fallback."
    )


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

    # 2. Inherit organization_id from another known parent row. An agent
    #    parent also carries a location, so an agent-bound row (e.g.
    #    discovery_results, syslog_events) inherits location_id too.
    if needs_org:
        for col, parent in _PARENT_ORG_FK:
            val = getattr(target, col, None)
            if val is None:
                continue
            is_agent = parent == "agents"
            row = _lookup(
                connection, parent, val,
                "organization_id, location_id" if is_agent else "organization_id",
            )
            if row is None or row[0] is None:
                continue
            target.organization_id = row[0]
            needs_org = False
            if is_agent and needs_loc and len(row) > 1 and row[1] is not None:
                target.location_id = row[1]
                needs_loc = False
            break

    # 3. Fall back to the request/task context. ContextVars do not always
    #    cross into SQLAlchemy's async flush greenlet, so when they read
    #    empty we consult the RLS session GUCs — reliably set on the
    #    connection (apply_rls_context for requests, after_begin for
    #    sync workers).
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

    # 4. Fail closed — Faz 8. A NOT NULL scoping column still unresolved
    #    is REJECTED. No silent default-org / Unassigned-location fallback;
    #    a row is never misattributed to another tenant. Nullable scoping
    #    columns (audit_logs / api_tokens / users) are left as-is.
    if needs_org and _column_not_null(target, "organization_id"):
        _reject(target, "organization_id")
    if needs_loc and _column_not_null(target, "location_id"):
        _reject(target, "location_id")


# Registering on Mapper fires the hook for every mapped class in the app.
event.listen(Mapper, "before_insert", _stamp_scoping)
