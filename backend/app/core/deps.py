from typing import Annotated, Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.database import get_db
from app.core.org_context import set_org_context
from app.core.request_context import (
    LocationContext,
    is_super_admin as _is_super_admin,
    resolve_location_context,
)
from app.core.security import decode_access_token
from app.models.user import SystemRole, User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


# ---------------------------------------------------------------------------
# Core auth dependencies
# ---------------------------------------------------------------------------


def _parse_int_header(request: Request, name: str) -> Optional[int]:
    raw = request.headers.get(name)
    if not raw:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


async def get_current_user(
    request: Request,
    token: Annotated[str, Depends(oauth2_scheme)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    payload = decode_access_token(token)
    if payload is None:
        raise credentials_exception

    user_id: int = payload.get("sub")
    if user_id is None:
        raise credentials_exception

    # T8.4 — Session revoke kontrolü. JWT'de jti varsa user_sessions
    # tablosuna bak: kayıt yok → backward-compat (eski tokenlar tabloya
    # yazılmadı), kayıt VAR ve revoked_at IS NOT NULL → 401. Last_activity
    # rate-limited update (60s'ten eski ise yaz; her request'te yazma
    # yükünü engelle).
    jti = payload.get("jti")
    if jti:
        from app.models.user_session import UserSession
        from sqlalchemy import update as _update
        sess = (await db.execute(
            select(UserSession).where(UserSession.jti == jti)
        )).scalar_one_or_none()
        if sess is not None and sess.revoked_at is not None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Session revoked",
                headers={"WWW-Authenticate": "Bearer"},
            )
        if sess is not None:
            from datetime import datetime, timezone, timedelta
            now = datetime.now(timezone.utc)
            if (now - sess.last_activity) > timedelta(seconds=60):
                await db.execute(
                    _update(UserSession)
                    .where(UserSession.id == sess.id)
                    .values(last_activity=now)
                )
                await db.commit()

    result = await db.execute(select(User).where(User.id == int(user_id), User.is_active == True))
    user = result.scalar_one_or_none()
    if user is None:
        raise credentials_exception

    # Faz 8 Phase E — resolve the request's location scope from
    # user_locations (the source of truth). The X-Location-Id header is
    # validated against the user's accessible locations, never trusted as
    # given; a rejected/stale value fails closed. The resolved context is
    # stashed on request.state for the RequestContext dependency.
    ctx = await resolve_location_context(
        db, user,
        x_org_id=_parse_int_header(request, "X-Org-Id"),
        x_location_id=_parse_int_header(request, "X-Location-Id"),
        channel="http",
    )
    request.state.location_context = ctx

    # Publish the validated RLS context: the before_insert hook stamps new
    # rows from it; the rls.py session hook scopes every query to it.
    set_org_context(ctx.organization_id, ctx.active_location_id, ctx.is_super_admin)
    # Attribute org/location transitions to this user (tenant-audit hook).
    from app.core.org_context import set_current_user_id, set_current_username
    set_current_user_id(user.id)
    set_current_username(user.username)
    # The auth query above already opened this session's transaction, so
    # the after_begin hook fired before the org was known — re-apply now.
    from app.core.rls import apply_rls_context
    await apply_rls_context(db)

    # Faz 8 Phase H — organization lifecycle gate. A suspended org is
    # read-only; an archived org is fully closed. A platform super-admin
    # bypasses this entirely (they manage org lifecycle).
    if ctx.organization_id is not None and not _is_super_admin(user):
        from app.models.shared.organization import Organization
        from app.services.org_management import org_status_block
        org = await db.get(Organization, ctx.organization_id)
        blocked = org_status_block(org, request.method)
        if blocked:
            import logging
            logging.getLogger("netmanager.org_management").warning(
                "organization access blocked",
                extra={
                    "event": "org_access_blocked",
                    "organization_id": ctx.organization_id,
                    "user_id": user.id,
                    "method": request.method,
                    "org_status": getattr(org, "status", None),
                },
            )
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=blocked)
    return user


