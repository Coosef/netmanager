"""
Tenant-critical audit trail — Faz 7 Phase 6a (RLS-safe raw write).

A single SQLAlchemy ``before_flush`` hook that watches Device / Location /
Agent rows and, whenever a tenancy-critical column changes —
organization_id, location_id, or deleted_at — appends an audit_logs row
recording the before/after values and the acting user.

Doing it centrally (vs. hand-instrumenting every update site) guarantees
no reassignment / move / archive can slip through unaudited, whatever
code path performed it.

Why raw INSERT instead of ORM ``session.add``
---------------------------------------------

Previous revisions of this hook accumulated ``AuditLog(...)`` instances
and called ``session.add(entry)`` for each. SQLAlchemy's unit-of-work
then emitted the row as ::

    INSERT INTO audit_logs (...)
    VALUES (...)
    RETURNING audit_logs.id

The ``RETURNING`` clause forces Postgres to re-read the freshly inserted
row through the table's RLS ``USING`` expression. The ``audit_logs``
policy is intentionally strict on the read side ::

    USING (current_setting('app.is_super_admin', true) = 'on'
           OR organization_id = NULLIF(
              current_setting('app.current_org_id', true), '')::int)
    WITH CHECK (true)

so any flush that fires this hook in a code path whose
``app.current_org_id`` GUC is unset or unequal to the row's
``organization_id`` is rejected with ``InsufficientPrivilegeError:
new row violates row-level security policy for table "audit_logs"``,
which then propagates as a 500 from the parent endpoint (delete_device,
move-device, archive-location, etc.).

``audit_service.log_action`` already documents and avoids the same trap
by emitting a raw ``text()`` INSERT with no RETURNING clause (M6
production-readiness migration ``f8a6_audit_logs_permissive_writes`` is
the WITH-CHECK side of that workaround). This hook now follows the same
pattern: it builds parameter dicts during ``before_flush`` and pushes
them through ``session.execute(_AUDIT_INSERT_SQL, row)`` with no
RETURNING. The audit row's serial id is never needed by callers, so
losing it costs nothing.

Imported for its side effect by ``app/core/database.py``.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import JSON, String, bindparam, event, inspect, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from app.core.org_context import get_current_user_id, get_current_username

log = logging.getLogger("netmanager.tenant_audit")

# table → resource_type label
_AUDITED = {"devices": "device", "locations": "location", "agents": "agent"}
_TRACKED = ("organization_id", "location_id", "deleted_at")


def _jsonable(v):
    """Coerce a tracked column value into a JSON-serializable form —
    deleted_at is a datetime; organization_id / location_id are ints."""
    if isinstance(v, datetime):
        return v.isoformat()
    return v


def _resolve_action(rt: str, changes: dict) -> str:
    """Pick the single most significant action for an audit row."""
    if "deleted_at" in changes:
        old, new = changes["deleted_at"]
        if old is None and new is not None:
            return f"{rt}_archived"
        if old is not None and new is None:
            return f"{rt}_restored"
    if "organization_id" in changes:
        return f"{rt}_org_reassigned"
    if "location_id" in changes:
        return "device_moved" if rt == "device" else f"{rt}_location_changed"
    return f"{rt}_tenant_changed"


# Bind JSON columns through SQLAlchemy's type system so the dialect picks
# JSONB on Postgres (the prod path) and JSON on SQLite (tests). The
# statement is module-level so it benefits from prepared-statement caching
# across the lifetime of the process.
_AUDIT_INSERT_SQL = text(
    "INSERT INTO audit_logs ("
    "  organization_id, user_id, username, action,"
    "  resource_type, resource_id, resource_name,"
    "  details, status, before_state, after_state, created_at"
    ") VALUES ("
    "  :organization_id, :user_id, :username, :action,"
    "  :resource_type, :resource_id, :resource_name,"
    "  :details, :status, :before_state, :after_state, :created_at"
    ")"
).bindparams(
    bindparam("resource_id", type_=String),
    bindparam("username", type_=String),
)


def _bound_sql_for(session: Session):
    """Pick the JSON column type the active dialect understands.

    audit_service.log_action picks this per call from ``db.bind`` —
    mirroring that here keeps the SQLite test path working alongside the
    JSONB-flavoured Postgres production path."""
    bind = session.get_bind()
    dialect = bind.dialect.name if bind is not None else "sqlite"
    json_type = JSONB if dialect == "postgresql" else JSON
    return _AUDIT_INSERT_SQL.bindparams(
        bindparam("details", type_=json_type),
        bindparam("before_state", type_=json_type),
        bindparam("after_state", type_=json_type),
    )


def _resolve_org_id(obj) -> Optional[int]:
    """Take the audited row's own organization_id. Devices, locations
    and agents all carry one, so this is always present at flush time —
    no need to fall back to GUCs.

    Explicit attribution per the operator's design note: the audit row
    MUST match the target row's tenant, not the request session's. That
    keeps the audit_logs USING clause satisfiable even when the request
    context drifted (the very class of bug this PR fixes)."""
    return getattr(obj, "organization_id", None)


def _build_audit_param_set(obj, rt: str, changes: dict, now: datetime) -> dict:
    """Pure helper — turn one dirty row into the parameter dict the raw
    INSERT statement consumes. No DB calls, easy to unit-test."""
    action = _resolve_action(rt, changes)
    name = (
        getattr(obj, "hostname", None)
        or getattr(obj, "name", None)
        or str(getattr(obj, "id", "?"))
    )
    return {
        "organization_id": _resolve_org_id(obj),
        "user_id": get_current_user_id(),
        "username": get_current_username() or "system",
        "action": action,
        "resource_type": rt,
        "resource_id": str(getattr(obj, "id", "") or ""),
        "resource_name": str(name),
        "status": "success",
        "details": {"tenant_audit": True, "changed": list(changes.keys())},
        "before_state": {k: _jsonable(v[0]) for k, v in changes.items()},
        "after_state": {k: _jsonable(v[1]) for k, v in changes.items()},
        "created_at": now,
    }


def _collect_pending(session: Session) -> list[dict]:
    """Pure helper — walk ``session.dirty`` and return the parameter
    dicts every audited row would produce. Separated from the execute
    step so the loop stays trivially unit-testable."""
    pending: list[dict] = []
    now = datetime.now(timezone.utc)
    for obj in session.dirty:
        rt = _AUDITED.get(getattr(obj, "__tablename__", None))
        if rt is None or not session.is_modified(obj, include_collections=False):
            continue
        state = inspect(obj)
        changes: dict = {}
        for col in _TRACKED:
            attr = state.attrs.get(col)
            if attr is None:
                continue
            hist = attr.history
            if hist.has_changes():
                old = hist.deleted[0] if hist.deleted else None
                new = hist.added[0] if hist.added else None
                if old != new:
                    changes[col] = (old, new)
        if not changes:
            continue
        pending.append(_build_audit_param_set(obj, rt, changes, now))
    return pending


def _tenant_audit_before_flush(session: Session, _flush_context, _instances) -> None:
    """Real before_flush listener — collect param dicts, emit each as a
    raw INSERT through the session's own connection.

    NOTE on contract preservation: if the raw INSERT raises (e.g. the
    audited row carries an organization_id whose FK already points at a
    no-longer-existent organization), the exception propagates and aborts
    the parent flush. That matches the legacy ``session.add(AuditLog)``
    contract — audit failure has always blocked the parent domain
    operation, by design, so tenant-critical changes can never quietly
    bypass audit. A future "best-effort audit" mode would be a separate
    PR with its own data-loss tradeoff discussion.

    NOTE on recursion: the only writes this hook performs are direct raw
    INSERTs against ``audit_logs``. audit_logs is not in the
    ``_AUDITED`` map, so even if a future contributor adds another
    listener, no second audit row can ever be generated from this one's
    INSERT — there's no recursive-flush path."""
    if not _AUDITED:
        return

    pending = _collect_pending(session)
    if not pending:
        return

    bound_sql = _bound_sql_for(session)
    # session.execute is the right entry point: it walks through
    # AsyncSession's sync_session bridge when the parent session is
    # async, and it does NOT re-trigger autoflush because we're already
    # inside a flush. The connection is the same one ORM persistence
    # will use for the upcoming UPDATE statements.
    for row in pending:
        session.execute(bound_sql, row)


def install_tenant_audit_hook() -> None:
    """Register the before_flush hook (idempotent — see database.py)."""
    if not event.contains(Session, "before_flush", _tenant_audit_before_flush):
        event.listen(Session, "before_flush", _tenant_audit_before_flush)
        log.info("tenant_audit: before_flush hook installed (raw-insert mode)")
