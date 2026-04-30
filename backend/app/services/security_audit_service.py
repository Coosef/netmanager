"""Security audit check logic for network devices."""
import re
from dataclasses import dataclass, asdict
from typing import Optional


@dataclass
class AuditFinding:
    id: str
    name: str
    category: str
    status: str        # pass | fail | warning | na
    detail: str
    weight: int        # max points this check contributes
    earned: int        # points actually earned
    remediation: Optional[str] = None


def _score_and_grade(findings: list[AuditFinding]) -> tuple[int, str]:
    applicable = [f for f in findings if f.status != "na"]
    total_weight = sum(f.weight for f in applicable)
    total_earned = sum(f.earned for f in applicable)
    score = int(total_earned / total_weight * 100) if total_weight else 0
    if score >= 90:
        grade = "A"
    elif score >= 70:
        grade = "B"
    elif score >= 50:
        grade = "C"
    elif score >= 30:
        grade = "D"
    else:
        grade = "F"
    return score, grade


# ── Cisco IOS / NX-OS / SG300 / Ruijie RGOS ──────────────────────────────────

def _audit_cisco_ios(config: str) -> list[AuditFinding]:
    findings: list[AuditFinding] = []

    # 1. SSH v2
    has_ssh_v2 = bool(re.search(r"ip ssh version 2", config))
    findings.append(AuditFinding(
        id="ssh_v2", name="SSH Versiyon 2", category="Erişim Kontrolü",
        status="pass" if has_ssh_v2 else "fail",
        detail="SSH v2 aktif" if has_ssh_v2 else "SSH v2 yapılandırılmamış — eski sürüm zafiyetlere açık",
        weight=15, earned=15 if has_ssh_v2 else 0,
        remediation="ip ssh version 2",
    ))

    # 2. Telnet disabled on VTY
    vty_sections = re.findall(r"line vty.+?(?=\nline |\Z)", config, re.DOTALL)
    if vty_sections:
        telnet_disabled = all(
            re.search(r"transport input ssh", s) and not re.search(r"transport input.+telnet", s)
            for s in vty_sections
        )
        status_str = "pass" if telnet_disabled else "fail"
        detail_str = (
            "VTY hatlarında sadece SSH aktif"
            if telnet_disabled
            else "Telnet erişimi açık — açık metin kimlik bilgileri tehlikede"
        )
    else:
        telnet_disabled = False
        status_str = "warning"
        detail_str = "VTY hat yapılandırması bulunamadı"
    findings.append(AuditFinding(
        id="telnet_disabled", name="Telnet Devre Dışı (VTY)", category="Erişim Kontrolü",
        status=status_str, detail=detail_str,
        weight=15, earned=15 if telnet_disabled else 0,
        remediation="line vty 0 15\n transport input ssh",
    ))

    # 3. Enable secret
    has_enable_secret = bool(re.search(r"^enable secret", config, re.MULTILINE))
    has_enable_password = bool(re.search(r"^enable password", config, re.MULTILINE))
    findings.append(AuditFinding(
        id="enable_secret", name="Enable Secret", category="Kimlik Doğrulama",
        status="pass" if has_enable_secret else ("warning" if has_enable_password else "fail"),
        detail=(
            "Enable secret (MD5 hash) kullanılıyor"
            if has_enable_secret
            else ("Zayıf enable password kullanılıyor" if has_enable_password else "Enable secret tanımlanmamış")
        ),
        weight=10,
        earned=10 if has_enable_secret else (3 if has_enable_password else 0),
        remediation="enable secret <güçlü-şifre>",
    ))

    # 4. Service password-encryption
    has_pw_enc = bool(re.search(r"service password-encryption", config))
    findings.append(AuditFinding(
        id="password_encryption", name="Şifre Şifreleme (Type-7)", category="Kimlik Doğrulama",
        status="pass" if has_pw_enc else "fail",
        detail="Şifreler Type-7 ile korunuyor" if has_pw_enc else "Şifreler düz metin olarak saklanıyor",
        weight=10, earned=10 if has_pw_enc else 0,
        remediation="service password-encryption",
    ))

    # 5. SNMP community not public/private
    snmp_communities = re.findall(r"snmp-server community (\S+)", config)
    weak = [c for c in snmp_communities if c.lower() in ("public", "private", "community")]
    snmp_ok = not weak
    findings.append(AuditFinding(
        id="snmp_community", name="SNMP Community Güvenliği", category="Ağ Güvenliği",
        status="pass" if snmp_ok else "fail",
        detail=(
            "Güçlü SNMP community string kullanılıyor"
            if snmp_ok
            else f"Zayıf community string tespit edildi: {', '.join(weak)}"
        ),
        weight=10, earned=10 if snmp_ok else 0,
        remediation="no snmp-server community public\nno snmp-server community private",
    ))

    # 6. HTTP server disabled (HTTPS is ok)
    has_http = bool(re.search(r"^ip http server$", config, re.MULTILINE))
    findings.append(AuditFinding(
        id="no_http", name="HTTP Yönetimi Kapalı", category="Ağ Güvenliği",
        status="pass" if not has_http else "fail",
        detail="HTTP yönetim arayüzü devre dışı" if not has_http else "Şifresiz HTTP yönetim arayüzü aktif",
        weight=10, earned=10 if not has_http else 0,
        remediation="no ip http server",
    ))

    # 7. NTP configured
    has_ntp = bool(re.search(r"ntp server", config))
    findings.append(AuditFinding(
        id="ntp_configured", name="NTP Yapılandırması", category="İzleme & Loglama",
        status="pass" if has_ntp else "warning",
        detail="NTP sunucusu yapılandırılmış" if has_ntp else "NTP yapılandırılmamış — zaman senkronizasyonu yok",
        weight=10, earned=10 if has_ntp else 0,
        remediation="ntp server <ntp-server-ip>",
    ))

    # 8. Logging configured
    has_logging = bool(re.search(r"logging\s+(\d{1,3}\.){3}\d{1,3}", config))
    findings.append(AuditFinding(
        id="logging_configured", name="Merkezi Syslog", category="İzleme & Loglama",
        status="pass" if has_logging else "warning",
        detail="Syslog sunucusuna loglama aktif" if has_logging else "Merkezi loglama yapılandırılmamış",
        weight=10, earned=10 if has_logging else 0,
        remediation="logging host <syslog-server-ip>",
    ))

    # 9. Console timeout
    console_section = re.search(r"line con 0.*?(?=\nline |\Z)", config, re.DOTALL)
    has_console_timeout = False
    if console_section:
        m = re.search(r"exec-timeout (\d+)", console_section.group())
        if m and int(m.group(1)) > 0:
            has_console_timeout = True
    findings.append(AuditFinding(
        id="console_timeout", name="Konsol Oturum Zaman Aşımı", category="Erişim Kontrolü",
        status="pass" if has_console_timeout else "warning",
        detail="Konsol timeout yapılandırılmış" if has_console_timeout else "Konsol timeout yok — oturum süresiz açık kalabilir",
        weight=5, earned=5 if has_console_timeout else 0,
        remediation="line con 0\n exec-timeout 5 0",
    ))

    # 10. Banner configured
    has_banner = bool(re.search(r"banner (motd|login|exec)", config))
    findings.append(AuditFinding(
        id="banner_configured", name="Güvenlik Uyarı Banner", category="Erişim Kontrolü",
        status="pass" if has_banner else "warning",
        detail="Yetkisiz erişim uyarı mesajı mevcut" if has_banner else "Güvenlik banner eksik",
        weight=5, earned=5 if has_banner else 0,
        remediation='banner motd # Yetkisiz erisim yasaktir. #',
    ))

    return findings


