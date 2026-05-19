"""
Validated task scope — Faz 8 Phase E.

A Celery task created from a user action should run under the *same*
organization + location the API endpoint validated — not an unbounded
super-admin context, and never anything the frontend merely asserted.

Mechanism:
  * the endpoint enqueues with ``enqueue_scoped(task, ..., organization_id,
    location_id)`` — the validated scope rides along in the task headers;
  * ``task_prerun`` (app/workers/signals.py) calls ``apply_task_scope`` —
    a task that carries a scope runs under it (RLS-enforced), a task that
    does not (beat jobs, fleet-wide sweeps) keeps the system-owned
    super-admin context;
  * ``task_scope_valid`` lets a long-delayed / replayed job check that
    its location still exists before acting — a revoked location stops
    the job rather than letting it write stale-scope rows.

Rollout is incremental: call sites move to ``enqueue_scoped`` as they are
touched; until then a task keeps today's behaviour. This module is the
single definition of the scope envelope so the two ends never drift.
"""
from __future__ import annotations

import logging
from typing import Optional

log = logging.getLogger("netmanager.task_scope")

# Celery message-header key carrying the validated scope envelope.
SCOPE_HEADER = "nm_task_scope"


def build_task_scope(
    organization_id: Optional[int], location_id: Optional[int] = None
) -> dict:
    """The scope envelope attached to a user-action task."""
    return {"organization_id": organization_id, "location_id": location_id}


def enqueue_scoped(
    task,
    *args,
    organization_id: Optional[int],
    location_id: Optional[int] = None,
    **kwargs,
):
    """Enqueue `task` carrying a validated (organization_id, location_id)
    scope. The worker runs it under exactly that scope (apply_task_scope).

    `organization_id` must be the value the API endpoint already
    validated for the acting user — never a client-supplied assumption.
    """
    headers = dict(kwargs.pop("headers", {}) or {})
    headers[SCOPE_HEADER] = build_task_scope(organization_id, location_id)
    return task.apply_async(args=args, kwargs=kwargs, headers=headers)


def scope_from_request(request) -> Optional[dict]:
    """Extract the scope envelope from a running task's request, or None
    for a system-owned task (beat jobs / fleet sweeps carry no scope)."""
    if request is None:
        return None
    # Custom apply_async headers surface on the task request; check the
    # documented places without depending on a single Celery internal.
    for getter in (
        lambda: getattr(request, SCOPE_HEADER, None),
        lambda: (getattr(request, "headers", None) or {}).get(SCOPE_HEADER),
        lambda: (getattr(request, "_message", None) or {}),
    ):
        try:
            val = getter()
        except Exception:
            continue
        if isinstance(val, dict) and "organization_id" in val:
            return val
    return None


def apply_task_scope(scope: Optional[dict]) -> bool:
    """Set the worker's org/location context for one task run.

    Returns True when a validated scope was applied (RLS-enforced run),
    False when the task is system-owned and runs super-admin. A scope
    with no organization_id is treated as system-owned — fail safe.
    """
    from app.core.org_context import set_org_context

    org_id = (scope or {}).get("organization_id")
    if org_id is None:
        # System-owned: beat jobs, fleet-wide sweeps. Explicit, not a
        # fallback — these legitimately span every organization.
        set_org_context(None, None, is_super_admin=True)
        return False
    set_org_context(org_id, (scope or {}).get("location_id"), is_super_admin=False)
    return True


async def task_scope_valid(db, scope: Optional[dict]) -> bool:
    """Whether a delayed/replayed task's scope is still valid — its
    location must still exist and not be soft-deleted. A system-owned
    task (no scope) is always valid.

    A task whose scope has gone stale (location deleted / archived) must
    not run; the caller drops it instead of writing rows under a scope
    the user/location relationship no longer supports.
    """
    if not scope or scope.get("organization_id") is None:
        return True  # system-owned
    location_id = scope.get("location_id")
    if location_id is None:
        return True  # org-wide scope — no location to revalidate
    from sqlalchemy import select

    from app.core.org_context import superadmin_context
    from app.core.rls import apply_rls_context
    from app.models.location import Location

    with superadmin_context():
        await apply_rls_context(db)
        loc = (await db.execute(
            select(Location.id).where(
                Location.id == location_id,
                Location.organization_id == scope["organization_id"],
                Location.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
    if loc is None:
        log.warning(
            "task scope no longer valid — location revoked/deleted",
            extra={
                "event": "task_scope_revoked",
                "organization_id": scope.get("organization_id"),
                "location_id": location_id,
            },
        )
        return False
    return True
