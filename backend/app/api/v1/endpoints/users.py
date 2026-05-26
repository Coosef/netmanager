from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, require_system_role
from app.core.security import hash_password, verify_password
from app.models.location import Location
from app.models.shared.organization import Organization
from app.models.user import SystemRole, User
from app.models.user_location import UserLocation
from app.schemas.user import AdminPasswordReset, UserCreate, UserPasswordChange, UserResponse, UserUpdate
from app.services.audit_service import log_action

# M6-B4 — privileged-role values, as strings. UserCreate / UserUpdate
# carry `role` as a plain str, so the privilege guards compare against
# the union of new (SystemRole) and legacy (UserRole) string values for
# back-compat until the legacy `users.role` column drops in the final M6.
_PRIVILEGED_ROLES = {"super_admin", "admin", "org_admin"}

router = APIRouter()

AdminRequired = Depends(require_system_role(SystemRole.SUPER_ADMIN, SystemRole.ORG_ADMIN))


def _is_platform_admin(user: User) -> bool:
    """True for SUPER_ADMIN, or for an ORG_ADMIN not bound to an
    organization — both have unrestricted access. (M6-B4: now keyed off
    `system_role`; the legacy `role` column is no longer consulted.)"""
    return user.system_role == SystemRole.SUPER_ADMIN or (
        user.system_role == SystemRole.ORG_ADMIN and not user.organization_id
    )


async def _with_org_dict(db, user: User) -> dict:
    """Build the UserResponse dict, joining the user's organization for
    its name (was the legacy Tenant — M6-B1: `tenant_name` is kept as a
    deprecated alias of `organization_name` so the frontend can migrate
    without coordination)."""
    org_name = None
    if user.organization_id:
        o = (await db.execute(
            select(Organization).where(Organization.id == user.organization_id)
        )).scalar_one_or_none()
        if o:
            org_name = o.name

    loc_rows = (await db.execute(
        select(UserLocation, Location)
        .join(Location, Location.id == UserLocation.location_id)
        .where(UserLocation.user_id == user.id)
        .order_by(Location.name)
    )).all()
    locations = [
        {"location_id": ul.location_id, "location_name": loc.name, "loc_role": ul.loc_role}
        for ul, loc in loc_rows
    ]

    return {
        **UserResponse.model_validate(user).model_dump(),
        "organization_name": org_name,
        "locations": locations,
    }


@router.get("/", response_model=list[UserResponse])
async def list_users(
    db: AsyncSession = Depends(get_db),
    current_user: User = AdminRequired,
    skip: int = 0,
    limit: int = 100,
):
    q = select(User)
    # M6-B1 — platform admins (SUPER_ADMIN / org-less ADMIN) see all users;
    # everyone else is scoped to their own organization.
    if not _is_platform_admin(current_user):
        q = q.where(User.organization_id == current_user.organization_id)
    result = await db.execute(q.offset(skip).limit(limit))
    users = result.scalars().all()
    return [await _with_org_dict(db, u) for u in users]


