"""
Organization management — Faz 8 Phase H.

The organization is the hidden tenant / account / licence boundary. This
module finalises that model with:

  * lifecycle enforcement — ``org_status_block`` decides whether a
    request may proceed: a *suspended* org is read-only, an *archived*
    org is fully retired;
  * per-organization quota — ``get_org_usage`` measures usage and
    ``enforce_org_can_create`` refuses new resources past a limit;
  * a super-admin override that is explicit and structured-logged.

Every usage figure is measured with an explicit ``organization_id``
filter under a super-admin context, so a count is org-scoped and never
leaks another tenant's data.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException

log = logging.getLogger("netmanager.org_management")

_READ_METHODS = {"GET", "HEAD", "OPTIONS"}

# resource name -> (model attr on app.models, organization quota attr)
_RESOURCES = {
    "locations": ("Location", "max_locations"),
    "devices": ("Device", "max_devices"),
    "agents": ("Agent", "max_agents"),
    "users": ("User", "max_users"),
}


def org_status_block(org, method: str) -> Optional[str]:
    """Return a rejection reason if `org`'s lifecycle status forbids this
    request, else None.

      * archived  → every request is refused;
      * suspended → only write/operational requests are refused, reads
        still pass so existing data stays visible.

    Pure — the caller (the auth dependency) raises. A super-admin is
    never passed here; platform super-admins bypass the gate entirely.
    """
    if org is None:
        return None
    status = getattr(org, "status", "active")
    if status == "archived":
        return "Organization is archived — access is disabled."
    if status == "suspended" and method.upper() not in _READ_METHODS:
        return "Organization is suspended — operations are read-only."
    return None


def _resolve(model_name: str):
    import app.models as _m
    return getattr(_m, model_name)


async def _count(db, model, org_id: int) -> int:
    """Live count of `model` rows owned by `org_id` — non-deleted /
    active where the model supports it. Measured under a super-admin
    context with an explicit org filter (org-scoped, no leakage)."""
    from sqlalchemy import func, select

    from app.core.org_context import superadmin_context
    from app.core.rls import apply_rls_context

    conds = [model.organization_id == org_id]
    if hasattr(model, "deleted_at"):
        conds.append(model.deleted_at.is_(None))
    elif hasattr(model, "is_active"):
        conds.append(model.is_active.is_(True))

    with superadmin_context():
        await apply_rls_context(db)
        return (await db.execute(
            select(func.count()).select_from(model).where(*conds)
        )).scalar() or 0


async def _events_24h(db, org_id: int) -> int:
    from sqlalchemy import func, select

    from app.core.org_context import superadmin_context
    from app.core.rls import apply_rls_context
    from app.models.network_event import NetworkEvent

    since = datetime.now(timezone.utc) - timedelta(hours=24)
    try:
        with superadmin_context():
            await apply_rls_context(db)
            return (await db.execute(
                select(func.count()).select_from(NetworkEvent).where(
                    NetworkEvent.organization_id == org_id,
                    NetworkEvent.created_at >= since,
                )
            )).scalar() or 0
    except Exception:
        return 0


async def get_org_usage(db, org) -> dict:
    """Per-organization usage vs. quota. org-scoped — every count is
    filtered to `org.id`."""
    resources: dict = {}
    over_quota = False
    for name, (model_name, limit_attr) in _RESOURCES.items():
        used = await _count(db, _resolve(model_name), org.id)
        limit = int(getattr(org, limit_attr, 0) or 0)
        # A limit of 0 means "none allowed" — it is not treated as
        # unlimited. over_limit is true once usage reaches the limit.
        at_or_over = used >= limit
        over_quota = over_quota or at_or_over
        resources[name] = {
            "used": used,
            "limit": limit,
            "percent": round(used / limit * 100, 1) if limit > 0 else 0.0,
            "over_limit": at_or_over,
        }
    return {
        "organization_id": org.id,
        "status": getattr(org, "status", "active"),
        "resources": resources,
        "events_24h": await _events_24h(db, org.id),
        "max_retention_days": getattr(org, "max_retention_days", None),
        "license_expires_at": (
            org.license_expires_at.isoformat()
            if getattr(org, "license_expires_at", None) else None
        ),
        "over_quota": over_quota,
    }


async def enforce_org_can_create(
    db, org, resource: str, *, actor_user_id: Optional[int],
    is_super_admin: bool = False,
) -> None:
    """Gate creation of a new `resource` (locations / devices / agents /
    users) for `org`.

    Refuses (HTTP 403) when the organization is not active or its quota
    for that resource is already reached. A platform super-admin is
    allowed to proceed despite a violation — that override is explicit
    and structured-logged, never silent.
    """
    if org is None:
        raise HTTPException(status_code=400, detail="No organization context.")
    spec = _RESOURCES.get(resource)
    if spec is None:
        return  # unknown resource — nothing to enforce

    status = getattr(org, "status", "active")
    model_name, limit_attr = spec
    used = await _count(db, _resolve(model_name), org.id)
    limit = int(getattr(org, limit_attr, 0) or 0)
    status_bad = status != "active"
    # A limit of 0 means "none allowed" — not unlimited.
    quota_bad = used >= limit

    if not status_bad and not quota_bad:
        return

    if is_super_admin:
        log.warning(
            "super-admin override — %s created despite %s",
            resource, "org status" if status_bad else "quota",
            extra={
                "event": "org_quota_override",
                "organization_id": org.id,
                "actor_user_id": actor_user_id,
                "resource": resource,
                "org_status": status,
                "used": used,
                "limit": limit,
            },
        )
        return

    reason = (
        f"Organization is {status} — cannot create {resource}."
        if status_bad
        else f"{resource} quota reached for this organization ({used}/{limit})."
    )
    log.warning(
        "org create rejected — %s",
        "status" if status_bad else "quota",
        extra={
            "event": "org_quota_rejected",
            "organization_id": org.id,
            "actor_user_id": actor_user_id,
            "resource": resource,
            "org_status": status,
            "used": used,
            "limit": limit,
        },
    )
    raise HTTPException(status_code=403, detail=reason)
