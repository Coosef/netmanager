"""
Organization / location request-scoped context — Faz 7.

A pair of ContextVars carrying the active organization_id / location_id
for the current request or worker task. Set at the entry points (the
FastAPI auth dependency, Celery tasks, the event consumer, agent
handlers); read by the SQLAlchemy before_insert hook in
app/models/_scoping.py, which stamps organization_id / location_id onto
every scoped row that does not already have one.

This guarantees that EVERY insert into a scoped table is org-stamped —
without having to hand-edit every insert site — which is the
precondition for the M3 NOT NULL constraints (and later RLS).

ContextVars are coroutine/thread-local, so concurrent requests and
Celery tasks never see each other's context.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Optional

_current_org_id: ContextVar[Optional[int]] = ContextVar(
    "current_org_id", default=None,
)
_current_location_id: ContextVar[Optional[int]] = ContextVar(
    "current_location_id", default=None,
)


def set_org_context(
    organization_id: Optional[int],
    location_id: Optional[int] = None,
) -> None:
    """Set the active org / location for the current context."""
    _current_org_id.set(organization_id)
    _current_location_id.set(location_id)


def get_current_org_id() -> Optional[int]:
    return _current_org_id.get()


def get_current_location_id() -> Optional[int]:
    return _current_location_id.get()


def clear_org_context() -> None:
    _current_org_id.set(None)
    _current_location_id.set(None)


@contextmanager
def org_context(organization_id: Optional[int], location_id: Optional[int] = None):
    """
    Scoped context manager — used by Celery tasks / batch ingest code that
    processes one org at a time:

        with org_context(device.organization_id, device.location_id):
            ...  # every insert here is stamped with that org/location

    Restores the previous context on exit (so nested use is safe).
    """
    org_token = _current_org_id.set(organization_id)
    loc_token = _current_location_id.set(location_id)
    try:
        yield
    finally:
        _current_org_id.reset(org_token)
        _current_location_id.reset(loc_token)