# ── Pentest Finding 1 (HIGH) — must_change_password enforcement ─────────────
#
# `must_change_password=True` olan kullanıcılar, başarılı login + MFA verify
# sonrası geçerli bir bearer token elde eder. Bu noktada pentest raporundaki
# bulguya göre token TÜM authenticated business API'lerine erişebiliyordu —
# ki bu, "password change ZORUNLU" politikasını fiili olarak baypaslıyor.
#
# Çözüm: `get_current_active_user` (tüm authenticated endpoint'lerin geçtiği
# merkezi nokta) içinde flag kontrolü. Whitelist sadece self-info,
# permissions, logout ve password-change endpoint'leri için izin verir;
# diğer her şey 403 + sabit `code: "PASSWORD_CHANGE_REQUIRED"` döner.
#
# Whitelist neden bu spesifik 4 endpoint:
#   /api/v1/auth/me              — kullanıcının kendi profilini (username,
#                                  must_change_password flag dahil) bilmesi
#                                  için. Frontend bu endpoint'le kullanıcının
#                                  password change ekranına yönlendirileceğini
#                                  anlar.
#   /api/v1/auth/me/permissions  — frontend menü/UI render etmek için (yalnız
#                                  kullanıcının kendi permission setini döner,
#                                  yan etkisi yok).
#   /api/v1/auth/logout          — kullanıcı password değiştirmek istemiyorsa
#                                  çıkış yapabilmeli (lockout senaryosu).
#   /api/v1/users/me/change-password  — gerçek password change endpoint'i;
#                                  başarılı çağrı sonrası flag false olur
#                                  ve normal akış başlar.
#
# MFA endpoint'leri whitelist'te DEĞIL: bu enforcement noktasına gelen
# token ZATEN MFA'yı tamamlamış (login flow login → mfa/verify → final token).
# MFA endpoint'leri yalnız geçici challenge token'la (mfa_pending=True) çağrı
# kabul eder; bu noktada flow geri tetiklenmez.
PASSWORD_CHANGE_ALLOWED_PATHS: frozenset[str] = frozenset({
    "/api/v1/auth/me",
    "/api/v1/auth/me/permissions",
    "/api/v1/auth/logout",
    "/api/v1/users/me/change-password",
})


async def get_current_active_user(
    request: Request,
    current_user: Annotated[User, Depends(get_current_user)],
) -> User:
    if not current_user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")

    # Pentest Finding 1 — must_change_password enforcement.
    # Whitelist dışı endpoint'ler için 403; password change tamamlanınca
    # `password_policy_service.register_password_change` flag'i False'a
    # çekiyor ve normal erişim açılıyor.
    if getattr(current_user, "must_change_password", False):
        path = request.url.path
        if path not in PASSWORD_CHANGE_ALLOWED_PATHS:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "PASSWORD_CHANGE_REQUIRED",
                    "message": "Password change required",
                },
            )

    return current_user


# M6 final drop — `require_roles(*roles: UserRole)` removed; every caller
# has been migrated to `require_system_role(...)` (Faz 7 / M6-B1–B4).
# Faz 9 #3 — `get_tenant_context` / `get_accessible_location_ids` /
# `get_accessible_location_names` removed alongside the
# `TenantFilter` / `LocationFilter` / `LocationNameFilter` type aliases.
# All three were no-op shims returning None — RLS supersedes them.


CurrentUser = Annotated[User, Depends(get_current_active_user)]


# ── Faz 7 — RLS-scoped DB session ─────────────────────────────────────────────

async def get_scoped_db(
    db: Annotated[AsyncSession, Depends(get_db)],
    _user: Annotated[User, Depends(get_current_active_user)],
) -> AsyncSession:
    """
    A DB session with the RLS org/location context guaranteed in place —
    get_current_user publishes it and the rls.py session hook pushes it
    into PostgreSQL GUCs, so every query is policy-scoped. Endpoints can
    depend on this instead of get_db; existing endpoints that already take
    `CurrentUser` are scoped automatically (the context is set the moment
    the user is resolved).
    """
    return db


ScopedDb = Annotated[AsyncSession, Depends(get_scoped_db)]


# ── Faz 8 Phase E — request location context ──────────────────────────────────

async def get_request_context(
    request: Request,
    _user: Annotated[User, Depends(get_current_active_user)],
) -> LocationContext:
    """The validated location scope of this request — user_locations is
    the source of truth (see app.core.request_context). get_current_user
    resolves it and stashes it on request.state; this exposes it to
    endpoints and to the RBAC / location-enforcement dependencies."""
    ctx = getattr(request.state, "location_context", None)
    if ctx is None:  # defensive — get_current_active_user always runs first
        raise HTTPException(status_code=401, detail="Unresolved request context")
    return ctx


RequestContext = Annotated[LocationContext, Depends(get_request_context)]


def require_location_access():
    """Dependency — fail closed when a location-scoped user has no usable
    location (HTTP 403). Use on endpoints that read/write location-scoped
    data so an un-located user is rejected explicitly, not served an empty
    list that looks like 'no data'."""
    async def _checker(ctx: RequestContext) -> LocationContext:
        if not ctx.has_location_access:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You have no accessible location. Contact an administrator.",
            )
        return ctx
    return _checker


LocationScoped = Annotated[LocationContext, Depends(require_location_access())]


# ---------------------------------------------------------------------------
# New RBAC dependencies
# ---------------------------------------------------------------------------

