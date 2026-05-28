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

    # T10 A2 — Alarm / event dedup pencereleri (saniye). Bir cihaz için aynı
    # tip event'in tekrar üretilme aralığını sınırlar (monitor_tasks).
    "dedup.offline_event_sec":         1800,   # offline event ≤ 2/saat
    "dedup.online_event_sec":          1800,   # online event ≤ 2/saat
    "dedup.flap_alert_sec":            3600,   # flapping uyarısı ≤ 1/saat
    "dedup.correlation_incident_sec":  3600,   # korelasyon incident ≤ 1/saat
    "dedup.agent_event_sec":           600,    # agent online/offline ≤ 1/10dk

    # T10 A2 — Flap tespit eşikleri (adet)
    "flap.device_threshold_per_hour":  10,     # saatte N durum değişimi → flapping
    "flap.incident_threshold":         8,      # pencerede N event → flapping say

    # T10 A2 — Korelasyon motoru zamanlama pencereleri (saniye)
    "correlation.group_wait_sec":      30,     # incident açmadan önce tampon
    "correlation.bounce_guard_sec":    60,     # RECOVERING'e geçmeden min açık süre
    "correlation.recovery_confirm_sec": 120,   # RECOVERING→CLOSED onay penceresi
    "correlation.upstream_settle_sec": 35,     # downstream bastırmadan upstream bekleme
    "correlation.flap_window_sec":     300,    # flap tespiti kayan pencere

    # T10 A2 — Bakım pencereleri
    "maintenance.spawn_horizon_days":  14,     # cyclic MW kaç gün önceden materialize

    # T10 A2 — Oturum / stale eşikleri (dakika)
    "session.terminal_stale_min":      30,     # stale terminal oturumu kapat
    "session.poe_snapshot_stale_min":  45,     # PoE snapshot stale işaretle
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

    # T10 A2 — dedup pencereleri
    "dedup.offline_event_sec":         (60, 86400),    # 1dk - 1 gün
    "dedup.online_event_sec":          (60, 86400),
    "dedup.flap_alert_sec":            (300, 86400),   # 5dk - 1 gün
    "dedup.correlation_incident_sec":  (300, 86400),
    "dedup.agent_event_sec":           (60, 86400),

    # T10 A2 — flap eşikleri
    "flap.device_threshold_per_hour":  (3, 100),
    "flap.incident_threshold":         (3, 100),

    # T10 A2 — korelasyon pencereleri
    "correlation.group_wait_sec":      (5, 600),
    "correlation.bounce_guard_sec":    (5, 600),
    "correlation.recovery_confirm_sec": (10, 1200),
    "correlation.upstream_settle_sec": (5, 600),
    "correlation.flap_window_sec":     (30, 3600),

    # T10 A2 — bakım
    "maintenance.spawn_horizon_days":  (1, 90),

    # T10 A2 — oturum / stale
    "session.terminal_stale_min":      (5, 1440),      # 5dk - 1 gün
    "session.poe_snapshot_stale_min":  (5, 1440),
}

# T10 A2 — UI kategori grupları (key prefix → insan-okur etiket). Settings
# sayfası sekmelerini bundan üretir; _meta her key'e category döndürür.
_CATEGORIES: dict[str, str] = {
    "scan":         "Tarama Frekansları",
    "dedup":        "Alarm / Dedup",
    "flap":         "Flap Tespiti",
    "correlation":  "Korelasyon Motoru",
    "maintenance":  "Bakım Pencereleri",
    "session":      "Oturum / Stale",
    "retention":    "Veri Saklama (Retention)",
}

# T10 A2 — yazma kapsamı. "global" = yalnız super-admin, organization_id=None
# satırına yazılır (fleet-wide worker'lar bunu okur — org override anlamsız).
# "org"    = org_admin kendi org'una override yazabilir. Tanımsız key "org".
# Operasyonel/altyapı tuning'i global; tarama + retention org-override'lı.
_SCOPE: dict[str, str] = {
    **{k: "org" for k in _DEFAULTS if k.startswith("scan.")},
    **{k: "global" for k in _DEFAULTS if k.split(".", 1)[0] in (
        "dedup", "flap", "correlation", "maintenance", "session",
    )},
}


def category(key: str) -> str:
    """Bir key'in UI kategorisi — prefix'ten türetilir."""
    prefix = key.split(".", 1)[0]
    return _CATEGORIES.get(prefix, prefix)


def scope(key: str) -> str:
    """Bir key'in yazma kapsamı: 'global' | 'org'. Varsayılan 'org'."""
    return _SCOPE.get(key, "org")


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
