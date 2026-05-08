"""Org admin endpoints: user management, permission sets, location-user assignments."""
import copy
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select, func, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import OrgAdminOrAbove, RbacUser
from app.core.security import hash_password
from app.models.invite_token import InviteToken
from app.models.shared.organization import Organization
from app.models.shared.permission_set import PermissionSet, DEFAULT_PERMISSIONS
from app.models.shared.user_location_perm import UserLocationPerm
from app.models.user import User, SystemRole

router = APIRouter(prefix="/org-admin", tags=["org-admin"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class PermSetCreate(BaseModel):
    name: str
    description: Optional[str] = None
    permissions: dict = {}
    cloned_from_id: Optional[int] = None


class PermSetUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    permissions: Optional[dict] = None
    is_default: Optional[bool] = None


class UserLocationPermAssign(BaseModel):
    user_id: int
    location_id: Optional[int] = None   # None = org-wide default
    permission_set_id: int


class OrgInviteCreate(BaseModel):
    email: EmailStr
    full_name: Optional[str] = None
    system_role: str = "member"
    permission_set_id: Optional[int] = None
    expires_hours: int = 72


class OrgUserUpdate(BaseModel):
    full_name: Optional[str] = None
    is_active: Optional[bool] = None
    system_role: Optional[str] = None


# ---------------------------------------------------------------------------
# Org info
# ---------------------------------------------------------------------------

@router.get("/org")
async def get_my_org(
    current_user: OrgAdminOrAbove,
    db: AsyncSession = Depends(get_db),
):
    if not current_user.org_id:
        raise HTTPException(404, "Organizasyona bağlı değilsiniz")
    org = await db.get(Organization, current_user.org_id)
    if not org:
        raise HTTPException(404, "Organizasyon bulunamadı")

    # Load plan limits
    from app.models.shared.plan import Plan
    plan = await db.get(Plan, org.plan_id) if org.plan_id else None

    user_count = (await db.execute(
        select(func.count()).select_from(User).where(User.org_id == org.id, User.is_active == True)
    )).scalar()

    return {
        "id": org.id,
        "name": org.name,
        "slug": org.slug,
        "description": org.description,
        "contact_email": org.contact_email,
        "is_active": org.is_active,
        "trial_ends_at": org.trial_ends_at.isoformat() if org.trial_ends_at else None,
        "subscription_ends_at": org.subscription_ends_at.isoformat() if org.subscription_ends_at else None,
        "plan": {
            "name": plan.name,
            "max_devices": plan.max_devices,
            "max_users": plan.max_users,
            "max_locations": plan.max_locations,
            "max_agents": plan.max_agents,
            "features": plan.features,
        } if plan else None,
        "usage": {"users": user_count},
    }


# ---------------------------------------------------------------------------
# User management
# ---------------------------------------------------------------------------

@router.get("/users")
async def list_users(
    current_user: OrgAdminOrAbove,
    db: AsyncSession = Depends(get_db),
    page: int = 1,
    per_page: int = 50,
):
    offset = (page - 1) * per_page
    if _is_super(current_user):
        # Super admin sees all users across all organizations
        where_clause = []
    else:
        org_id = current_user.org_id
        if not org_id:
            raise HTTPException(400, "Organizasyona bağlı değilsiniz")
        where_clause = [User.org_id == org_id]

    total = (await db.execute(
        select(func.count()).select_from(User).where(*where_clause)
    )).scalar()
    rows = (await db.execute(
        select(User)
        .where(*where_clause)
        .order_by(User.id)
        .offset(offset).limit(per_page)
    )).scalars().all()
    return {"total": total, "users": [_user_dict(u) for u in rows]}


@router.get("/users/{user_id}")
async def get_user(
    user_id: int,
    current_user: OrgAdminOrAbove,
    db: AsyncSession = Depends(get_db),
):
    scope_org = None if _is_super(current_user) else current_user.org_id
    user = await _get_org_user(db, user_id, scope_org)
    perms = await _get_user_perm_assignments(db, user.id)
    d = _user_dict(user)
    d["perm_assignments"] = perms
    return d


@router.patch("/users/{user_id}")
async def update_user(
    user_id: int,
    payload: OrgUserUpdate,
    current_user: OrgAdminOrAbove,
    db: AsyncSession = Depends(get_db),
):
    scope_org = None if _is_super(current_user) else current_user.org_id
    user = await _get_org_user(db, user_id, scope_org)

    # Org admin cannot promote to super_admin
    if payload.system_role == SystemRole.SUPER_ADMIN and not current_user.is_super_admin:
        raise HTTPException(403, "Super admin yetkisi veremezsiniz")

    for field, val in payload.model_dump(exclude_unset=True).items():
        setattr(user, field, val)
    await db.commit()
    await db.refresh(user)
    return _user_dict(user)


@router.delete("/users/{user_id}", status_code=204)
async def remove_user(
    user_id: int,
    current_user: OrgAdminOrAbove,
    db: AsyncSession = Depends(get_db),
):
    scope_org = None if _is_super(current_user) else current_user.org_id
    user = await _get_org_user(db, user_id, scope_org)
    if user.id == current_user.id:
        raise HTTPException(400, "Kendinizi silemezsiniz")
    # Soft-delete: deactivate instead of hard delete
    user.is_active = False
    user.org_id = None
    await db.commit()


# ---------------------------------------------------------------------------
# Invite
# ---------------------------------------------------------------------------

@router.post("/invite")
async def invite_member(
    payload: OrgInviteCreate,
    current_user: OrgAdminOrAbove,
    db: AsyncSession = Depends(get_db),
):
    org_id = current_user.org_id
    if not org_id:
        raise HTTPException(400, "Organizasyona bağlı değilsiniz")

    # Enforce plan user limit
    org = await db.get(Organization, org_id)
    if org and org.plan_id:
        from app.models.shared.plan import Plan
        plan = await db.get(Plan, org.plan_id)
        if plan:
            current_count = (await db.execute(
                select(func.count()).select_from(User).where(
                    User.org_id == org_id, User.is_active == True
                )
            )).scalar()
            if current_count >= plan.max_users:
                raise HTTPException(400, f"Plan kullanıcı limitine ulaşıldı ({plan.max_users})")

    # Validate permission set belongs to org (or is global)
    if payload.permission_set_id:
        ps = await db.get(PermissionSet, payload.permission_set_id)
        if not ps or (ps.org_id is not None and ps.org_id != org_id):
            raise HTTPException(400, "Geçersiz yetki seti")

    # Org admin cannot invite super_admin
    if payload.system_role == SystemRole.SUPER_ADMIN and not current_user.is_super_admin:
        raise HTTPException(403, "Super admin daveti veremezsiniz")

    token_str = secrets.token_urlsafe(32)
    invite = InviteToken(
        token=token_str,
        email=payload.email,
        full_name=payload.full_name,
        role="viewer",
        tenant_id=None,
        system_role=payload.system_role,
        org_id=org_id,
        permission_set_id=payload.permission_set_id,
        created_by=current_user.id,
        expires_at=datetime.now(timezone.utc) + timedelta(hours=payload.expires_hours),
    )
    db.add(invite)
    await db.commit()
    return {
        "invite_token": token_str,
        "email": payload.email,
        "expires_hours": payload.expires_hours,
    }


# ---------------------------------------------------------------------------
# Permission sets (org-scoped)
# ---------------------------------------------------------------------------

@router.get("/permission-sets")
async def list_permission_sets(
    current_user: OrgAdminOrAbove,
    db: AsyncSession = Depends(get_db),
):
    org_id = current_user.org_id
    rows = (await db.execute(
        select(PermissionSet).where(
            (PermissionSet.org_id == org_id) | (PermissionSet.org_id.is_(None))
        ).order_by(PermissionSet.org_id.nulls_first(), PermissionSet.id)
    )).scalars().all()
    return {"permission_sets": [_pset_dict(p) for p in rows]}


@router.post("/permission-sets", status_code=201)
async def create_permission_set(
    payload: PermSetCreate,
    current_user: OrgAdminOrAbove,
    db: AsyncSession = Depends(get_db),
):
    org_id = current_user.org_id
    if not org_id:
        raise HTTPException(400, "Organizasyona bağlı değilsiniz")

    base = copy.deepcopy(DEFAULT_PERMISSIONS)

    # Clone from global template if requested
    if payload.cloned_from_id:
        source = await db.get(PermissionSet, payload.cloned_from_id)
        if not source or source.org_id is not None:
            raise HTTPException(400, "Sadece global şablonlardan kopyalama yapılabilir")
        base = copy.deepcopy(source.permissions)

    if payload.permissions:
        _deep_merge(base, payload.permissions)

    ps = PermissionSet(
        name=payload.name,
        description=payload.description,
        org_id=org_id,
        cloned_from_id=payload.cloned_from_id,
        permissions=base,
        created_by=current_user.id,
    )
    db.add(ps)
    await db.commit()
    await db.refresh(ps)
    return _pset_dict(ps)


@router.patch("/permission-sets/{ps_id}")
async def update_permission_set(
    ps_id: int,
    payload: PermSetUpdate,
    current_user: OrgAdminOrAbove,
    db: AsyncSession = Depends(get_db),
):
    ps = await db.get(PermissionSet, ps_id)
    if not ps or ps.org_id != current_user.org_id:
        raise HTTPException(404, "Yetki seti bulunamadı")

    if payload.name is not None:
        ps.name = payload.name
    if payload.description is not None:
        ps.description = payload.description
    if payload.is_default is not None:
        if payload.is_default:
            await db.execute(
                sa_update(PermissionSet)
                .where(PermissionSet.org_id == current_user.org_id)
                .values(is_default=False)
            )
        ps.is_default = payload.is_default
    if payload.permissions is not None:
        base = copy.deepcopy(ps.permissions or DEFAULT_PERMISSIONS)
        _deep_merge(base, payload.permissions)
        ps.permissions = base

    await db.commit()
    await db.refresh(ps)
    return _pset_dict(ps)


@router.delete("/permission-sets/{ps_id}", status_code=204)
async def delete_permission_set(
    ps_id: int,
    current_user: OrgAdminOrAbove,
    db: AsyncSession = Depends(get_db),
):
    ps = await db.get(PermissionSet, ps_id)
    if not ps or ps.org_id != current_user.org_id:
        raise HTTPException(404, "Yetki seti bulunamadı")
    await db.delete(ps)
    await db.commit()


# ---------------------------------------------------------------------------
# Location-user permission assignments
# ---------------------------------------------------------------------------

@router.get("/users/{user_id}/permissions")
async def get_user_permissions(
    user_id: int,
    current_user: OrgAdminOrAbove,
    db: AsyncSession = Depends(get_db),
):
    scope_org = None if _is_super(current_user) else current_user.org_id
    await _get_org_user(db, user_id, scope_org)
    assignments = await _get_user_perm_assignments(db, user_id)
    return {"user_id": user_id, "assignments": assignments}


@router.put("/users/{user_id}/permissions")
async def assign_user_permission(
    user_id: int,
    payload: UserLocationPermAssign,
    current_user: OrgAdminOrAbove,
    db: AsyncSession = Depends(get_db),
):
    """Create or replace a permission assignment for (user, location)."""
    scope_org = None if _is_super(current_user) else current_user.org_id
    await _get_org_user(db, user_id, scope_org)

    # Validate permission set
    ps = await db.get(PermissionSet, payload.permission_set_id)
    if not ps or (ps.org_id is not None and ps.org_id != current_user.org_id):
        raise HTTPException(400, "Geçersiz yetki seti")

    # Upsert
    existing = (await db.execute(
        select(UserLocationPerm).where(
            UserLocationPerm.user_id == user_id,
            UserLocationPerm.location_id == payload.location_id
            if payload.location_id is not None
            else UserLocationPerm.location_id.is_(None),
        )
    )).scalar_one_or_none()

    if existing:
        existing.permission_set_id = payload.permission_set_id
        existing.assigned_by = current_user.id
        existing.assigned_at = datetime.now(timezone.utc)
    else:
        existing = UserLocationPerm(
            user_id=user_id,
            location_id=payload.location_id,
            permission_set_id=payload.permission_set_id,
            assigned_by=current_user.id,
        )
        db.add(existing)

    await db.commit()
    return {"user_id": user_id, "location_id": payload.location_id, "permission_set_id": payload.permission_set_id}


@router.delete("/users/{user_id}/permissions/{ulp_id}", status_code=204)
async def remove_user_permission(
    user_id: int,
    ulp_id: int,
    current_user: OrgAdminOrAbove,
    db: AsyncSession = Depends(get_db),
):
    scope_org = None if _is_super(current_user) else current_user.org_id
    await _get_org_user(db, user_id, scope_org)
    ulp = await db.get(UserLocationPerm, ulp_id)
    if not ulp or ulp.user_id != user_id:
        raise HTTPException(404, "Atama bulunamadı")
    await db.delete(ulp)
    await db.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_super(user: User) -> bool:
    return (
        user.system_role == SystemRole.SUPER_ADMIN
        or getattr(user, "role", None) == "super_admin"
    )


async def _get_org_user(db: AsyncSession, user_id: int, org_id: Optional[int]) -> User:
    """org_id=None means caller is super_admin — skip org ownership check."""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Kullanıcı bulunamadı")
    if org_id is not None and user.org_id != org_id:
        raise HTTPException(404, "Kullanıcı bulunamadı")
    return user


async def _get_user_perm_assignments(db: AsyncSession, user_id: int) -> list:
    rows = (await db.execute(
        select(UserLocationPerm).where(UserLocationPerm.user_id == user_id)
    )).scalars().all()
    return [
        {
            "id": r.id,
            "location_id": r.location_id,
            "permission_set_id": r.permission_set_id,
            "assigned_at": r.assigned_at.isoformat(),
        }
        for r in rows
    ]


def _user_dict(u: User) -> dict:
    return {
        "id": u.id,
        "username": u.username,
        "email": u.email,
        "full_name": u.full_name,
        "is_active": u.is_active,
        "system_role": u.system_role,
        "org_id": u.org_id,
        "last_login": u.last_login.isoformat() if u.last_login else None,
        "created_at": u.created_at.isoformat(),
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