async def get_current_user_rbac(
    request: Request,
    token: Annotated[str, Depends(oauth2_scheme)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    """Like get_current_user but loads org_id into context for new RBAC system."""
    return await get_current_user(request, token, db)


def require_permission(module: str, action: str):
    """
    Dependency factory that checks module.action permission via PermissionEngine.
    Usage: Depends(require_permission("devices", "edit"))

    Faz 8 Phase E — the check is evaluated against the request's *active
    location* (request_context), so a location-scoped grant cannot
    accidentally pass under another location. A location-scoped user with
    no usable location is rejected before the permission lookup.
    """
    async def _checker(
        ctx: RequestContext,
        user: Annotated[User, Depends(get_current_active_user)],
        db: Annotated[AsyncSession, Depends(get_db)],
    ) -> User:
        from app.services.rbac.engine import permission_engine
        if not ctx.has_location_access:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You have no accessible location. Contact an administrator.",
            )
        active_loc = ctx.active_location_id if not ctx.is_org_wide else None
        allowed = await permission_engine.resolve(
            db, user, module, action, location_id=active_loc,
        )
        if not allowed:
            from app.core.security_log import log_security_event
            log_security_event("permission_denied", result="denied",
                               username=user.username, user_id=user.id,
                               reason=f"{module}.{action}")
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission denied: {module}.{action}",
            )
        return user
    return _checker


async def org_feature_states(db: AsyncSession, organization_id: Optional[int]) -> dict[str, bool]:
    """T10 Faz A1 — bir org'un plan'ından tüm feature durumlarını çöz.
    Plan yoksa hepsi açık (opt-out semantic)."""
    from app.core.features import all_feature_states
    from app.models.shared.organization import Organization
    from app.models.shared.plan import Plan

    if organization_id is None:
        return all_feature_states(None)
    org = await db.get(Organization, organization_id)
    if org is None or org.plan_id is None:
        return all_feature_states(None)
    plan = await db.get(Plan, org.plan_id)
    return all_feature_states(plan.features if plan else None)


def require_feature(feature: str):
    """T10 Faz A1 — org'un planı `feature` modülünü içermiyorsa 403.

    RBAC'tan bağımsız: kullanıcının verb yetkisi olsa bile org planında
    modül kapalıysa erişim reddedilir. Super-admin bypass (platform sahibi
    tüm modülleri görür). Plan yoksa / explicit kapatılmamışsa açık
    (opt-out — bkz. core/features.py)."""
    async def _checker(
        ctx: RequestContext,
        user: Annotated[User, Depends(get_current_active_user)],
        db: Annotated[AsyncSession, Depends(get_db)],
    ) -> User:
        if _is_super_admin(user):
            return user
        from app.core.features import feature_enabled, FEATURES
        from app.models.shared.organization import Organization
        from app.models.shared.plan import Plan

        org_id = ctx.organization_id
        plan_features = None
        if org_id is not None:
            org = await db.get(Organization, org_id)
            if org and org.plan_id is not None:
                plan = await db.get(Plan, org.plan_id)
                plan_features = plan.features if plan else None
        if not feature_enabled(plan_features, feature):
            label = FEATURES.get(feature, feature)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"'{label}' modülü planınızda bulunmuyor. Yöneticinizle iletişime geçin.",
            )
        return user
    return _checker


def require_system_role(*roles: SystemRole):
    """
    Require one of the given system roles — Faz 7 4-role model
    (super_admin / org_admin / location_admin / viewer).

    A 'member' value (the pre-Faz-7 default, before migration M4 ran) is
    treated as 'viewer'. (M6 final drop — the legacy `users.role` column
    is gone; there is no longer a UserRole fallback.)"""
    async def _checker(user: Annotated[User, Depends(get_current_active_user)]) -> User:
        sr = user.system_role
        if sr == SystemRole.MEMBER:          # pre-M4 value
            sr = SystemRole.VIEWER
        if sr in roles:
            return user
        from app.core.security_log import log_security_event
        log_security_event("permission_denied", result="denied",
                           username=getattr(user, "username", None),
                           user_id=getattr(user, "id", None),
                           reason=f"requires_system_role={[r.value if hasattr(r, 'value') else r for r in roles]}")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient system role",
        )
    return _checker


RbacUser = Annotated[User, Depends(get_current_active_user)]
SuperAdminOnly = Annotated[User, Depends(require_system_role(SystemRole.SUPER_ADMIN))]
OrgAdminOrAbove = Annotated[
    User,
    Depends(require_system_role(SystemRole.SUPER_ADMIN, SystemRole.ORG_ADMIN)),
]
LocationAdminOrAbove = Annotated[
    User,
    Depends(require_system_role(
        SystemRole.SUPER_ADMIN, SystemRole.ORG_ADMIN, SystemRole.LOCATION_ADMIN,
    )),
]
