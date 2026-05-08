"""Super admin endpoints: plan management, org management, global permission sets."""
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select, update, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import SuperAdminOnly
from app.core.security import hash_password
from app.models.invite_token import InviteToken
from app.models.shared.organization import Organization
from app.models.shared.permission_set import PermissionSet, DEFAULT_PERMISSIONS
from app.models.shared.plan import Plan
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
