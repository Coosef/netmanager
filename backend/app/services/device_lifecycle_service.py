"""DeviceLifecycleService — state machine + audit (T9 Tur 4 #7+#14).

Cihaz lifecycle_status geçişleri için kurallar:

    production ⇄ passive ⇄ stock      (her yönde, org_admin yeterli)
    *          → archived              (her state'ten archive'a tek yönlü)
    archived   → production            (sadece super_admin geri açabilir)

is_active boolean'ı bu state'le senkronize tutulur:
    production/passive/stock → is_active=True
    archived                  → is_active=False (RLS pattern'i ile uyumlu)

Audit log:
    event 'device_lifecycle_changed' — before_state / after_state dict.
"""
from __future__ import annotations

from typing import Optional

from app.models.device import Device, DeviceLifecycleStatus
from app.models.user import SystemRole, User

# Geçiş kuralları — (kaynak, hedef) → izinli mi (rol kontrolü ayrı)
_ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    DeviceLifecycleStatus.PRODUCTION: {
        DeviceLifecycleStatus.PASSIVE,
        DeviceLifecycleStatus.STOCK,
        DeviceLifecycleStatus.ARCHIVED,
    },
    DeviceLifecycleStatus.PASSIVE: {
        DeviceLifecycleStatus.PRODUCTION,
        DeviceLifecycleStatus.STOCK,
        DeviceLifecycleStatus.ARCHIVED,
    },
    DeviceLifecycleStatus.STOCK: {
        DeviceLifecycleStatus.PRODUCTION,
        DeviceLifecycleStatus.PASSIVE,
        DeviceLifecycleStatus.ARCHIVED,
    },
    DeviceLifecycleStatus.ARCHIVED: {
        DeviceLifecycleStatus.PRODUCTION,  # Sadece super_admin (alt katmanda kontrol)
    },
}

# archived → * yalnızca super_admin (security önlemi)
_ARCHIVED_UNLOCK_ROLES = {SystemRole.SUPER_ADMIN}


def can_transition(
    *, from_state: str, to_state: str, actor: User,
) -> tuple[bool, Optional[str]]:
    """Geçişin izinli olup olmadığını kontrol et.
    Returns: (allowed, error_message_or_None)."""
    if from_state == to_state:
        return False, f"Cihaz zaten '{from_state}' durumunda"
    allowed = _ALLOWED_TRANSITIONS.get(from_state, set())
    if to_state not in allowed:
        return False, f"'{from_state}' → '{to_state}' geçişi izinli değil"
    # archived'dan çıkış sadece super_admin
    if from_state == DeviceLifecycleStatus.ARCHIVED:
        if actor.system_role not in _ARCHIVED_UNLOCK_ROLES:
            return False, (
                "Arşivden geri yükleme yetkisi yok — yalnız super_admin yapabilir"
            )
    # Geçerli enum mu?
    try:
        DeviceLifecycleStatus(to_state)
    except ValueError:
        return False, f"Bilinmeyen state: {to_state}"
    return True, None


def apply_transition(device: Device, new_state: str) -> dict:
    """state'i set et + is_active'i sync et. Returns: before/after dict
    (audit_logs.log_action() için before_state/after_state arg'larına uygun)."""
    before = {
        "lifecycle_status": device.lifecycle_status,
        "is_active": device.is_active,
    }
    device.lifecycle_status = new_state
    # is_active senkron — sadece production/passive/stock aktif sayılır
    device.is_active = (new_state != DeviceLifecycleStatus.ARCHIVED)
    after = {
        "lifecycle_status": device.lifecycle_status,
        "is_active": device.is_active,
    }
    return {"before": before, "after": after}


def state_label(state: str) -> str:
    """UI için Türkçe etiket (backend log mesajlarında)."""
    labels = {
        DeviceLifecycleStatus.PRODUCTION: "Üretim",
        DeviceLifecycleStatus.PASSIVE: "Pasif",
        DeviceLifecycleStatus.STOCK: "Stok",
        DeviceLifecycleStatus.ARCHIVED: "Arşiv",
    }
    return labels.get(state, state)
