"""Pentest Finding 1 (HIGH) — must_change_password enforcement.

`get_current_active_user` artık `must_change_password=True` olan kullanıcılar
için whitelist dışı tüm endpoint'leri 403 + sabit `code:
PASSWORD_CHANGE_REQUIRED` ile reddediyor.

Bu test dosyası:
  1. Whitelist içeriğini sabitler (regresyon koruması)
  2. `get_current_active_user`'ı doğrudan çağırıp logic'i unit-test eder
     (DB / token decode / Redis gerekmez — pure function)
  3. Whitelist içi 4 endpoint için flag=True'da geçirir
  4. Whitelist dışı endpoint'ler için flag=True'da 403 atar
  5. Flag=False olunca her yerde normal akış çalışır
  6. Inactive user kontrolü flag kontrolünden ÖNCE çalışır (mevcut davranış)
  7. 403 response body deterministik: {code, message}
"""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Request

from app.core.deps import (
    PASSWORD_CHANGE_ALLOWED_PATHS,
    get_current_active_user,
)


# ── Helpers ─────────────────────────────────────────────────────────────────


def _mk_request(path: str) -> Request:
    """Minimal ASGI Request — sadece `url.path`'e ihtiyacımız var."""
    scope = {
        "type": "http",
        "method": "GET",
        "path": path,
        "raw_path": path.encode(),
        "headers": [],
        "query_string": b"",
        "scheme": "https",
        "server": ("netmanager.local", 443),
        "root_path": "",
    }
    return Request(scope)


def _mk_user(*, must_change: bool, is_active: bool = True) -> SimpleNamespace:
    """Minimal user mock — `get_current_active_user`'ın okuduğu alanlar."""
    return SimpleNamespace(
        id=42,
        username="alice",
        is_active=is_active,
        must_change_password=must_change,
    )


# ── Whitelist içeriği sabit kalmalı (regresyon koruması) ─────────────────────


def test_whitelist_exactly_four_paths():
    """Whitelist genişletilirse bilinçli bir karar olmalı — saymaya kilitle."""
    assert len(PASSWORD_CHANGE_ALLOWED_PATHS) == 4


def test_whitelist_contains_required_paths():
    """Pentest report Recommendation: self-info + permissions + logout +
    password change endpoint'leri. Hiçbiri silinmemeli."""
    assert "/api/v1/auth/me" in PASSWORD_CHANGE_ALLOWED_PATHS
    assert "/api/v1/auth/me/permissions" in PASSWORD_CHANGE_ALLOWED_PATHS
    assert "/api/v1/auth/logout" in PASSWORD_CHANGE_ALLOWED_PATHS
    assert "/api/v1/users/me/change-password" in PASSWORD_CHANGE_ALLOWED_PATHS


def test_whitelist_does_not_contain_business_paths():
    """Pentest sample'da bulunan privileged endpoint'ler whitelist'te
    OLMAMALI — yoksa enforcement etkisiz olur."""
    for path in (
        "/api/v1/org-admin/users",
        "/api/v1/org-admin/org",
        "/api/v1/org-admin/permission-sets",
        "/api/v1/tasks/audit-log",
        "/api/v1/devices",
        "/api/v1/devices/1",
        "/api/v1/super-admin/orgs",
        "/api/v1/super-admin/system-stats",
        "/api/v1/agents",
        "/api/v1/terminal-sessions",
        "/api/v1/ipam",
    ):
        assert path not in PASSWORD_CHANGE_ALLOWED_PATHS, (
            f"REGRESYON: privileged endpoint whitelist'e sızmış: {path}"
        )


# ── must_change_password=True + whitelist içi → izinli ──────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/auth/me",
        "/api/v1/auth/me/permissions",
        "/api/v1/auth/logout",
        "/api/v1/users/me/change-password",
    ],
)
async def test_must_change_password_true_whitelisted_path_allowed(path):
    """Pentest Recommendation 1: kullanıcının self-info + password change +
    logout erişimi açık kalmalı."""
    user = _mk_user(must_change=True)
    request = _mk_request(path)
    result = await get_current_active_user(request=request, current_user=user)
    assert result is user


