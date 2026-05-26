"""System Settings endpoint — org bazlı tarama frekansı vb. yönetimi.

T9 Tur 1 #1 (1A).

Endpoint'ler:
  GET    /api/v1/system-settings                    — tüm ayarları topluca
  PUT    /api/v1/system-settings/{key}              — bir ayarı upsert et
  DELETE /api/v1/system-settings/{key}              — org override'ı sil (global'a dön)
  GET    /api/v1/system-settings/_meta              — UI için key listesi + guardrail

Yetki:
  - Liste/oku: any authenticated user (kendi org'unun ayarlarını görür)
  - Yazma/silme: super_admin veya org_admin
"""
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.system_setting import SystemSetting
from app.services import system_settings_service as svc

router = APIRouter()


# ── Schema'lar ──────────────────────────────────────────────────────────────
class SettingValue(BaseModel):
    """Bir ayar değer + meta (UI için)."""
    key: str
    value: Any
    is_org_override: bool      # True → org-specific kayıt; False → global default
    description: Optional[str] = None
    updated_at: Optional[str] = None
    updated_by_user_id: Optional[int] = None


class SettingsBundle(BaseModel):
    """Tüm scan.* ayarlarını topluca taşıyan response."""
    organization_id: Optional[int]
    settings: list[SettingValue]


class SettingUpsertPayload(BaseModel):
    value: Any


class SettingMeta(BaseModel):
    key: str
    default: Any
    min_value: Optional[int] = None
    max_value: Optional[int] = None


# ── Endpoint'ler ────────────────────────────────────────────────────────────
@router.get("", response_model=SettingsBundle)
async def list_settings(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Mevcut kullanıcının org'una göre tüm scan.* ayarlarını döndürür.
    Override yapılmamış key'lerde global default veya kod default gelir."""
    org_id = current_user.organization_id

    rows: dict[tuple[Optional[int], str], SystemSetting] = {}
    keys = list(svc.defaults().keys())

    # Org-specific override'ları çek
    if org_id is not None:
        result = await db.execute(
            select(SystemSetting).where(
                SystemSetting.organization_id == org_id,
                SystemSetting.key.in_(keys),
            )
        )
        for row in result.scalars().all():
            rows[(org_id, row.key)] = row

    # Global default'ları çek
    result = await db.execute(
        select(SystemSetting).where(
            SystemSetting.organization_id.is_(None),
            SystemSetting.key.in_(keys),
        )
    )
    for row in result.scalars().all():
        rows.setdefault((None, row.key), row)

    items: list[SettingValue] = []
    for key in keys:
        org_row = rows.get((org_id, key)) if org_id is not None else None
        global_row = rows.get((None, key))
        active = org_row or global_row

        items.append(SettingValue(
            key=key,
            value=active.value if active else svc.defaults()[key],
            is_org_override=org_row is not None,
            description=(active.description if active else None),
            updated_at=(active.updated_at.isoformat() if active else None),
            updated_by_user_id=(active.updated_by_user_id if active else None),
        ))

    return SettingsBundle(organization_id=org_id, settings=items)


@router.get("/_meta")
async def settings_meta(current_user: CurrentUser = None):
    """UI form üretici için key listesi + guardrail bilgisi."""
    items: list[SettingMeta] = []
    for key, default_val in svc.defaults().items():
        lo, hi = svc.guardrail(key)
        items.append(SettingMeta(
            key=key, default=default_val,
            min_value=lo, max_value=hi,
        ))
    return {"items": items}


@router.put("/{key}")
async def upsert_setting(
    key: str,
    payload: SettingUpsertPayload,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Bir ayarı org bazında upsert et. Yetki: org_admin / super_admin."""
    if not (current_user.is_super_admin or current_user.is_org_admin):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Yetersiz yetki — sadece org_admin / super_admin",
        )

    if current_user.organization_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Kullanıcının organization_id'si yok",
        )

    try:
        row = await svc.upsert(
            db, key=key, value=payload.value,
            organization_id=current_user.organization_id,
            user_id=current_user.id,
        )
        await db.commit()
        svc.invalidate_cache(current_user.organization_id, key)
    except ValueError as e:
        await db.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Yazma hatası: {e}")

    return {
        "key": row.key, "value": row.value,
        "organization_id": row.organization_id,
        "updated_at": row.updated_at.isoformat(),
        # 1A — beat schedule dinamik değil; restart gerek
        "applied_immediately": False,
        "note": "Ayar kaydedildi. Tarama frekanslarının etkili olması için "
                "Celery worker'ların yeniden başlatılması gerekir.",
    }


@router.delete("/{key}")
async def delete_org_override(
    key: str,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Org override'ını sil — global default'a dön."""
    if not (current_user.is_super_admin or current_user.is_org_admin):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="Yetersiz yetki")
    if current_user.organization_id is None:
        raise HTTPException(status_code=400,
                            detail="Kullanıcının organization_id'si yok")

    row = (await db.execute(
        select(SystemSetting).where(
            SystemSetting.organization_id == current_user.organization_id,
            SystemSetting.key == key,
        )
    )).scalar_one_or_none()

    if row is None:
        return {"removed": False, "note": "Org-specific override yoktu."}

    await db.delete(row)
    await db.commit()
    svc.invalidate_cache(current_user.organization_id, key)
    return {"removed": True, "key": key}