# ── H3C Comware ───────────────────────────────────────────────────────────────

def _audit_h3c(config: str) -> list[AuditFinding]:
    findings: list[AuditFinding] = []

    has_ssh = bool(re.search(r"ssh server enable", config, re.IGNORECASE))
    findings.append(AuditFinding(
        id="ssh_enabled", name="SSH Aktif", category="Erişim Kontrolü",
        status="pass" if has_ssh else "fail",
        detail="SSH yönetimi aktif" if has_ssh else "SSH etkin değil",
        weight=20, earned=20 if has_ssh else 0,
        remediation="ssh server enable",
    ))

    has_telnet = bool(re.search(r"telnet server enable", config, re.IGNORECASE))
    findings.append(AuditFinding(
        id="telnet_disabled", name="Telnet Devre Dışı", category="Erişim Kontrolü",
        status="pass" if not has_telnet else "fail",
        detail="Telnet servisi kapalı" if not has_telnet else "Telnet servisi aktif",
        weight=20, earned=20 if not has_telnet else 0,
        remediation="undo telnet server enable",
    ))

    has_pw_complexity = bool(re.search(r"password-control complexity", config, re.IGNORECASE))
    findings.append(AuditFinding(
        id="password_complexity", name="Şifre Karmaşıklık Politikası", category="Kimlik Doğrulama",
        status="pass" if has_pw_complexity else "warning",
        detail="Şifre karmaşıklık politikası aktif" if has_pw_complexity else "Şifre karmaşıklık politikası tanımlanmamış",
        weight=20, earned=20 if has_pw_complexity else 0,
        remediation="password-control complexity enable",
    ))

    has_ntp = bool(re.search(r"ntp-service unicast-server", config, re.IGNORECASE))
    findings.append(AuditFinding(
        id="ntp_configured", name="NTP Yapılandırması", category="İzleme & Loglama",
        status="pass" if has_ntp else "warning",
        detail="NTP sunucusu yapılandırılmış" if has_ntp else "NTP yapılandırılmamış",
        weight=20, earned=20 if has_ntp else 0,
        remediation="ntp-service unicast-server <ntp-ip>",
    ))

    has_logging = bool(re.search(r"info-center loghost", config, re.IGNORECASE))
    findings.append(AuditFinding(
        id="logging_configured", name="Merkezi Syslog", category="İzleme & Loglama",
        status="pass" if has_logging else "warning",
        detail="Syslog sunucusuna loglama aktif" if has_logging else "Merkezi loglama yapılandırılmamış",
        weight=20, earned=20 if has_logging else 0,
        remediation="info-center loghost <syslog-ip>",
    ))

    return findings


