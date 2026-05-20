"""
Tenant-critical audit trail — Faz 7 Phase 6a.

A single SQLAlchemy ``before_flush`` hook that watches Device / Location /
Agent rows and, whenever a tenancy-critical column changes —
organization_id, location_id, or deleted_at — appends an audit_logs row
recording the before/after values and the acting user.

Doing it centrally (vs. hand-instrumenting every update site) guarantees
no reassignment / move / archive can slip through unaudited, whatever
code path performed it.

Imported for its side effect by app/core/database.py.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import event, inspect
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


def _tenant_audit_before_flush(session: Session, _flush_context, _instances) -> None:
    try:
        from app.models.audit_log import AuditLog
    except Exception:
        return

    pending: list = []
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

        action = _resolve_action(rt, changes)
        name = (
            getattr(obj, "hostname", None)
            or getattr(obj, "name", None)
            or str(getattr(obj, "id", "?"))
        )
        pending.append(AuditLog(
            user_id=get_current_user_id(),
            username=get_current_username() or "system",
            action=action,
            resource_type=rt,
            resource_id=str(getattr(obj, "id", "") or ""),
            resource_name=str(name),
            status="success",
            before_state={k: _jsonable(v[0]) for k, v in changes.items()},
            after_state={k: _jsonable(v[1]) for k, v in changes.items()},
            details={"tenant_audit": True, "changed": list(changes.keys())},
            created_at=datetime.now(timezone.utc),
        ))

    for entry in pending:
        session.add(entry)


def install_tenant_audit_hook() -> None:
    """Register the before_flush hook (idempotent — see database.py)."""
    if not event.contains(Session, "before_flush", _tenant_audit_before_flush):
        event.listen(Session, "before_flush", _tenant_audit_before_flush)
        log.info("tenant_audit: before_flush hook installed")