# ── must_change_password=True + whitelist dışı → 403 ────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/org-admin/users",
        "/api/v1/org-admin/org",
        "/api/v1/org-admin/permission-sets",
        "/api/v1/tasks/audit-log",
        "/api/v1/devices",
        "/api/v1/devices/1",
        "/api/v1/super-admin/orgs",
        "/api/v1/agents",
        "/api/v1/terminal-sessions",
        "/api/v1/ipam",
        "/api/v1/config-templates",
        "/api/v1/users/",         # listing endpoint — bypass DEĞIL
        "/api/v1/users/4",
        "/api/v1/dashboard",
        "/api/v1/reports",
    ],
)
async def test_must_change_password_true_business_path_blocked(path):
    """Pentest Finding 1 senaryosu — flag=True token whitelist dışı her
    endpoint için 403 + sabit code dönmeli."""
    user = _mk_user(must_change=True)
    request = _mk_request(path)
    with pytest.raises(HTTPException) as exc:
        await get_current_active_user(request=request, current_user=user)
    assert exc.value.status_code == 403
    assert isinstance(exc.value.detail, dict)
    assert exc.value.detail.get("code") == "PASSWORD_CHANGE_REQUIRED"
    assert exc.value.detail.get("message") == "Password change required"


# ── must_change_password=False → her yerde normal akış (regresyon) ──────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/auth/me",
        "/api/v1/org-admin/users",
        "/api/v1/tasks/audit-log",
        "/api/v1/devices",
        "/api/v1/super-admin/orgs",
    ],
)
async def test_must_change_password_false_all_paths_allowed(path):
    """Normal kullanıcı (flag False) — enforcement asla tetiklenmemeli."""
    user = _mk_user(must_change=False)
    request = _mk_request(path)
    result = await get_current_active_user(request=request, current_user=user)
    assert result is user


# ── Edge case: inactive user, flag false olsa bile, 400 dönmeli ─────────────


@pytest.mark.asyncio
async def test_inactive_user_rejected_before_must_change_check():
    """is_active=False kullanıcı — mevcut 400 davranışı korunmalı, flag
    kontrolü buna engel olmamalı."""
    user = _mk_user(must_change=False, is_active=False)
    request = _mk_request("/api/v1/auth/me")
    with pytest.raises(HTTPException) as exc:
        await get_current_active_user(request=request, current_user=user)
    assert exc.value.status_code == 400
    assert exc.value.detail == "Inactive user"


# ── Edge case: inactive + must_change=True → inactive kontrolü ÖNCE ─────────


@pytest.mark.asyncio
async def test_inactive_user_with_must_change_true_returns_400_not_403():
    """Hem inactive hem flag=True ise 400 (Inactive user) dönmeli — flag
    kontrolü inactive geçtikten sonra çalışır. Sebep: inactive bir hesap
    çoktan bypass edilmiş; UX olarak 'önce inactive' bilgisi doğru."""
    user = _mk_user(must_change=True, is_active=False)
    request = _mk_request("/api/v1/tasks/audit-log")
    with pytest.raises(HTTPException) as exc:
        await get_current_active_user(request=request, current_user=user)
    assert exc.value.status_code == 400


# ── Edge case: must_change_password attr eksikse defansif False ─────────────


@pytest.mark.asyncio
async def test_user_without_must_change_password_attr_treated_as_false():
    """SimpleNamespace must_change_password alanı OLMAYAN bir mock —
    `getattr(..., False)` defansif default. Eski user instance'ları için
    backward-compat (alan eklenmeden önce yaratılmış olabilir)."""
    user = SimpleNamespace(id=1, username="bob", is_active=True)  # no flag
    request = _mk_request("/api/v1/tasks/audit-log")
    result = await get_current_active_user(request=request, current_user=user)
    assert result is user


# ── Frontend hata kodu kontratı (deterministik response) ───────────────────


@pytest.mark.asyncio
async def test_403_response_body_contract_stable():
    """Frontend `code === "PASSWORD_CHANGE_REQUIRED"` ile bu hatayı yakalayıp
    kullanıcıyı password change ekranına yönlendirecek — kod ve mesaj
    string'leri bilerek değiştirilirse hem frontend hem dış API tüketicileri
    için kırılmadır."""
    user = _mk_user(must_change=True)
    request = _mk_request("/api/v1/devices")
    with pytest.raises(HTTPException) as exc:
        await get_current_active_user(request=request, current_user=user)
    assert exc.value.detail == {
        "code": "PASSWORD_CHANGE_REQUIRED",
        "message": "Password change required",
    }