# ── Aruba AOS-CX ─────────────────────────────────────────────────────────────

def _audit_aruba_cx(config: str) -> list[AuditFinding]:
    findings: list[AuditFinding] = []

    no_telnet = not bool(re.search(r"telnet-server", config, re.IGNORECASE))
    findings.append(AuditFinding(
        id="telnet_disabled", name="Telnet Devre Dışı", category="Erişim Kontrolü",
        status="pass" if no_telnet else "fail",
        detail="Telnet servisi kapalı" if no_telnet else "Telnet servisi aktif",
        weight=25, earned=25 if no_telnet else 0,
        remediation="no telnet-server",
    ))

    has_ntp = bool(re.search(r"ntp server", config, re.IGNORECASE))
    findings.append(AuditFinding(
        id="ntp_configured", name="NTP Yapılandırması", category="İzleme & Loglama",
        status="pass" if has_ntp else "warning",
        detail="NTP yapılandırılmış" if has_ntp else "NTP yapılandırılmamış",
        weight=25, earned=25 if has_ntp else 0,
        remediation="ntp server <ntp-ip>",
    ))

    has_logging = bool(re.search(r"logging (\d{1,3}\.){3}\d{1,3}", config))
    findings.append(AuditFinding(
        id="logging_configured", name="Merkezi Syslog", category="İzleme & Loglama",
        status="pass" if has_logging else "warning",
        detail="Syslog aktif" if has_logging else "Merkezi loglama yapılandırılmamış",
        weight=25, earned=25 if has_logging else 0,
        remediation="logging <syslog-ip>",
    ))

    has_banner = bool(re.search(r"banner", config, re.IGNORECASE))
    findings.append(AuditFinding(
        id="banner_configured", name="Güvenlik Banner", category="Erişim Kontrolü",
        status="pass" if has_banner else "warning",
        detail="Banner yapılandırılmış" if has_banner else "Güvenlik banner eksik",
        weight=25, earned=25 if has_banner else 0,
        remediation="banner motd <mesaj>",
    ))

    return findings


# ── Generic / unsupported ─────────────────────────────────────────────────────

def _audit_unsupported(os_type: str) -> list[AuditFinding]:
    return [AuditFinding(
        id="unsupported", name="Desteklenmeyen OS", category="Genel",
        status="na",
        detail=f"{os_type} için otomatik denetim henüz desteklenmiyor",
        weight=0, earned=0,
    )]


# ── Public API ────────────────────────────────────────────────────────────────

CISCO_LIKE = {"cisco_ios", "cisco_nxos", "cisco_sg300", "ruijie_os"}
H3C_LIKE   = {"h3c_comware"}
ARUBA_LIKE = {"aruba_osswitch", "aruba_aoscx", "hp_procurve"}


async def run_device_audit(device, ssh_manager) -> tuple[int, str, list[dict], Optional[str]]:
    """SSH into device, run config audit checks.

    Returns (score, grade, findings_as_dicts, error_or_none).
    """
    os_type = (device.os_type or "").lower()

    if os_type in CISCO_LIKE:
        cmd, audit_fn = "show running-config", _audit_cisco_ios
    elif os_type in H3C_LIKE:
        cmd, audit_fn = "display current-configuration", _audit_h3c
    elif os_type in ARUBA_LIKE:
        cmd, audit_fn = "show running-config", _audit_aruba_cx
    else:
        findings = _audit_unsupported(os_type)
        return 0, "F", [asdict(f) for f in findings], None

    try:
        result = await ssh_manager.execute_command(device, cmd)
        if not result.success or not result.output:
            return 0, "F", [], result.error or "Komut çalıştırılamadı"

        findings = audit_fn(result.output)
        score, grade = _score_and_grade(findings)
        return score, grade, [asdict(f) for f in findings], None
    except Exception as exc:
        return 0, "F", [], str(exc)
