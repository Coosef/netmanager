"""SystemSettingsService — org bazlı k/v ayar okuma/yazma.

T9 Tur 1 #1 (1A). Çözünürlük sırası:
  1. organization_id = X kaydı varsa onu döndür
  2. organization_id IS NULL (global default) kaydı varsa onu
  3. Kod-içi _DEFAULTS fallback

Cache: process-local 30 saniyelik TTL. Ayar UI'dan değiştiğinde
endpoint çağrı `invalidate_cache()` yapar — taze değer hemen okunur.
"""
from __future__ import annotations

import time
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.system_setting import SystemSetting


# Kodda mevcut beat schedule frekanslarıyla uyumlu varsayılanlar.
# DB seed (migration) bunlarla aynı değerleri global default olarak yazar.
# Bir org kayıt eklemediği + global silinmediği sürece bu değerler kullanılır.
_DEFAULTS: dict[str, Any] = {
    # Tarama frekansları (saniye)
    "scan.poll_device_status_sec":     300,
    "scan.poll_snmp_sec":              300,
    "scan.mac_arp_sec":                900,
    "scan.update_baselines_sec":       86400,
    "scan.detect_anomalies_sec":       1800,
    "scan.topology_discovery_sec":     21600,
    "scan.synthetic_probe_sec":        60,
    # Maintenance window aktifken polling factor (1B'de etkin)
    "scan.relaxed_factor_in_maintenance": 0.5,
}

# Per-key guardrail'ler — UI uyarı verir, backend de kabul etmez.
# (min, max) saniye cinsinden. None ise sınırsız.
_GUARDRAILS: dict[str, tuple[Optional[int], Optional[int]]] = {
    "scan.poll_device_status_sec":     (60, 3600),     # 1dk - 1 saat
    "scan.poll_snmp_sec":              (60, 3600),     # 1dk - 1 saat (cihaz CPU yükselir)
    "scan.mac_arp_sec":                (300, 7200),    # 5dk - 2 saat
    "scan.update_baselines_sec":       (3600, 604800), # 1 saat - 1 hafta
    "scan.detect_anomalies_sec":       (600, 21600),   # 10dk - 6 saat
    "scan.topology_discovery_sec":     (3600, 86400),  # 1 saat - 1 gün
    "scan.synthetic_probe_sec":        (30, 600),      # 30s - 10dk
    "scan.relaxed_factor_in_maintenance": (None, None),  # 0.0 - 1.0 (UI'da sayısal)
}


def defaults() -> dict[str, Any]:
    """Tüm kod-içi varsayılanları döndürür. UI bunları "all keys" listesi
    olarak kullanabilir (bilinmeyen key girilmesin)."""
    return dict(_DEFAULTS)


def guardrail(key: str) -> tuple[Optional[int], Optional[int]]:
    """Bir key için (min, max) sınırını döndürür. Tanımlı değilse (None, None)."""
    return _GUARDRAILS.get(key, (None, None))


def validate(key: str, value: Any) -> tuple[bool, str]:
    """Bir key/value çiftini guardrail'e karşı doğrula.
    Returns: (ok, hata mesajı veya '')"""
    if key not in _DEFAULTS:
        return False, f"Bilinmeyen ayar key'i: {key}"
    lo, hi = _GUARDRAILS.get(key, (None, None))
    if isinstance(value, (int, float)):
        if lo is not None and value < lo:
            return False, f"{key} en az {lo} olabilir, gönderilen: {value}"
        if hi is not None and value > hi:
            return False, f"{key} en fazla {hi} olabilir, gönderilen: {value}"
    return True, ""


# ── Cache (process-local) ───────────────────────────────────────────────────
# Key = (organization_id|None, key); Value = (value, expires_at)
_cache: dict[tuple[Optional[int], str], tuple[Any, float]] = {}
_CACHE_TTL_SEC = 30.0


def invalidate_cache(organization_id: Optional[int] = None, key: Optional[str] = None) -> None:
    """Bir org / key / her şey için cache temizle. UI 'kaydet'e basınca
    endpoint bunu çağırır → bir sonraki get() taze değer döndürür."""
    if organization_id is None and key is None:
        _cache.clear()
        return
    keys_to_drop = [
        ck for ck in _cache
        if (organization_id is None or ck[0] == organization_id)
        and (key is None or ck[1] == key)
    ]
    for ck in keys_to_drop:
        _cache.pop(ck, None)


async def get(
    db: AsyncSession, key: str, organization_id: Optional[int] = None,
) -> Any:
    """Bir key için değeri döndürür (org-specific → global → default)."""
    now = time.time()
    cache_key = (organization_id, key)
    cached = _cache.get(cache_key)
    if cached and cached[1] > now:
        return cached[0]

    value: Any = None

    if organization_id is not None:
        row = (await db.execute(
            select(SystemSetting).where(
                SystemSetting.organization_id == organization_id,
                SystemSetting.key == key,
            )
        )).scalar_one_or_none()
        if row is not None:
            value = row.value

    if value is None:
        row = (await db.execute(
            select(SystemSetting).where(
                SystemSetting.organization_id.is_(None),
                SystemSetting.key == key,
            )
        )).scalar_one_or_none()
        if row is not None:
            value = row.value

    if value is None:
        value = _DEFAULTS.get(key)

    _cache[cache_key] = (value, now + _CACHE_TTL_SEC)
    return value


async def get_all(
    db: AsyncSession, organization_id: Optional[int] = None,
) -> dict[str, Any]:
    """Tüm scan.* ayarlarını topluca döndürür (UI'da tek read).
    Her key için scope resolution uygulanır."""
    result: dict[str, Any] = {}
    for key in _DEFAULTS:
        result[key] = await get(db, key, organization_id)
    return result


async def upsert(
    db: AsyncSession, key: str, value: Any, organization_id: int,
    user_id: Optional[int] = None,
) -> SystemSetting:
    """Bir ayar değerini upsert et (org bazlı). organization_id=None ile
    global default güncelleme yalnız super-admin tarafından yapılır;
    endpoint katmanı bunu enforce eder.

    NOT: Bu çağrı `db.commit()` YAPMAZ — endpoint commit eder.
    Cache invalidation çağıran tarafa bırakılır.
    """
    from datetime import datetime, timezone

    ok, msg = validate(key, value)
    if not ok:
        raise ValueError(msg)

    existing = (await db.execute(
        select(SystemSetting).where(
            SystemSetting.organization_id == organization_id,
            SystemSetting.key == key,
        )
    )).scalar_one_or_none()

    if existing is not None:
        existing.value = value
        existing.updated_at = datetime.now(timezone.utc)
        existing.updated_by_user_id = user_id
        return existing

    row = SystemSetting(
        organization_id=organization_id,
        key=key, value=value,
        updated_at=datetime.now(timezone.utc),
        updated_by_user_id=user_id,
    )
    db.add(row)
    return row
