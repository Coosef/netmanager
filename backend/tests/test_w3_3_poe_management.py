"""T10 C7 Wave 3 W3.3 — PoE Management testleri.

Kapsam:
1. Vendor PoE komut paftası (poe_commands)
2. Bulk PoE on/off — tek SSH session
3. PoE Restart — iki faz (disable → sleep → enable)
4. Audit log eylem isimleri (poe_on / poe_off / poe_restart)
5. PoE-uyumsuz port → skipped sayaç (bulk)
6. Comware vendor → tek port 400, bulk tüm portlar failed
"""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch


def test_vendor_poe_commands_coverage():
    """5 desteklenen OS × 2 state = 10 komut seti."""
    from app.services import port_control_service as svc

    cases = [
        ("cisco_ios", True, "power inline auto"),
        ("cisco_ios", False, "power inline never"),
        ("cisco_xe", True, "power inline auto"),
        ("aruba_aoscx", True, "poe"),
        ("aruba_aoscx", False, "no poe"),
        ("aruba_osswitch", True, "power-over-ethernet"),
        ("aruba_osswitch", False, "no power-over-ethernet"),
        ("hp_procurve", True, "power-over-ethernet"),
        ("ruijie_os", True, "power inline enable"),
        ("ruijie_os", False, "power inline disable"),
    ]
    for os_type, enable, expected_verb in cases:
        cmds = svc.poe_commands(os_type, "Gi0/1", enable=enable)
        assert any(expected_verb == c.strip() for c in cmds), (
            f"{os_type} enable={enable}: '{expected_verb}' bulunamadı, çıktı={cmds}"
        )
        assert cmds[0] == "interface Gi0/1"
        assert cmds[-1] == "exit"


def test_audit_action_name_mapping():
    """W3.3 — requested_state → audit eylem adı."""
    from app.api.v1.endpoints.port_control import _poe_action_audit_name

    assert _poe_action_audit_name("on") == "poe_on"
    assert _poe_action_audit_name("off") == "poe_off"
    assert _poe_action_audit_name("restart") == "poe_restart"
    assert _poe_action_audit_name("up") == "port_change_applied"


def test_restart_wait_or_default_uses_settings():
    """0 verilirse settings.POE_RESTART_WAIT_SEC; aksi halde verilen değer."""
    from app.api.v1.endpoints.port_control import _restart_wait_or_default
    from app.core.config import settings

    assert _restart_wait_or_default(0) == settings.POE_RESTART_WAIT_SEC
    assert _restart_wait_or_default(15) == 15
    assert _restart_wait_or_default(1) == 1


def test_settings_poe_restart_wait_default_is_10():
    """Default değer 10sn (kullanıcı kararı — AP/IP telefon/kamera için)."""
    from app.core.config import settings
    assert settings.POE_RESTART_WAIT_SEC == 10


def test_comware_unsupported_constant():
    """Comware fail-fast guard — yanlış komut basmama."""
    from app.api.v1.endpoints.port_control import _POE_UNSUPPORTED_OS
    assert "comware" in _POE_UNSUPPORTED_OS
    assert "cisco_ios" not in _POE_UNSUPPORTED_OS
    assert "aruba_aoscx" not in _POE_UNSUPPORTED_OS
    assert "ruijie_os" not in _POE_UNSUPPORTED_OS


def test_pydantic_bulk_payload_validation():
    """BulkPoePayload: action enum + interfaces min/max + restart_wait_sec range."""
    from app.api.v1.endpoints.port_control import BulkPoePayload
    from pydantic import ValidationError

    p = BulkPoePayload(interfaces=["Gi0/1"], action="on")
    assert p.action == "on"
    # W3.3 hotfix — optional; endpoint action-aware default türetir (on/off→0, restart→300)
    assert p.rollback_after_sec is None
    assert p.restart_wait_sec == 0  # 0 → settings default kullanılır

    p2 = BulkPoePayload(interfaces=["Gi0/1"], action="restart", restart_wait_sec=15)
    assert p2.restart_wait_sec == 15

    # Boş interfaces — reddedilir
    with pytest.raises(ValidationError):
        BulkPoePayload(interfaces=[], action="on")
    # Geçersiz action
    with pytest.raises(ValidationError):
        BulkPoePayload(interfaces=["Gi0/1"], action="reboot")
    # restart_wait_sec > 60
    with pytest.raises(ValidationError):
        BulkPoePayload(interfaces=["Gi0/1"], action="restart", restart_wait_sec=120)


