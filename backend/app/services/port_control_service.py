"""PortControlService — vendor-aware port admin status + PoE komut wrapper.

T9 Tur 4 #8+E2. Cihaz vendor/os_type'ına göre doğru config komutlarını üretir:

Port shutdown / no-shutdown:
  cisco_*           → interface <if> ; shutdown / no shutdown ; exit
  aruba_osswitch    → interface <if> disable / enable
  aruba_aoscx       → interface <if> ; shutdown / no shutdown ; exit
  ruijie_os         → interface <if> ; shutdown / no shutdown ; exit
  hp_procurve       → interface <if> disable / enable
  generic/linux     → desteklenmez (ValueError)

PoE enable / disable:
  cisco_*           → interface <if> ; power inline auto / power inline never
  aruba_osswitch    → interface <if> ; power-over-ethernet / no power-over-ethernet
  aruba_aoscx       → interface <if> ; poe / no poe
  ruijie_os         → interface <if> ; power inline enable / power inline disable
  hp_procurve       → interface <if> power-over-ethernet / no power-over-ethernet

Rollback config: ters komut listesi.
"""
from __future__ import annotations

from typing import Optional


def _supports(os_type: str) -> bool:
    return os_type in {
        "cisco_ios", "cisco_xe", "cisco_nxos", "cisco_sg300",
        "aruba_osswitch", "aruba_aoscx", "hp_procurve",
        "ruijie_os", "comware",
    }


def port_admin_commands(
    os_type: str, interface: str, *, enable: bool,
) -> list[str]:
    """Port admin status (up/down) için config komut listesi.
    enable=True → no shutdown, False → shutdown."""
    if not _supports(os_type):
        raise ValueError(f"Vendor desteklenmiyor: {os_type}")
    iface = interface.strip()
    if not iface:
        raise ValueError("Interface adı boş olamaz")

    if os_type in {"aruba_osswitch", "hp_procurve"}:
        # Aruba OSSwitch / ProCurve syntax
        verb = "enable" if enable else "disable"
        return [f"interface {iface}", verb, "exit"]

    if os_type == "aruba_aoscx":
        cmds = [f"interface {iface}"]
        cmds.append("no shutdown" if enable else "shutdown")
        cmds.append("exit")
        return cmds

    # Cisco-like (Cisco/Ruijie/Comware)
    cmds = [f"interface {iface}"]
    cmds.append("no shutdown" if enable else "shutdown")
    cmds.append("exit")
    return cmds


def poe_commands(
    os_type: str, interface: str, *, enable: bool,
) -> list[str]:
    """PoE enable/disable için config komut listesi."""
    if not _supports(os_type):
        raise ValueError(f"Vendor desteklenmiyor: {os_type}")
    iface = interface.strip()
    if not iface:
        raise ValueError("Interface adı boş olamaz")

    if os_type in {"aruba_osswitch", "hp_procurve"}:
        verb = "power-over-ethernet" if enable else "no power-over-ethernet"
        return [f"interface {iface}", verb, "exit"]

    if os_type == "aruba_aoscx":
        verb = "poe" if enable else "no poe"
        return [f"interface {iface}", verb, "exit"]

    if os_type == "ruijie_os":
        verb = "power inline enable" if enable else "power inline disable"
        return [f"interface {iface}", verb, "exit"]

    # Cisco-like default
    verb = "power inline auto" if enable else "power inline never"
    return [f"interface {iface}", verb, "exit"]


def inverse_commands(forward_cmds: list[str], os_type: str) -> list[str]:
    """Bir forward komut listesinin ters çevrilmiş hali — rollback için.
    Heuristic: 'no <verb>' satırını <verb>'e, ve tersine.
    Sadece bizim üretilen format için doğru çalışır."""
    out: list[str] = []
    for line in forward_cmds:
        stripped = line.strip()
        if not stripped:
            out.append(line); continue
        # Aruba OSSwitch enable/disable
        if stripped == "enable":
            out.append("disable")
        elif stripped == "disable":
            out.append("enable")
        elif stripped == "shutdown":
            out.append("no shutdown")
        elif stripped == "no shutdown":
            out.append("shutdown")
        elif stripped == "poe":
            out.append("no poe")
        elif stripped == "no poe":
            out.append("poe")
        elif stripped == "power-over-ethernet":
            out.append("no power-over-ethernet")
        elif stripped == "no power-over-ethernet":
            out.append("power-over-ethernet")
        elif stripped == "power inline auto":
            out.append("power inline never")
        elif stripped == "power inline never":
            out.append("power inline auto")
        elif stripped == "power inline enable":
            out.append("power inline disable")
        elif stripped == "power inline disable":
            out.append("power inline enable")
        else:
            out.append(line)  # interface X / exit gibi non-mutating
    return out


def write_config_commands(os_type: str) -> list[str]:
    """Config save komutları (vendor'a göre).
    Eğer kullanıcı 5dk içinde geri almazsa kalıcı yapmak için.
    UYARI: rollback timer aktifken save ETMEYİZ! Aksi halde rollback işe yaramaz.
    Bu fonksiyon başarılı tamamlama (commit) sırasında kullanılır.
    """
    if os_type in {"cisco_ios", "cisco_xe", "cisco_sg300"}:
        return ["end", "write memory"]
    if os_type == "cisco_nxos":
        return ["end", "copy running-config startup-config"]
    if os_type in {"aruba_osswitch", "hp_procurve"}:
        return ["exit", "write memory"]
    if os_type == "aruba_aoscx":
        return ["end", "write memory"]
    if os_type in {"ruijie_os", "comware"}:
        return ["end", "write memory"]
    return ["end"]
