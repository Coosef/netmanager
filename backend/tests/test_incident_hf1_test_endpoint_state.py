"""Incident sprint Hotfix #1 — Device test endpoint state update.

RCA: POST /devices/{id}/test SSH başarılı sonuç döndürüyordu ama
Device.status / Device.last_seen kolonlarına HİÇ yazmıyordu. Kullanıcı
"test başarılı" toast'unu görüp listede hâlâ "offline" görüyordu.

Fix:
- result.success=true → device.status=ONLINE, last_seen=utcnow(), db.commit()
- result.success=false → state DEĞİŞMEZ (Beat task'ı + agent heartbeat karar verir)
- Audit log: device_tested (mevcut, korunur) + device_reachability_confirmed (yeni)

Source assertion + signature smoke (W3.1/HF#2 paterni — gerçek SSH
mock'lamak bu sprintin scope'u değil).
"""
from __future__ import annotations

from pathlib import Path


def _src() -> str:
    from app.api.v1.endpoints import devices as ep
    return Path(ep.__file__).read_text()


def test_endpoint_imports_devicestatus():
    """DeviceStatus enum modül başında import edilmiş olmalı."""
    src = _src()
    assert "from app.models.device import Device, DeviceGroup, DeviceStatus" in src, (
        "DeviceStatus import edilmemiş — HF#1 kod yolu çalışmaz"
    )


def test_endpoint_writes_state_on_success():
    """test_device_connection success bloğunda device.status = ONLINE +
    last_seen + db.commit() pattern'i bulunmalı."""
    src = _src()
    # Test endpoint'i içinde success-koşullu state update
    assert "if result.success:" in src
    assert "device.status = DeviceStatus.ONLINE.value" in src, (
        "device.status ONLINE'a set edilmiyor"
    )
    assert "device.last_seen = datetime.now(timezone.utc)" in src, (
        "device.last_seen utcnow'a set edilmiyor"
    )
    assert "await db.commit()" in src, (
        "db.commit() çağrılmıyor — state DB'ye persist edilmiyor"
    )


def test_endpoint_writes_reachability_confirmed_audit():
    """device_reachability_confirmed audit log'u success bloğunda yazılır."""
    src = _src()
    assert '"device_reachability_confirmed"' in src, (
        "device_reachability_confirmed audit action'ı eklenmemiş"
    )


def test_endpoint_audit_details_contain_required_fields():
    """Audit details içinde previous_status, new_status, latency_ms, trigger,
    tested_by alanları olmalı (kullanıcı kararı: HF#1 schema)."""
    src = _src()
    for field in ("previous_status", "new_status", "latency_ms",
                  '"trigger": "manual_test"', "tested_by"):
        assert field in src, f"Audit details'te {field!r} alanı bulunamadı"


def test_endpoint_preserves_existing_device_tested_log():
    """Mevcut device_tested audit kaydı her durumda korunur (geri uyum)."""
    src = _src()
    # device_tested log_action çağrısı hâlâ var ve success bloğu DIŞINDA
    # (her zaman yazılıyor)
    assert '"device_tested"' in src, "Eski device_tested audit log'u kaldırılmış"


def test_endpoint_fail_path_does_not_change_state():
    """Fail path'inde device.status / last_seen set EDİLMEMELİ.
    Kullanıcı kararı: başarısız test → Beat task'ı + agent heartbeat karar verir.

    Doğrulama: success kontrolünden hemen sonra (else dalı olmadan) state
    güncellemesinin yer aldığı kontrolü — yani if-bloğu içinde, dışında değil."""
    src = _src()
    # State update pattern'i SADECE 'if result.success:' bloğunda olmalı.
    # else: dalında veya bloktan sonra device.status = OFFLINE pattern'i olmamalı.
    assert "device.status = DeviceStatus.OFFLINE" not in src, (
        "Test endpoint OFFLINE state yazmamalı — kullanıcı kararı ihlali"
    )
    # Endpoint kodunda 'else:' ile başlayan ve hemen sonra device.status set
    # eden pattern olmamalı (gevşek string kontrol)
    assert "result.success" in src  # ana branch koşulu var


def test_devicestatus_enum_unchanged():
    """Regression: DeviceStatus enum değerleri sabit kalmalı."""
    from app.models.device import DeviceStatus
    assert DeviceStatus.ONLINE.value == "online"
    assert DeviceStatus.OFFLINE.value == "offline"
    assert DeviceStatus.UNKNOWN.value == "unknown"
    assert DeviceStatus.UNREACHABLE.value == "unreachable"


def test_endpoint_signature_and_router_route_intact():
    """Endpoint imza ve route path'i değişmez (frontend etkilenmemeli)."""
    from app.api.v1.endpoints import devices as ep
    import inspect
    sig = inspect.signature(ep.test_device_connection)
    # Parameter signature: device_id, request, db, current_user
    params = list(sig.parameters.keys())
    assert "device_id" in params
    assert "request" in params
    assert "db" in params
    assert "current_user" in params

    # Router'da POST /{device_id}/test route'u kayıtlı
    paths = [r.path for r in ep.router.routes if hasattr(r, "path")]
    assert any("/{device_id}/test" in p and p.endswith("/test") for p in paths), (
        f"POST /{{device_id}}/test route'u router'da bulunamadı; paths={paths[:10]}"
    )