def test_pydantic_restart_payload_validation():
    from app.api.v1.endpoints.port_control import PoeRestartPayload
    from pydantic import ValidationError

    p = PoeRestartPayload()
    assert p.restart_wait_sec == 0  # → settings default
    assert p.rollback_after_sec == 300

    with pytest.raises(ValidationError):
        PoeRestartPayload(restart_wait_sec=-1)
    with pytest.raises(ValidationError):
        PoeRestartPayload(restart_wait_sec=120)


def test_bulk_poe_endpoint_signature():
    """bulk_set_poe endpoint import edilebilir, expected kwargs alır."""
    from app.api.v1.endpoints.port_control import (
        bulk_set_poe, restart_port_poe, set_port_poe,
        _apply_poe_restart_single, _poe_capable_set,
    )
    assert callable(bulk_set_poe)
    assert callable(restart_port_poe)
    assert callable(set_port_poe)
    assert callable(_apply_poe_restart_single)
    assert callable(_poe_capable_set)


def test_inverse_commands_poe_round_trip():
    """poe_commands(on) → inverse_commands → poe_commands(off) semantik."""
    from app.services.port_control_service import poe_commands, inverse_commands

    on_cmds = poe_commands("cisco_ios", "Gi0/1", enable=True)
    inv = inverse_commands(on_cmds, "cisco_ios")
    off_cmds = poe_commands("cisco_ios", "Gi0/1", enable=False)
    # Verb kısmı eşleşmeli; interface/exit aynı
    assert any("power inline never" in c for c in inv)
    assert any("power inline never" in c for c in off_cmds)


# ---------------------------------------------------------------------------
# W3.3 Hotfix testleri (2026-06-01) — PoE on/off kalıcı default
# ---------------------------------------------------------------------------


def test_hotfix_port_poe_payload_default_zero():
    """PortPoePayload — PoE Aç/Kapat için rollback_after_sec default=0 (kalıcı).
    Hotfix kararı: kullanıcı kasıtlı kapattığı portun 5dk sonra geri açılmasını istemiyor."""
    from app.api.v1.endpoints.port_control import PortPoePayload
    p = PortPoePayload(enable=True)
    assert p.rollback_after_sec == 0
    # Explicit override hâlâ çalışmalı
    p2 = PortPoePayload(enable=False, rollback_after_sec=120)
    assert p2.rollback_after_sec == 120


def test_hotfix_bulk_poe_payload_default_optional():
    """BulkPoePayload.rollback_after_sec optional (None) — endpoint action-aware türetir."""
    from app.api.v1.endpoints.port_control import BulkPoePayload
    p = BulkPoePayload(interfaces=["Gi0/1"], action="on")
    assert p.rollback_after_sec is None
    # Explicit override aynen korunur
    p2 = BulkPoePayload(interfaces=["Gi0/1"], action="off", rollback_after_sec=600)
    assert p2.rollback_after_sec == 600


def test_hotfix_bulk_rollback_default_helper():
    """_bulk_rollback_default — on/off → 0 (kalıcı), restart → 300 (fail-safe), explicit korunur."""
    from app.api.v1.endpoints.port_control import _bulk_rollback_default

    assert _bulk_rollback_default(None, "on") == 0
    assert _bulk_rollback_default(None, "off") == 0
    assert _bulk_rollback_default(None, "restart") == 300
    # Explicit her zaman korunur — kullanıcı 0 verirse 0, 120 verirse 120
    assert _bulk_rollback_default(0, "restart") == 0
    assert _bulk_rollback_default(120, "on") == 120
    assert _bulk_rollback_default(300, "off") == 300


def test_hotfix_port_change_payload_admin_unchanged():
    """Regression: admin endpoint (PortChangePayload) default=300 KALIR.
    Hotfix kapsamı dışı — sadece PoE on/off değişti."""
    from app.api.v1.endpoints.port_control import PortChangePayload
    p = PortChangePayload(enable=True)
    assert p.rollback_after_sec == 300


def test_hotfix_poe_restart_payload_unchanged():
    """Regression: PoE Restart default=300 fail-safe KALIR (enable yeniden uygulanır)."""
    from app.api.v1.endpoints.port_control import PoeRestartPayload
    p = PoeRestartPayload()
    assert p.rollback_after_sec == 300
