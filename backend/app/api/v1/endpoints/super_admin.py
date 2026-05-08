"""Super admin endpoints: plan management, org management, global permission sets, system stats."""
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Union

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
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
from app.models.shared.organization import Organization
from app.models.shared.permission_set import PermissionSet, DEFAULT_PERMISSIONS
from app.models.shared.plan import Plan
from app.models.task import Task
from app.models.tenant import Tenant
from app.models.user import User, SystemRole

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
):
    offset = (page - 1) * per_page
    total = (await db.execute(select(func.count()).select_from(Organization))).scalar()
    rows = (await db.execute(
        select(Organization).order_by(Organization.id).offset(offset).limit(per_page)
    )).scalars().all()
    return {"total": total, "orgs": [_org_dict(o) for o in rows]}


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
        org_id=org.id,
    )
    db.add(admin)
    await db.commit()
    await db.refresh(org)
    return _org_dict(org)


@router.patch("/orgs/{org_id}")
async def update_org(
    org_id: int,
    payload: OrgUpdate,
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    org = await db.get(Organization, org_id)
    if not org:
        raise HTTPException(404, "Organizasyon bulunamadı")
    for field, val in payload.model_dump(exclude_unset=True).items():
        setattr(org, field, val)
    await db.commit()
    await db.refresh(org)
    return _org_dict(org)


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
        role="viewer",  # legacy
        tenant_id=None,
        system_role=payload.system_role,
        org_id=org_id,
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
    tenant_id: int              # target tenant


# ---------------------------------------------------------------------------
# System stats
# ---------------------------------------------------------------------------

@router.get("/system-stats")
async def system_stats(
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    """Platform-wide aggregated stats for the super_admin dashboard."""
    since_24h = datetime.now(timezone.utc) - timedelta(hours=24)

    total_tenants  = (await db.execute(select(func.count()).select_from(Tenant))).scalar() or 0
    active_tenants = (await db.execute(select(func.count()).select_from(Tenant).where(Tenant.is_active == True))).scalar() or 0
    total_users    = (await db.execute(select(func.count()).select_from(User))).scalar() or 0
    total_devices  = (await db.execute(select(func.count()).select_from(Device).where(Device.is_active == True))).scalar() or 0
    total_locations= (await db.execute(select(func.count()).select_from(Location))).scalar() or 0
    online_devices = (await db.execute(select(func.count()).select_from(Device).where(Device.is_active == True, Device.status == "online"))).scalar() or 0
    offline_devices= (await db.execute(select(func.count()).select_from(Device).where(Device.is_active == True, Device.status == "offline"))).scalar() or 0
    events_24h     = (await db.execute(select(func.count()).select_from(NetworkEvent).where(NetworkEvent.created_at >= since_24h))).scalar() or 0
    critical_24h   = (await db.execute(select(func.count()).select_from(NetworkEvent).where(NetworkEvent.created_at >= since_24h, NetworkEvent.severity == "critical"))).scalar() or 0
    tasks_running  = (await db.execute(select(func.count()).select_from(Task).where(Task.status == "running"))).scalar() or 0

    plan_rows = (await db.execute(select(Tenant.plan_tier, func.count()).group_by(Tenant.plan_tier))).fetchall()
    plan_counts = {row[0]: row[1] for row in plan_rows}

    tenant_device_rows = (await db.execute(
        select(Tenant.id, Tenant.name, Tenant.plan_tier, func.count(Device.id).label("cnt"))
        .outerjoin(Device, Device.tenant_id == Tenant.id)
        .where(Device.is_active == True)
        .group_by(Tenant.id, Tenant.name, Tenant.plan_tier)
        .order_by(func.count(Device.id).desc())
        .limit(10)
    )).fetchall()
    top_tenants = [{"id": r[0], "name": r[1], "plan_tier": r[2], "device_count": r[3]} for r in tenant_device_rows]

    return {
        "tenants": {"total": total_tenants, "active": active_tenants, "by_plan": plan_counts},
        "users": {"total": total_users},
        "devices": {"total": total_devices, "online": online_devices, "offline": offline_devices},
        "locations": {"total": total_locations},
        "events_24h": {"total": events_24h, "critical": critical_24h},
        "tasks": {"running": tasks_running},
        "top_tenants_by_devices": top_tenants,
    }


# ---------------------------------------------------------------------------
# Tenant (legacy) management
# ---------------------------------------------------------------------------

@router.patch("/tenants/{tenant_id}/plan")
async def update_tenant_plan(
    tenant_id: int,
    plan_tier: str,
    max_devices: int,
    max_users: int,
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    tenant = (await db.execute(select(Tenant).where(Tenant.id == tenant_id))).scalar_one_or_none()
    if not tenant:
        raise HTTPException(404, "Tenant bulunamadı")
    tenant.plan_tier = plan_tier
    tenant.max_devices = max_devices
    tenant.max_users = max_users
    await db.commit()
    return {"ok": True}


@router.patch("/tenants/{tenant_id}/toggle-active")
async def toggle_tenant_active(
    tenant_id: int,
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    tenant = (await db.execute(select(Tenant).where(Tenant.id == tenant_id))).scalar_one_or_none()
    if not tenant:
        raise HTTPException(404, "Tenant bulunamadı")
    tenant.is_active = not tenant.is_active
    await db.commit()
    return {"is_active": tenant.is_active}


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
        query = query.where(User.org_id == org_id)
    users = (await db.execute(query)).scalars().all()
    total = (await db.execute(select(func.count()).select_from(User).where(
        User.org_id == org_id if org_id is not None else True
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
        user.org_id = org_id
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
        "role": u.role,
        "org_id": u.org_id,
        "tenant_id": u.tenant_id,
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
    tenant_id: Optional[int] = Query(None),
    unassigned: bool = Query(False),
    skip: int = Query(0),
    limit: int = Query(100, le=500),
):
    q = (
        select(Device, Tenant)
        .outerjoin(Tenant, Tenant.id == Device.tenant_id)
        .where(Device.is_active == True)
    )
    if unassigned:
        q = q.where(Device.tenant_id.is_(None))
    elif tenant_id is not None:
        q = q.where(Device.tenant_id == tenant_id)
    q = q.order_by(Device.hostname).offset(skip).limit(limit)
    rows = (await db.execute(q)).all()

    cnt_q = select(func.count()).select_from(Device).where(Device.is_active == True)
    if unassigned:
        cnt_q = cnt_q.where(Device.tenant_id.is_(None))
    elif tenant_id is not None:
        cnt_q = cnt_q.where(Device.tenant_id == tenant_id)
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
                "tenant_id": d.tenant_id,
                "tenant_name": t.name if t else None,
            }
            for d, t in rows
        ],
    }


@router.get("/resources/agents")
async def list_resources_agents(
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
    unassigned: bool = Query(False),
):
    q = (
        select(Agent, Tenant)
        .outerjoin(Tenant, Tenant.id == Agent.tenant_id)
        .where(Agent.is_active == True)
    )
    if unassigned:
        q = q.where(Agent.tenant_id.is_(None))
    rows = (await db.execute(q)).all()
    return {
        "agents": [
            {
                "id": a.id,
                "name": a.name,
                "status": a.status,
                "platform": a.platform,
                "version": a.version,
                "tenant_id": a.tenant_id,
                "tenant_name": t.name if t else None,
            }
            for a, t in rows
        ]
    }


@router.patch("/resources/assign")
async def assign_resources(
    payload: AssignResourcesPayload,
    _: SuperAdminOnly,
    db: AsyncSession = Depends(get_db),
):
    tenant = (await db.execute(select(Tenant).where(Tenant.id == payload.tenant_id))).scalar_one_or_none()
    if not tenant:
        raise HTTPException(404, "Hedef organizasyon bulunamadı")

    if not payload.resource_ids:
        raise HTTPException(400, "En az bir kaynak seçilmeli")

    if payload.resource_type == "device":
        await db.execute(
            update(Device)
            .where(Device.id.in_(payload.resource_ids))
            .values(tenant_id=payload.tenant_id)
        )
    elif payload.resource_type == "agent":
        await db.execute(
            update(Agent)
            .where(Agent.id.in_(payload.resource_ids))
            .values(tenant_id=payload.tenant_id)
        )
    else:
        raise HTTPException(400, "resource_type 'device' veya 'agent' olmalı")

    await db.commit()
    return {"ok": True, "assigned": len(payload.resource_ids), "tenant_id": payload.tenant_id, "tenant_name": tenant.name}