@router.post("/", response_model=UserResponse, status_code=201)
async def create_user(
    payload: UserCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_system_role(SystemRole.SUPER_ADMIN, SystemRole.ORG_ADMIN)),
):
    # M6-B1 — pick the new user's organization. Platform admins may
    # target any org via `payload.organization_id`; an org-scoped ADMIN
    # always creates in their own org and cannot escalate to ADMIN/SA.
    if _is_platform_admin(current_user):
        org_id = payload.organization_id
    else:
        if payload.role in _PRIVILEGED_ROLES:
            raise HTTPException(status_code=403, detail="ADMIN cannot create ADMIN or SUPER_ADMIN users")
        org_id = current_user.organization_id

    # Faz 8 Phase H — organization quota + lifecycle: refuse once the
    # org's user quota is reached (a platform super-admin may override).
    if org_id is not None:
        from app.core.request_context import is_super_admin as _is_super
        from app.services.org_management import enforce_org_can_create
        _org = await db.get(Organization, org_id)
        await enforce_org_can_create(
            db, _org, "users",
            actor_user_id=current_user.id,
            is_super_admin=_is_super(current_user),
        )

    existing = await db.execute(select(User).where(User.username == payload.username))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Username already exists")

    # T9 Tur 2 #3 — initial password policy + force-change-on-first-login
    from app.services import password_policy_service as _pwp
    policy = await _pwp.get_effective_policy(db, org_id)
    ok, errs = _pwp.validate_password(payload.password, policy)
    if not ok:
        raise HTTPException(status_code=400, detail={"errors": errs, "policy_source": policy.source})

    from datetime import datetime as _dt, timezone as _tz
    user = User(
        username=payload.username,
        email=payload.email,
        hashed_password=hash_password(payload.password),
        full_name=payload.full_name,
        role=payload.role,
        notes=payload.notes,
        organization_id=org_id,
        password_changed_at=_dt.now(_tz.utc),
        must_change_password=policy.force_change_on_first_login,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    await log_action(db, current_user, "user_created", "user", user.id, user.username, request=request)
    return await _with_org_dict(db, user)


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = AdminRequired,
):
    q = select(User).where(User.id == user_id)
    if not _is_platform_admin(current_user):
        q = q.where(User.organization_id == current_user.organization_id)
    user = (await db.execute(q)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return await _with_org_dict(db, user)


@router.patch("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: int,
    payload: UserUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_system_role(SystemRole.SUPER_ADMIN, SystemRole.ORG_ADMIN)),
):
    q = select(User).where(User.id == user_id)
    if not _is_platform_admin(current_user):
        q = q.where(User.organization_id == current_user.organization_id)
    user = (await db.execute(q)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    data = payload.model_dump(exclude_unset=True)

    if not _is_platform_admin(current_user):
        # Org-scoped admin: cannot reassign organization or escalate to SA.
        # `tenant_id` is silently dropped (legacy alias) so an old client
        # cannot accidentally move a user across orgs through the back door.
        data.pop("organization_id", None)
        data.pop("tenant_id", None)
        if data.get("role") in ("super_admin",):
            raise HTTPException(status_code=403, detail="Cannot elevate to SUPER_ADMIN")

    # T9 Tur 2 #4 — allowed_ips strict validation (geçersiz CIDR ile
    # kullanıcının kendini kilitlemesini engelle)
    if "allowed_ips" in data and data["allowed_ips"] is not None:
        from app.services.ip_allowlist import validate_csv as _ip_validate
        # Boş string'i NULL'a normalize et — "kısıt yok"
        if not data["allowed_ips"].strip():
            data["allowed_ips"] = None
        else:
            ok, err = _ip_validate(data["allowed_ips"])
            if not ok:
                raise HTTPException(status_code=400, detail=err)

    for field, value in data.items():
        setattr(user, field, value)

    await db.commit()
    await db.refresh(user)
    await log_action(db, current_user, "user_updated", "user", user_id, user.username, request=request)
    return await _with_org_dict(db, user)


@router.delete("/{user_id}", status_code=204)
async def delete_user(
    user_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_system_role(SystemRole.SUPER_ADMIN, SystemRole.ORG_ADMIN)),
):
    q = select(User).where(User.id == user_id)
    if not _is_platform_admin(current_user):
        q = q.where(User.organization_id == current_user.organization_id)
    user = (await db.execute(q)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
    # Org-scoped ADMIN cannot delete ADMIN or SA users
    if not _is_platform_admin(current_user) and user.system_role in (SystemRole.SUPER_ADMIN, SystemRole.ORG_ADMIN):
        raise HTTPException(status_code=403, detail="ADMIN cannot delete ADMIN or SUPER_ADMIN users")

    await db.execute(delete(UserLocation).where(UserLocation.user_id == user.id))
    await db.delete(user)
    await db.commit()
    await log_action(db, current_user, "user_deleted", "user", user_id, user.username, request=request)


@router.post("/{user_id}/reset-password", status_code=204)
async def admin_reset_password(
    user_id: int,
    payload: AdminPasswordReset,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_system_role(SystemRole.SUPER_ADMIN, SystemRole.ORG_ADMIN)),
):
    q = select(User).where(User.id == user_id)
    if not _is_platform_admin(current_user):
        q = q.where(User.organization_id == current_user.organization_id)
    user = (await db.execute(q)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not _is_platform_admin(current_user) and user.system_role == SystemRole.SUPER_ADMIN:
        raise HTTPException(status_code=403, detail="Cannot reset SUPER_ADMIN password")

    # T9 Tur 2 #3 — Admin password reset de policy'ye karşı validate
    from app.services import password_policy_service as _pwp
    policy = await _pwp.get_effective_policy(db, user.organization_id)
    ok, errs = _pwp.validate_password(payload.new_password, policy)
    if not ok:
        raise HTTPException(status_code=400, detail={"errors": errs, "policy_source": policy.source})

    _pwp.register_password_change(user, payload.new_password, policy)
    # Admin reset → kullanıcı bir sonraki login'de zorla değişim
    user.must_change_password = True
    await db.commit()
    await log_action(db, current_user, "password_reset", "user", user_id, user.username, request=request)


@router.post("/me/change-password", status_code=204)
async def change_my_password(
    payload: UserPasswordChange,
    request: Request,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    user = (await db.execute(select(User).where(User.id == current_user.id))).scalar_one()

    if not verify_password(payload.current_password, user.hashed_password):
        raise HTTPException(status_code=400, detail="Mevcut şifre hatalı")

    # T9 Tur 2 #3 — Policy validation + reuse check
    from app.services import password_policy_service as _pwp
    policy = await _pwp.get_effective_policy(db, user.organization_id)
    ok, errs = _pwp.validate_password(payload.new_password, policy)
    if not ok:
        raise HTTPException(status_code=400, detail={"errors": errs, "policy_source": policy.source})
    if _pwp.is_reused(payload.new_password, user.password_history):
        raise HTTPException(
            status_code=400,
            detail=f"Bu şifre son {policy.history_count} şifre arasında — yeni bir tane seçin",
        )

    _pwp.register_password_change(user, payload.new_password, policy)
    await db.commit()
    await log_action(db, user, "password_changed", "user", user.id, request=request)


# ── Self profile — viewable by any authenticated user ─────────────────────────


class _MyAllowedIpsPayload(BaseModel):
    """T9 Tur 2 #4 follow-up — self-edit payload."""
    allowed_ips: Optional[str] = None  # CSV "10.0.0.0/8,192.168.1.5"; "" = clear


@router.patch("/me/login-ip")
async def update_my_login_ip(
    payload: _MyAllowedIpsPayload,
    request: Request,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """T9 Tur 2 #4 follow-up — kullanıcı kendi allowed_ips listesini günceller.

    Self-lockout koruması: gelen CSV mevcut isteğin client IP'sini içermiyorsa
    409 ile reddedilir (kullanıcı boş string göndererek allowlist'i hep
    temizleyebilir). Strict CIDR doğrulaması admin update path'iyle aynıdır.
    """
    from app.services.ip_allowlist import validate_csv as _ip_validate
    from app.services.ip_allowlist import is_allowed as _ip_allowed

    raw = payload.allowed_ips
    if raw is None or not raw.strip():
        # Empty / null clears the allowlist — no validation needed.
        current_user.allowed_ips = None
    else:
        ok, err = _ip_validate(raw)
        if not ok:
            raise HTTPException(status_code=400, detail=err)
        client_ip = request.client.host if request.client else None
        if client_ip and not _ip_allowed(client_ip, raw):
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Yeni allowlist mevcut IP'nizi ({client_ip}) içermiyor — "
                    f"kaydedilseydi bu oturumdan sonra giremezdiniz. "
                    f"IP'nizi ekleyin veya listeyi boş bırakın."
                ),
            )
        current_user.allowed_ips = raw

    await db.commit()
    await log_action(
        db, current_user, "user_allowed_ips_self_updated",
        "user", current_user.id, current_user.username, request=request,
    )
    return {"allowed_ips": current_user.allowed_ips}


@router.get("/me/login-ip")
async def my_login_ip(request: Request, current_user: CurrentUser):
    """T9 Tur 2 #4 — Mevcut kullanıcının login IP'sini döndürür.
    UI'da Users drawer'da 'Şu anki IP'm: X' göstererek allowlist'e dahil
    edip etmediğini kullanıcının görmesi için. allowed_ips listesine karşı
    kullanıcının yanlışlıkla kendini kilitlemesini engelleyen safety net."""
    from app.services.ip_allowlist import is_allowed as _ip_allowed
    client_ip = request.client.host if request.client else None
    return {
        "client_ip": client_ip,
        "allowed_ips": current_user.allowed_ips,
        # Kullanıcının mevcut allowlist'i kabul edip etmediği (UI'da uyarı):
        "matches_current_allowlist": _ip_allowed(client_ip, current_user.allowed_ips),
    }


@router.get("/me/locations", response_model=list[dict])
async def get_my_locations(
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Return the calling user's own location assignments.

    Mirrors GET /users/{user_id}/locations but bypasses the AdminRequired gate
    so a non-admin user can see their own scope on the profile page. Returns
    an empty list for org-wide / super-admin users (they aren't bound to any
    specific location).
    """
    rows = (await db.execute(
        select(UserLocation, Location)
        .join(Location, Location.id == UserLocation.location_id)
        .where(UserLocation.user_id == current_user.id)
        .order_by(Location.name)
    )).all()

    return [
        {
            "location_id": ul.location_id,
            "location_name": loc.name,
            "loc_role": ul.loc_role,
            "assigned_at": ul.assigned_at.isoformat() if ul.assigned_at else None,
        }
        for ul, loc in rows
    ]


# ── User location assignments (viewed from user side) ────────────────────────

@router.get("/{user_id}/locations", response_model=list[dict])
async def get_user_locations(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = AdminRequired,
):
    q = select(User).where(User.id == user_id)
    if not _is_platform_admin(current_user):
        q = q.where(User.organization_id == current_user.organization_id)
    user = (await db.execute(q)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    rows = (await db.execute(
        select(UserLocation, Location)
        .join(Location, Location.id == UserLocation.location_id)
        .where(UserLocation.user_id == user_id)
        .order_by(Location.name)
    )).all()

    return [
        {
            "location_id": ul.location_id,
            "location_name": loc.name,
            "loc_role": ul.loc_role,
            "assigned_at": ul.assigned_at.isoformat(),
        }
        for ul, loc in rows
    ]


@router.put("/{user_id}/locations", response_model=dict)
async def set_user_locations(
    user_id: int,
    payload: list[dict],  # [{"location_id": 1, "loc_role": "location_manager"}, ...]
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = AdminRequired,
):
    """Replace all location assignments for a user at once."""
    q = select(User).where(User.id == user_id)
    if not _is_platform_admin(current_user):
        q = q.where(User.organization_id == current_user.organization_id)
    user = (await db.execute(q)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Delete all existing assignments
    await db.execute(delete(UserLocation).where(UserLocation.user_id == user_id))

    # M6-B1 — collect valid location IDs scoped to the caller's
    # organization (platform admins unrestricted).
    if not _is_platform_admin(current_user) and current_user.organization_id:
        allowed_locs = set(
            (await db.execute(
                select(Location.id).where(
                    Location.organization_id == current_user.organization_id
                )
            )).scalars().all()
        )
    else:
        allowed_locs = None  # platform admin / SA: no restriction

    valid_loc_roles = {"location_manager", "location_operator", "location_viewer"}
    for item in payload:
        loc_id = item.get("location_id")
        loc_role = item.get("loc_role", "location_viewer")
        if not loc_id:
            continue
        if loc_role not in valid_loc_roles:
            continue
        if allowed_locs is not None and loc_id not in allowed_locs:
            continue  # silently skip locations from other tenants
        ul = UserLocation(
            user_id=user_id,
            location_id=loc_id,
            loc_role=loc_role,
            assigned_by=current_user.id,
        )
        db.add(ul)

    await db.commit()
    await log_action(db, current_user, "user_locations_updated", "user", user_id, user.username, request=request)
    return {"success": True, "count": len(payload)}
