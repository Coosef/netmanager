"""
Automatic organization_id / location_id stamping — Faz 7.

Registers a single SQLAlchemy ``before_insert`` hook on the declarative
Base (propagating to every model). When a row is inserted into a scoped
table and its organization_id / location_id are still unset, they are
filled from the request/task context (app.core.org_context).

This is what makes the M3 NOT NULL constraints safe: every insert site —
API endpoints, background tasks, ingest paths — is covered centrally, so
none can be missed. Code that already sets organization_id explicitly
(e.g. batch ingest spanning multiple devices) is left untouched: the hook
only fills values that are None.

Imported for its side effect by app/models/__init__.py.
"""
from __future__ import annotations

from sqlalchemy import event, text
from sqlalchemy.orm import Mapper

from app.core.org_context import get_current_org_id, get_current_location_id

_SENTINEL = "n/a"


def _stamp_scoping(_mapper, connection, target) -> None:
    """
    before_insert: fill organization_id / location_id on a scoped row.

    Resolution order:
      1. A device-bound row (has a non-null device_id) inherits both from
         its parent device — the authoritative source.
      2. Anything still unset falls back to the request/task context
         (app.core.org_context).

    Values the caller already set are never overwritten — batch ingest
    code that stamps rows explicitly is unaffected.
    """
    needs_org = getattr(target, "organization_id", _SENTINEL) is None
    needs_loc = getattr(target, "location_id", _SENTINEL) is None
    if not needs_org and not needs_loc:
        return

    # 1. Device-bound row → inherit from the parent device. Best-effort:
    #    a failed lookup (e.g. a partial test schema) must never break the
    #    insert — fall through to the context.
    device_id = getattr(target, "device_id", None)
    if device_id is not None:
        try:
            row = connection.execute(
                text(
                    "SELECT organization_id, location_id "
                    "FROM devices WHERE id = :d"
                ),
                {"d": device_id},
            ).first()
        except Exception:
            row = None
        if row is not None:
            if needs_org and row[0] is not None:
                target.organization_id = row[0]
                needs_org = False
            if needs_loc and row[1] is not None:
                target.location_id = row[1]
                needs_loc = False

    # 2. Fall back to the request/task context.
    if needs_org:
        org_id = get_current_org_id()
        if org_id is not None:
            target.organization_id = org_id
    if needs_loc:
        loc_id = get_current_location_id()
        if loc_id is not None:
            target.location_id = loc_id


# Registering on Mapper fires the hook for every mapped class in the app.
event.listen(Mapper, "before_insert", _stamp_scoping)
