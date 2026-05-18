"""
Organization / location request-scoped context — Faz 7.

ContextVars carrying the active organization_id / location_id (and a
super-admin bypass flag) for the current request or worker task. Set at
the entry points (the FastAPI auth dependency, Celery tasks, the event
consumer, agent handlers); consumed by:

  * the SQLAlchemy before_insert hook (app/models/_scoping.py) — stamps
    organization_id / location_id onto new rows;
  * the RLS session hook (app/core/rls.py) — pushes the values into
    PostgreSQL session variables so Row-Level Security policies scope
    every query.

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
# When True, RLS is bypassed for the current context — used by platform
# super-admins and by fleet-wide background jobs that legitimately span
# every organization. NEVER set from untrusted input.
_is_super_admin: ContextVar[bool] = ContextVar(
    "is_super_admin", default=False,
)


def set_org_context(
    organization_id: Optional[int],
    location_id: Optional[int] = None,
    is_super_admin: bool = False,
) -> None:
    """Set the active org / location / bypass flag for the current context."""
    _current_org_id.set(organization_id)
    _current_location_id.set(location_id)
    _is_super_admin.set(is_super_admin)


def get_current_org_id() -> Optional[int]:
    return _current_org_id.get()


def get_current_location_id() -> Optional[int]:
    return _current_location_id.get()


def get_is_super_admin() -> bool:
    return _is_super_admin.get()


def clear_org_context() -> None:
    _current_org_id.set(None)
    _current_location_id.set(None)
    _is_super_admin.set(False)


@contextmanager
def org_context(
    organization_id: Optional[int],
    location_id: Optional[int] = None,
    is_super_admin: bool = False,
):
    """
    Scoped context manager — for Celery tasks / batch ingest that process
    one org at a time:

        with org_context(device.organization_id, device.location_id):
            ...  # every query + insert here is scoped to that org/location

    Restores the previous context on exit (nested use is safe).
    """
    org_token = _current_org_id.set(organization_id)
    loc_token = _current_location_id.set(location_id)
    sa_token = _is_super_admin.set(is_super_admin)
    try:
        yield
    finally:
        _current_org_id.reset(org_token)
        _current_location_id.reset(loc_token)
        _is_super_admin.reset(sa_token)


@contextmanager
def superadmin_context():
    """Run a block with RLS bypassed — for fleet-wide background jobs and
    platform-level maintenance that must span every organization."""
    with org_context(None, None, is_super_admin=True):
        yield
