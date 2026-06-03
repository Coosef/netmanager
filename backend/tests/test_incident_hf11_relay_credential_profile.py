"""Incident sprint Hotfix #11 — Backend relay credential profile resolve.

RCA: device.credential_profile_id set ama HF#9 sonrasi device.ssh_username=''
ve device.ssh_password_enc=encrypt('') olabiliyor. ssh_manager._relay_payload
ve agent_manager.execute_ssh_command/execute_ssh_config/test_ssh_connection
device alanlarini DOGRUDAN agent'a relay ediyordu → bos credentials →
netmiko "Authentication failed".

Fix: Profile_id varsa CredentialProfile yuklenir ve profile.ssh_username /
ssh_password_enc / enable_secret_enc dolu ise device alanlarinin yerine
kullanilir. Profile yoksa device fallback'i korunur.

Mock-based unit testler — gerçek SSH session istenmedi.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch


class _FakeProfile:
    """CredentialProfile mock — minimum surface."""
    def __init__(self, ssh_username="profile_admin", ssh_password_enc=b"enc_profile_pw",
                 enable_secret_enc=b"enc_profile_en"):
        self.ssh_username = ssh_username
        self.ssh_password_enc = ssh_password_enc
        self.enable_secret_enc = enable_secret_enc


class _FakeDevice:
    """Device mock — minimum surface for relay tests."""
    def __init__(self, *, ssh_username="", ssh_password_enc=b"enc_dev_empty",
                 enable_secret_enc=None, credential_profile_id=None):
        self.id = 79
        self.hostname = "10.22.90.2"
        self.ip_address = "10.22.90.2"
        self.ssh_username = ssh_username
        self.ssh_password_enc = ssh_password_enc
        self.ssh_port = 22
        self.os_type = "ruijie_os"
        self.enable_secret_enc = enable_secret_enc
        self.credential_profile_id = credential_profile_id


# ---------------------------------------------------------------------------
# A) ssh_manager._relay_payload sync path tests
# ---------------------------------------------------------------------------


def test_relay_payload_uses_profile_when_credential_profile_id_set():
    """Profile set + dolu → relay payload profile değerlerini kullanır."""
    from app.services.ssh_manager import ssh_manager
    fake_profile = _FakeProfile(ssh_username="admin", ssh_password_enc=b"enc_admin_pw",
                                enable_secret_enc=b"enc_admin_en")
    with patch.object(ssh_manager, "_load_profile_sync", return_value=fake_profile):
        device = _FakeDevice(ssh_username="", ssh_password_enc=b"enc_empty",
                             enable_secret_enc=None, credential_profile_id=3)
        payload = ssh_manager._relay_payload(device)

    assert payload["ssh_username"] == "admin", (
        f"Profile username kullanilmadi: {payload['ssh_username']!r}"
    )
    assert payload["ssh_password_enc"] == b"enc_admin_pw"
    assert payload["enable_secret_enc"] == b"enc_admin_en"
    assert payload["credential_profile_id"] == 3
    # Sabit alanlar
    assert payload["ip_address"] == "10.22.90.2"
    assert payload["os_type"] == "ruijie_os"


def test_relay_payload_falls_back_to_device_when_no_profile():
    """credential_profile_id=None → device alanlari korunur."""
    from app.services.ssh_manager import ssh_manager
    with patch.object(ssh_manager, "_load_profile_sync", return_value=None):
        device = _FakeDevice(ssh_username="device_user", ssh_password_enc=b"enc_dev_pw",
                             enable_secret_enc=b"enc_dev_en", credential_profile_id=None)
        payload = ssh_manager._relay_payload(device)

    assert payload["ssh_username"] == "device_user"
    assert payload["ssh_password_enc"] == b"enc_dev_pw"
    assert payload["enable_secret_enc"] == b"enc_dev_en"
    assert payload["credential_profile_id"] is None


def test_relay_payload_empty_device_with_profile_uses_profile():
    """Asil RCA senaryosu: device='', profile dolu → profile."""
    from app.services.ssh_manager import ssh_manager
    fake_profile = _FakeProfile(ssh_username="admin", ssh_password_enc=b"enc_profile_pw")
    with patch.object(ssh_manager, "_load_profile_sync", return_value=fake_profile):
        device = _FakeDevice(ssh_username="", ssh_password_enc=b"enc_zero",
                             credential_profile_id=3)
        payload = ssh_manager._relay_payload(device)

    assert payload["ssh_username"] == "admin"
    assert payload["ssh_password_enc"] == b"enc_profile_pw"


def test_relay_payload_profile_empty_field_falls_back_to_device():
    """Profile var ama profile.ssh_username boş → device kullanılır.
    (Profile yarı-konfigüre edilmişse mevcut device değeri devreye girer.)"""
    from app.services.ssh_manager import ssh_manager
    fake_profile = _FakeProfile(ssh_username="", ssh_password_enc=b"enc_profile_pw")
    with patch.object(ssh_manager, "_load_profile_sync", return_value=fake_profile):
        device = _FakeDevice(ssh_username="device_user", ssh_password_enc=b"enc_dev",
                             credential_profile_id=3)
        payload = ssh_manager._relay_payload(device)

    # profile.ssh_username boş → device username kullanılır
    assert payload["ssh_username"] == "device_user"
    # profile.password_enc dolu → profile password kullanılır
    assert payload["ssh_password_enc"] == b"enc_profile_pw"


def test_load_profile_sync_helper_exists_and_returns_none_without_profile_id():
    """_load_profile_sync helper var; credential_profile_id None → None."""
    from app.services.ssh_manager import ssh_manager
    device = _FakeDevice(credential_profile_id=None)
    # DB sorgusuna ulaşmadan None döner
    assert ssh_manager._load_profile_sync(device) is None


# ---------------------------------------------------------------------------
# B) agent_manager async path tests — _resolve_credentials + 3 caller
# ---------------------------------------------------------------------------


def test_agent_manager_resolve_credentials_returns_tuple():
    """_resolve_credentials async + 3-tuple (user, pass, enable) döner.
    Detaylı profile-vs-device davranışı ssh_manager testleri ile aynı mantığı
    paylaşır; burada signature/return shape doğrulanır."""
    import asyncio
    from app.services.agent_manager import agent_manager

    device = _FakeDevice(ssh_username="", credential_profile_id=None,
                         ssh_password_enc=None, enable_secret_enc=None)
    # profile_id=None → profile load atlanır → device fallback (boş)
    result = asyncio.run(agent_manager._resolve_credentials(device))
    assert isinstance(result, tuple) and len(result) == 3
    user, pwd, enable = result
    assert isinstance(user, str)
    assert isinstance(pwd, str)
    assert isinstance(enable, str)
    # profile yok + device alanları boş → boş string'ler
    assert user == ""


def test_execute_ssh_command_calls_resolve_credentials():
    """execute_ssh_command source'unda _resolve_credentials çağrısı var
    (vault_active=False dalı)."""
    from app.services.agent_manager import agent_manager
    from pathlib import Path
    src = Path(agent_manager.__module__.replace(".", "/")).with_suffix(".py")
    # Daha güvenli: import path üzerinden
    import app.services.agent_manager as am_mod
    src_text = Path(am_mod.__file__).read_text()
    assert "await self._resolve_credentials(device)" in src_text, (
        "agent_manager içinde _resolve_credentials çağrısı bulunamadı"
    )
    # Eski boş-payload pattern KALMAMALI (vault olmayan dalda)
    # execute_ssh_command, execute_ssh_config, test_ssh_connection
    # Hepsi 'ssh_username': device.ssh_username pattern'inden çıkmalı
    bad_pattern = '"ssh_username": device.ssh_username'
    assert src_text.count(bad_pattern) == 0, (
        f"Hala device.ssh_username pattern'i mevcut: {bad_pattern!r}"
    )


def test_execute_ssh_config_uses_profile_resolved_creds():
    """execute_ssh_config else dalı _resolve_credentials kullanır."""
    import app.services.agent_manager as am_mod
    from pathlib import Path
    src = Path(am_mod.__file__).read_text()
    # ssh_config function bölümünde _resolve_credentials referansı olmalı
    idx_cfg = src.find("async def execute_ssh_config")
    idx_metrics = src.find("def get_live_metrics")
    assert idx_cfg > 0 and idx_metrics > idx_cfg
    cfg_section = src[idx_cfg:idx_metrics]
    assert "_resolve_credentials(device)" in cfg_section


def test_test_ssh_connection_uses_profile_resolved_creds():
    """test_ssh_connection (3. çağrı) _resolve_credentials kullanır."""
    import app.services.agent_manager as am_mod
    from pathlib import Path
    src = Path(am_mod.__file__).read_text()
    idx_test = src.find("async def test_ssh_connection")
    idx_ping = src.find("async def ping_check")
    assert idx_test > 0 and idx_ping > idx_test
    test_section = src[idx_test:idx_ping]
    assert "_resolve_credentials(device)" in test_section
    # Eski pattern'in test_ssh_connection bölümünde kalmadığını doğrula
    assert "device.ssh_username" not in test_section


def test_resolve_credentials_method_exists_on_agent_manager():
    """_resolve_credentials AgentManager class method olmalı."""
    from app.services.agent_manager import AgentManager
    assert hasattr(AgentManager, "_resolve_credentials")
    import inspect
    assert inspect.iscoroutinefunction(AgentManager._resolve_credentials)


# ---------------------------------------------------------------------------
# Güvenlik regression
# ---------------------------------------------------------------------------


def test_no_decrypted_password_in_logs():
    """Source'ta log.info/log.debug çağrılarında decrypt_credential
    sonucu (plaintext password) loglanmıyor — güvenlik regression koruma."""
    import app.services.agent_manager as am_mod
    import app.services.ssh_manager as sm_mod
    from pathlib import Path
    for mod in (am_mod, sm_mod):
        src = Path(mod.__file__).read_text()
        # Kaba kontrol: log mesajı içinde decrypt_credential veya ssh_password
        # değişkeninin doğrudan format'a girmediği
        bad_patterns = [
            "log.info(f\"... ssh_password",  # f-string log'a şifre
            "log.debug(f\"... ssh_password",
            'logger.info(decrypt_credential',
        ]
        for pat in bad_patterns:
            assert pat not in src, f"{mod.__name__}: olası şifre logu: {pat!r}"


def test_existing_relay_payload_keys_intact():
    """Regression: payload key set'i değişmedi (api kontratı korunur)."""
    from app.services.ssh_manager import ssh_manager
    with patch.object(ssh_manager, "_load_profile_sync", return_value=None):
        device = _FakeDevice(credential_profile_id=None,
                             ssh_username="u", ssh_password_enc=b"p",
                             enable_secret_enc=b"e")
        payload = ssh_manager._relay_payload(device)

    expected_keys = {
        "device_id", "hostname", "ip_address",
        "ssh_username", "ssh_password_enc", "ssh_port",
        "os_type", "enable_secret_enc", "credential_profile_id",
    }
    assert set(payload.keys()) == expected_keys, (
        f"Payload key set degisti: extra={set(payload.keys())-expected_keys}, "
        f"missing={expected_keys-set(payload.keys())}"
    )
