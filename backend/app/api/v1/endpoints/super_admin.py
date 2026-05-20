"""Super admin endpoints: plan management, org management, global permission sets, system stats."""
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Union

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select, update, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import SuperAdminOnly
from app.core.security import hash_password
from app.models.agent import Agent
from app.models.device import Device
from app.models.invite_token import InviteToken
from app.models.location import Location
from app.models.network_event import NetworkEvent
from app.models.shared.organization import Organization, OrgStatus
from app.models.shared.permission_set import PermissionSet, DEFAULT_PERMISSIONS
from app.models.shared.plan import Plan
from app.models.task import Task
# M6 final drop — Tenant model removed.
from app.models.user import User, SystemRole
from app.services.audit_service import log_action
from app.services.org_management import get_org_usage

router = APIRouter(prefix="/super-admin", tags=["super-admin"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class PlanCreate(BaseModel):
    name: str
    slug: str
    description: Optional[str] = None
    max_devices: int = 50
    max_users: int = 5
    max_locations: int = 3
    max_agents: int = 1
    features: dict = {}
    price_monthly: Optional[int] = None
    price_yearly: Optional[int] = None


class PlanUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    max_devices: Optional[int] = None
    max_users: Optional[int] = None
    max_locations: Optional[int] = None
    max_agents: Optional[int] = None
    features: Optional[dict] = None
    is_active: Optional[bool] = None
    price_monthly: Optional[int] = None
    price_yearly: Optional[int] = None


class OrgCreate(BaseModel):
    name: str
    slug: str
    description: Optional[str] = None
    contact_email: Optional[EmailStr] = None
    plan_id: Optional[int] = None
    trial_days: int = 14
    # First admin user
    admin_username: str
    admin_email: EmailStr
    admin_password: str
    admin_full_name: Optional[str] = None


class OrgUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    contact_email: Optional[str] = None
    plan_id: Optional[int] = None
    is_active: Optional[bool] = None
    subscription_ends_at: Optional[datetime] = None
    # Faz 8 Phase H — lifecycle status, licence window, per-org quota.
    status: Optional[str] = None
    license_started_at: Optional[datetime] = None
    license_expires_at: Optional[datetime] = None
    max_locations: Optional[int] = None
    max_devices: Optional[int] = None
    max_agents: Optional[int] = None
    max_users: Optional[int] = None
    max_retention_days: Optional[int] = None


class GlobalPermSetCreate(BaseModel):
    name: str
    description: Optional[str] = None
    permissions: dict = {}


class OrgInviteCreate(BaseModel):
    org_id: int
    email: EmailStr
    full_name: Optional[str] = None
    system_role: str = "member"
    permission_set_id: Optional[int] = None
    expires_hours: int = 72


# ---------------------------------------------------------------------------
# Plan endpoints
# ---------------------------------------------------------------------------

@router.get("/plans")
async def list_plans(
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    rows = (await db.execute(select(Plan).order_by(Plan.id))).scalars().all()
    return {"plans": [_plan_dict(p) for p in rows]}


@router.post("/plans", status_code=201)
async def create_plan(
    payload: PlanCreate,
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    existing = (await db.execute(select(Plan).where(Plan.slug == payload.slug))).scalar_one_or_none()
    if existing:
        raise HTTPException(400, "Bu slug zaten kullanılıyor")
    plan = Plan(**payload.model_dump())
    db.add(plan)
    await db.commit()
    await db.refresh(plan)
    return _plan_dict(plan)


@router.patch("/plans/{plan_id}")
async def update_plan(
    plan_id: int,
    payload: PlanUpdate,
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    plan = await db.get(Plan, plan_id)
    if not plan:
        raise HTTPException(404, "Plan bulunamadı")
    for field, val in payload.model_dump(exclude_unset=True).items():
        setattr(plan, field, val)
    await db.commit()
    await db.refresh(plan)
    return _plan_dict(plan)


@router.delete("/plans/{plan_id}", status_code=204)
async def delete_plan(
    plan_id: int,
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    plan = await db.get(Plan, plan_id)
    if not plan:
        raise HTTPException(404, "Plan bulunamadı")
    await db.delete(plan)
    await db.commit()


# ---------------------------------------------------------------------------
# Organization endpoints
# ---------------------------------------------------------------------------

@router.get("/orgs")
async def list_orgs(
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
    page: int = 1,
    per_page: int = 50,
    with_counts: bool = Query(False),
):
    """List organizations. With `?with_counts=true`, each row carries
    inline `device_count` / `user_count` / `location_count` + `plan_tier`
    so the super-admin dashboard (frontend `tenantsApi.list` shim) can
    render the org overview table in a single round trip.

    Counts are computed via grouped subqueries (no N+1)."""
    offset = (page - 1) * per_page
    total = (await db.execute(select(func.count()).select_from(Organization))).scalar()
    rows = (await db.execute(
        select(Organization).order_by(Organization.id).offset(offset).limit(per_page)
    )).scalars().all()

    counts_by_org: dict[int, dict] = {}
    plan_slug_by_org: dict[int, str] = {}
    if with_counts and rows:
        org_ids = [o.id for o in rows]

        # Per-table grouped counts (3 small queries, scales with org count not row count).
        dev_rows = (await db.execute(
            select(Device.organization_id, func.count(Device.id))
            .where(Device.organization_id.in_(org_ids), Device.is_active == True)
            .group_by(Device.organization_id)
        )).all()
        usr_rows = (await db.execute(
            select(User.organization_id, func.count(User.id))
            .where(User.organization_id.in_(org_ids))
            .group_by(User.organization_id)
        )).all()
        loc_rows = (await db.execute(
            select(Location.organization_id, func.count(Location.id))
            .where(Location.organization_id.in_(org_ids))
            .group_by(Location.organization_id)
        )).all()
        plan_rows = (await db.execute(
            select(Organization.id, Plan.slug)
            .outerjoin(Plan, Plan.id == Organization.plan_id)
            .where(Organization.id.in_(org_ids))
        )).all()

        for oid, n in dev_rows:
            counts_by_org.setdefault(oid, {})["device_count"] = n
        for oid, n in usr_rows:
            counts_by_org.setdefault(oid, {})["user_count"] = n
        for oid, n in loc_rows:
            counts_by_org.setdefault(oid, {})["location_count"] = n
        for oid, slug in plan_rows:
            plan_slug_by_org[oid] = slug or "free"

    def _row(o: Organization) -> dict:
        d = _org_dict(o)
        if with_counts:
            c = counts_by_org.get(o.id, {})
            d["device_count"] = c.get("device_count", 0)
            d["user_count"] = c.get("user_count", 0)
            d["location_count"] = c.get("location_count", 0)
            d["plan_tier"] = plan_slug_by_org.get(o.id, "free")
        return d

    return {"total": total, "orgs": [_row(o) for o in rows]}


@router.get("/orgs/{org_id}")
async def get_org(
    org_id: int,
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    org = await db.get(Organization, org_id)
    if not org:
        raise HTTPException(404, "Organizasyon bulunamadı")
    return _org_dict(org)


@router.post("/orgs", status_code=201)
async def create_org(
    payload: OrgCreate,
    current_user: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    if not re.match(r"^[a-z0-9-]+$", payload.slug):
        raise HTTPException(400, "Slug yalnızca küçük harf, rakam ve tire içerebilir")

    existing = (await db.execute(
        select(Organization).where(Organization.slug == payload.slug)
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(400, "Bu slug zaten kullanılıyor")

    # Create org
    trial_end = datetime.now(timezone.utc) + timedelta(days=payload.trial_days)
    org = Organization(
        name=payload.name,
        slug=payload.slug,
        description=payload.description,
        contact_email=payload.contact_email,
        plan_id=payload.plan_id,
        is_active=True,
        trial_ends_at=trial_end,
    )
    db.add(org)
    await db.flush()  # get org.id

    # Faz 8 Phase H — seed the per-organization quota from the chosen
    # plan (the licence tier); orgs with no plan keep the model defaults.
    org.license_started_at = datetime.now(timezone.utc)
    if payload.plan_id:
        plan = await db.get(Plan, payload.plan_id)
        if plan:
            org.max_locations = plan.max_locations
            org.max_devices = plan.max_devices
            org.max_agents = plan.max_agents
            org.max_users = plan.max_users

    # Provision schema + role
    from app.services.rbac.provisioner import tenant_provisioner
    await tenant_provisioner.provision(db, org)

    # Create default permission sets
    await tenant_provisioner.create_default_permission_sets(db, org)
    await db.flush()

    # Create admin user
    admin_existing = (await db.execute(
        select(User).where(
            (User.username == payload.admin_username) | (User.email == payload.admin_email)
        )
    )).scalar_one_or_none()
    if admin_existing:
        raise HTTPException(400, "Bu kullanıcı adı veya e-posta zaten kullanılıyor")

    admin = User(
        username=payload.admin_username,
        email=payload.admin_email,
        hashed_password=hash_password(payload.admin_password),
        full_name=payload.admin_full_name,
        is_active=True,
        role="admin",  # legacy
        system_role=SystemRole.ORG_ADMIN,
        # Faz 8 phase B — fix: the org-admin must be bound to the new org.
        # (Was `org_id=` — an unmapped attribute — leaving the admin org-less.)
        organization_id=org.id,
    )
    db.add(admin)
    if admin.organization_id is None:
        raise HTTPException(500, "İç hata: organizasyon yöneticisi org'a bağlanamadı")
    await db.commit()
    await db.refresh(org)

    await log_action(
        db, current_user, "organization_created", "organization", org.id, org.name,
        details={"organization_id": org.id, "operation": "organization_created",
                 "actor_user_id": current_user.id, "slug": org.slug,
                 "plan_id": org.plan_id},
    )
    await db.commit()
    return _org_dict(org)


def _json_safe(d: dict) -> dict:
    """Make a before/after-state dict JSON-serialisable for the audit row."""
    out: dict = {}
    for k, v in d.items():
        out[k] = v.isoformat() if isinstance(v, datetime) else v
    return out


@router.patch("/orgs/{org_id}")
async def update_org(
    org_id: int,
    payload: OrgUpdate,
    request: Request,
    current_user: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    """Faz 8 Phase H — update an organization's status / licence / quota.

    Super-admin only. Every change is captured in a structured audit row
    (before → after). Setting `status` keeps the legacy is_active /
    deleted_at flags consistent with the lifecycle.
    """
    org = await db.get(Organization, org_id)
    if not org:
        raise HTTPException(404, "Organizasyon bulunamadı")

    data = payload.model_dump(exclude_unset=True)
    if "status" in data and data["status"] not in {s.value for s in OrgStatus}:
        raise HTTPException(400, "Geçersiz organizasyon durumu")

    before = _json_safe({
        k: getattr(org, k, None) for k in data if hasattr(org, k)
    })
    for field, val in data.items():
        setattr(org, field, val)

    # Keep the legacy flags consistent with the authoritative status.
    if "status" in data:
        org.is_active = org.status == OrgStatus.ACTIVE.value
        if org.status == OrgStatus.ARCHIVED.value and org.deleted_at is None:
            org.deleted_at = datetime.now(timezone.utc)
        elif org.status != OrgStatus.ARCHIVED.value:
            org.deleted_at = None

    await db.commit()
    await db.refresh(org)

    await log_action(
        db, current_user, "organization_updated", "organization", org.id, org.name,
        request=request,
        before_state=before,
        after_state=_json_safe(data),
        details={"organization_id": org.id, "operation": "organization_updated",
                 "actor_user_id": current_user.id},
    )
    await db.commit()
    return _org_dict(org)


@router.get("/orgs/{org_id}/usage")
async def get_org_usage_endpoint(
    org_id: int,
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    """Faz 8 Phase H — per-organization usage vs. quota (super-admin only).
    Every figure is org-scoped — counted with an explicit organization_id
    filter, so it never reflects another tenant's data."""
    org = await db.get(Organization, org_id)
    if not org:
        raise HTTPException(404, "Organizasyon bulunamadı")
    return await get_org_usage(db, org)


@router.post("/orgs/{org_id}/invite")
async def invite_to_org(
    org_id: int,
    payload: OrgInviteCreate,
    current_user: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    org = await db.get(Organization, org_id)
    if not org:
        raise HTTPException(404, "Organizasyon bulunamadı")

    token_str = secrets.token_urlsafe(32)
    invite = InviteToken(
        token=token_str,
        email=payload.email,
        full_name=payload.full_name,
        role="viewer",  # legacy `role` column on invite_tokens kept until next drop
        system_role=payload.system_role,
        organization_id=org_id,
        permission_set_id=payload.permission_set_id,
        created_by=current_user.id,
        expires_at=datetime.now(timezone.utc) + timedelta(hours=payload.expires_hours),
    )
    db.add(invite)
    await db.commit()
    return {"invite_token": token_str, "email": payload.email, "expires_hours": payload.expires_hours}


# ---------------------------------------------------------------------------
# Global permission set templates (org_id=NULL)
# ---------------------------------------------------------------------------

@router.get("/permission-sets")
async def list_global_permission_sets(
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    rows = (await db.execute(
        select(PermissionSet).where(PermissionSet.org_id.is_(None)).order_by(PermissionSet.id)
    )).scalars().all()
    return {"permission_sets": [_pset_dict(p) for p in rows]}


@router.post("/permission-sets", status_code=201)
async def create_global_permission_set(
    payload: GlobalPermSetCreate,
    current_user: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    import copy
    base = copy.deepcopy(DEFAULT_PERMISSIONS)
    if payload.permissions:
        _deep_merge(base, payload.permissions)
    ps = PermissionSet(
        name=payload.name,
        description=payload.description,
        org_id=None,  # global
        permissions=base,
        created_by=current_user.id,
    )
    db.add(ps)
    await db.commit()
    await db.refresh(ps)
    return _pset_dict(ps)


@router.patch("/permission-sets/{ps_id}")
async def update_global_permission_set(
    ps_id: int,
    payload: GlobalPermSetCreate,
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    ps = await db.get(PermissionSet, ps_id)
    if not ps or ps.org_id is not None:
        raise HTTPException(404, "Global şablon bulunamadı")
    if payload.name:
        ps.name = payload.name
    if payload.description is not None:
        ps.description = payload.description
    if payload.permissions:
        import copy
        base = copy.deepcopy(ps.permissions or DEFAULT_PERMISSIONS)
        _deep_merge(base, payload.permissions)
        ps.permissions = base
    await db.commit()
    await db.refresh(ps)
    return _pset_dict(ps)


@router.delete("/permission-sets/{ps_id}", status_code=204)
async def delete_global_permission_set(
    ps_id: int,
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    ps = await db.get(PermissionSet, ps_id)
    if not ps or ps.org_id is not None:
        raise HTTPException(404, "Global şablon bulunamadı")
    await db.delete(ps)
    await db.commit()


# ---------------------------------------------------------------------------
# Helper serializers
# ---------------------------------------------------------------------------

def _plan_dict(p: Plan) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "slug": p.slug,
        "description": p.description,
        "is_active": p.is_active,
        "max_devices": p.max_devices,
        "max_users": p.max_users,
        "max_locations": p.max_locations,
        "max_agents": p.max_agents,
        "features": p.features,
        "price_monthly": p.price_monthly,
        "price_yearly": p.price_yearly,
    }


def _org_dict(o: Organization) -> dict:
    return {
        "id": o.id,
        "name": o.name,
        "slug": o.slug,
        "description": o.description,
        "is_active": o.is_active,
        "contact_email": o.contact_email,
        "plan_id": o.plan_id,
        "schema_name": o.schema_name,
        "trial_ends_at": o.trial_ends_at.isoformat() if o.trial_ends_at else None,
        "subscription_ends_at": o.subscription_ends_at.isoformat() if o.subscription_ends_at else None,
        "created_at": o.created_at.isoformat(),
        # Faz 8 Phase H — lifecycle status, licence window, per-org quota.
        "status": getattr(o, "status", "active"),
        "license_started_at": (
            o.license_started_at.isoformat() if getattr(o, "license_started_at", None) else None
        ),
        "license_expires_at": (
            o.license_expires_at.isoformat() if getattr(o, "license_expires_at", None) else None
        ),
        "quota": {
            "max_locations": getattr(o, "max_locations", None),
            "max_devices": getattr(o, "max_devices", None),
            "max_agents": getattr(o, "max_agents", None),
            "max_users": getattr(o, "max_users", None),
            "max_retention_days": getattr(o, "max_retention_days", None),
        },
    }


def _pset_dict(p: PermissionSet) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "description": p.description,
        "org_id": p.org_id,
        "is_default": p.is_default,
        "cloned_from_id": p.cloned_from_id,
        "permissions": p.permissions,
        "created_at": p.created_at.isoformat(),
        "updated_at": p.updated_at.isoformat(),
    }


def _deep_merge(base: dict, override: dict) -> None:
    for key, val in override.items():
        if key in base and isinstance(base[key], dict) and isinstance(val, dict):
            _deep_merge(base[key], val)
        else:
            base[key] = val


# ---------------------------------------------------------------------------
# Resource assignment schemas
# ---------------------------------------------------------------------------

class AssignResourcesPayload(BaseModel):
    resource_type: str          # "device" | "agent"
    resource_ids: List[Union[int, str]]
    # M6 final drop — accept both keys during the transition; `tenant_id`
    # was the legacy field name, `org_id` is the canonical one. We keep
    # the alias so older frontend builds keep working until cutover.
    org_id: Optional[int] = None
    tenant_id: Optional[int] = None


# ---------------------------------------------------------------------------
# System stats
# ---------------------------------------------------------------------------

@router.get("/system-stats")
async def system_stats(
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    """Platform-wide aggregated stats for the super_admin dashboard.

    M6-B3 — sourced from `Organization` (was `Tenant`). The response JSON
    keys (`tenants`, `top_tenants_by_devices`) are kept verbatim as a
    deprecated alias so the existing frontend renders unchanged; they
    are renamed in the M6 final drop."""
    since_24h = datetime.now(timezone.utc) - timedelta(hours=24)

    total_orgs    = (await db.execute(select(func.count()).select_from(Organization).where(Organization.deleted_at.is_(None)))).scalar() or 0
    active_orgs   = (await db.execute(select(func.count()).select_from(Organization).where(Organization.status == "active"))).scalar() or 0
    total_users   = (await db.execute(select(func.count()).select_from(User))).scalar() or 0
    total_devices = (await db.execute(select(func.count()).select_from(Device).where(Device.is_active == True))).scalar() or 0
    total_locations= (await db.execute(select(func.count()).select_from(Location))).scalar() or 0
    online_devices = (await db.execute(select(func.count()).select_from(Device).where(Device.is_active == True, Device.status == "online"))).scalar() or 0
    offline_devices= (await db.execute(select(func.count()).select_from(Device).where(Device.is_active == True, Device.status == "offline"))).scalar() or 0
    events_24h     = (await db.execute(select(func.count()).select_from(NetworkEvent).where(NetworkEvent.created_at >= since_24h))).scalar() or 0
    critical_24h   = (await db.execute(select(func.count()).select_from(NetworkEvent).where(NetworkEvent.created_at >= since_24h, NetworkEvent.severity == "critical"))).scalar() or 0
    tasks_running  = (await db.execute(select(func.count()).select_from(Task).where(Task.status == "running"))).scalar() or 0

    plan_rows = (await db.execute(
        select(Plan.slug, func.count(Organization.id))
        .outerjoin(Organization, Organization.plan_id == Plan.id)
        .where(Organization.deleted_at.is_(None))
        .group_by(Plan.slug)
    )).fetchall()
    plan_counts = {row[0] or "no_plan": row[1] for row in plan_rows}

    top_org_rows = (await db.execute(
        select(Organization.id, Organization.name, Plan.slug, func.count(Device.id).label("cnt"))
        .outerjoin(Plan, Plan.id == Organization.plan_id)
        .outerjoin(Device, (Device.organization_id == Organization.id) & (Device.is_active == True))
        .where(Organization.deleted_at.is_(None))
        .group_by(Organization.id, Organization.name, Plan.slug)
        .order_by(func.count(Device.id).desc())
        .limit(10)
    )).fetchall()
    top_orgs = [{"id": r[0], "name": r[1], "plan_tier": r[2] or "no_plan", "device_count": r[3]} for r in top_org_rows]

    return {
        # Legacy alias `tenants` is now the organization count.
        "tenants": {"total": total_orgs, "active": active_orgs, "by_plan": plan_counts},
        "organizations": {"total": total_orgs, "active": active_orgs, "by_plan": plan_counts},
        "users": {"total": total_users},
        "devices": {"total": total_devices, "online": online_devices, "offline": offline_devices},
        "locations": {"total": total_locations},
        "events_24h": {"total": events_24h, "critical": critical_24h},
        "tasks": {"running": tasks_running},
        # Legacy alias name; the underlying data is org-sourced now.
        "top_tenants_by_devices": top_orgs,
        "top_organizations_by_devices": top_orgs,
    }


# M6 final drop — legacy /super-admin/tenants/{id}/plan and /toggle-active
# endpoints removed. Use PATCH /super-admin/orgs/{id} (Phase H) for plan,
# status, quota and licence updates.


# ---------------------------------------------------------------------------
# User management (super-admin level)
# ---------------------------------------------------------------------------

@router.get("/users")
async def list_all_users(
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
    skip: int = 0,
    limit: int = 100,
    org_id: Optional[int] = None,
):
    query = select(User).order_by(User.username).offset(skip).limit(limit)
    if org_id is not None:
        query = query.where(User.organization_id == org_id)
    users = (await db.execute(query)).scalars().all()
    total = (await db.execute(select(func.count()).select_from(User).where(
        User.organization_id == org_id if org_id is not None else True
    ))).scalar() or 0
    return {"total": total, "users": [_user_dict(u) for u in users]}


@router.patch("/users/{user_id}")
async def update_user(
    user_id: int,
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
    system_role: Optional[str] = Body(None),
    is_active: Optional[bool] = Body(None),
    full_name: Optional[str] = Body(None),
    org_id: Optional[int] = Body(None),
):
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(404, "Kullanıcı bulunamadı")
    if system_role is not None:
        user.system_role = system_role
    if is_active is not None:
        user.is_active = is_active
    if full_name is not None:
        user.full_name = full_name
    if org_id is not None:
        user.organization_id = org_id
    await db.commit()
    await db.refresh(user)
    return _user_dict(user)


# ---------------------------------------------------------------------------
# User serializer
# ---------------------------------------------------------------------------

def _user_dict(u: User) -> dict:
    return {
        "id": u.id,
        "username": u.username,
        "email": u.email,
        "full_name": u.full_name,
        "is_active": u.is_active,
        "system_role": u.system_role,
        "role": u.role,                              # back-compat property → system_role
        "org_id": u.organization_id,
        # M6 final drop — legacy `tenant_id` alias kept on the response for
        # one release so the frontend can migrate; column is gone.
        "tenant_id": u.organization_id,
        "last_login": u.last_login.isoformat() if u.last_login else None,
        "created_at": u.created_at.isoformat() if u.created_at else None,
    }


# ---------------------------------------------------------------------------
# Resource listing & assignment (super-admin moves devices/agents between orgs)
# ---------------------------------------------------------------------------

@router.get("/resources/devices")
async def list_resources_devices(
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
    org_id: Optional[int] = Query(None),
    # M6 — legacy alias kept for one release while the frontend migrates
    # from `tenant_id` to `org_id`. Prefer `org_id` when both are given.
    tenant_id: Optional[int] = Query(None),
    unassigned: bool = Query(False),
    skip: int = Query(0),
    limit: int = Query(100, le=500),
):
    target_org = org_id if org_id is not None else tenant_id
    q = (
        select(Device, Organization)
        .outerjoin(Organization, Organization.id == Device.organization_id)
        .where(Device.is_active == True)
    )
    if unassigned:
        q = q.where(Device.organization_id.is_(None))
    elif target_org is not None:
        q = q.where(Device.organization_id == target_org)
    q = q.order_by(Device.hostname).offset(skip).limit(limit)
    rows = (await db.execute(q)).all()

    cnt_q = select(func.count()).select_from(Device).where(Device.is_active == True)
    if unassigned:
        cnt_q = cnt_q.where(Device.organization_id.is_(None))
    elif target_org is not None:
        cnt_q = cnt_q.where(Device.organization_id == target_org)
    total = (await db.execute(cnt_q)).scalar() or 0

    return {
        "total": total,
        "devices": [
            {
                "id": d.id,
                "hostname": d.hostname,
                "ip_address": d.ip_address,
                "site": d.site,
                "status": d.status,
                "org_id": d.organization_id,
                "org_name": o.name if o else None,
                # Legacy aliases for one release.
                "tenant_id": d.organization_id,
                "tenant_name": o.name if o else None,
            }
            for d, o in rows
        ],
    }


@router.get("/resources/agents")
async def list_resources_agents(
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
    unassigned: bool = Query(False),
):
    q = (
        select(Agent, Organization)
        .outerjoin(Organization, Organization.id == Agent.organization_id)
        .where(Agent.is_active == True)
    )
    if unassigned:
        q = q.where(Agent.organization_id.is_(None))
    rows = (await db.execute(q)).all()
    return {
        "agents": [
            {
                "id": a.id,
                "name": a.name,
                "status": a.status,
                "platform": a.platform,
                "version": a.version,
                "org_id": a.organization_id,
                "org_name": o.name if o else None,
                "tenant_id": a.organization_id,
                "tenant_name": o.name if o else None,
            }
            for a, o in rows
        ]
    }


@router.patch("/resources/assign")
async def assign_resources(
    payload: AssignResourcesPayload,
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    target_org_id = payload.org_id if payload.org_id is not None else payload.tenant_id
    if target_org_id is None:
        raise HTTPException(400, "org_id (or legacy tenant_id) required")

    org = (await db.execute(select(Organization).where(Organization.id == target_org_id))).scalar_one_or_none()
    if not org:
        raise HTTPException(404, "Hedef organizasyon bulunamadı")

    if not payload.resource_ids:
        raise HTTPException(400, "En az bir kaynak seçilmeli")

    if payload.resource_type == "device":
        await db.execute(
            update(Device)
            .where(Device.id.in_(payload.resource_ids))
            .values(organization_id=target_org_id)
        )
    elif payload.resource_type == "agent":
        await db.execute(
            update(Agent)
            .where(Agent.id.in_(payload.resource_ids))
            .values(organization_id=target_org_id)
        )
    else:
        raise HTTPException(400, "resource_type 'device' veya 'agent' olmalı")

    await db.commit()
    return {
        "ok": True,
        "assigned": len(payload.resource_ids),
        "org_id": target_org_id,
        "org_name": org.name,
        # Legacy aliases for one release.
        "tenant_id": target_org_id,
        "tenant_name": org.name,
    }
