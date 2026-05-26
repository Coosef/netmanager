"""ConfigBuilderService — vendor-aware CLI generator for common operations.

T9 Tur 5 #11 — Easy Config Builder.

Lets a user pick "VLAN ekle" / "Port etiketle" / "NTP sunucusu" from a
form-driven UI instead of typing raw CLI. The frontend sends the canonical
operation + params; this service returns the exact command list for the
device's OS, ready to be `send_config`'d (or previewed as dry-run).

Each operation declares:
  - input schema (the form fields)
  - a per-vendor command generator

Supported vendors (initial set):
  cisco_ios / cisco_xe / cisco_nxos / cisco_sg300
  aruba_osswitch / aruba_aoscx / hp_procurve
  ruijie_os / comware

Adding a new operation = one entry in OPERATIONS + per-vendor methods.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

# ─── Vendor families ────────────────────────────────────────────────────────

CISCO_LIKE = {"cisco_ios", "cisco_xe", "cisco_nxos", "cisco_sg300"}
ARUBA_OSSWITCH = {"aruba_osswitch", "hp_procurve"}
ARUBA_AOSCX = {"aruba_aoscx"}
RUIJIE = {"ruijie_os"}
COMWARE = {"comware"}

ALL_SUPPORTED = CISCO_LIKE | ARUBA_OSSWITCH | ARUBA_AOSCX | RUIJIE | COMWARE


def vendor_family(os_type: str) -> str:
    """Return a canonical family tag for routing the command generator."""
    if os_type in CISCO_LIKE:
        return "cisco"
    if os_type in ARUBA_OSSWITCH:
        return "arubaos"
    if os_type in ARUBA_AOSCX:
        return "aoscx"
    if os_type in RUIJIE:
        return "ruijie"
    if os_type in COMWARE:
        return "comware"
    raise ValueError(f"Desteklenmeyen os_type: {os_type}")


# ─── Operation metadata ────────────────────────────────────────────────────

@dataclass
class FieldSpec:
    """One form field — fed to the FE to render the input."""
    name: str
    label: str
    type: str  # 'string' | 'int' | 'vlan_id' | 'interface' | 'enum' | 'cidr' | 'ipv4'
    required: bool = True
    default: Any = None
    placeholder: str | None = None
    help: str | None = None
    options: list[dict] | None = None  # for type=enum
    min: int | None = None
    max: int | None = None


@dataclass
class OperationSpec:
    """Operation metadata + the command generator function."""
    key: str
    label: str
    description: str
    category: str  # 'vlan' | 'interface' | 'global' | 'aaa'
    fields: list[FieldSpec]
    builder: Callable[[str, dict[str, Any]], list[str]]
    icon: str = "ToolOutlined"
    supported_vendors: set[str] = field(default_factory=lambda: set(ALL_SUPPORTED))
    requires_save: bool = True  # append `write memory` after push


# ─── Helpers ────────────────────────────────────────────────────────────────

def _save_cmd(os_type: str) -> str:
    """Vendor-aware running→startup save."""
    if os_type in {"cisco_ios", "cisco_nxos", "cisco_xe", "cisco_sg300"}:
        return "copy running-config startup-config"
    if os_type in COMWARE:
        return "save force"
    # Aruba / Ruijie / fallback
    return "write memory"


def _norm_name(s: str, max_len: int = 32) -> str:
    """Strip + clamp length. Many devices reject long names with spaces."""
    return s.strip()[:max_len]


def _validate_vlan_id(v: Any) -> int:
    try:
        vid = int(v)
    except (TypeError, ValueError):
        raise ValueError("VLAN ID sayısal olmalı")
    if not 1 <= vid <= 4094:
        raise ValueError("VLAN ID 1-4094 aralığında olmalı")
    return vid


def _validate_iface(name: Any) -> str:
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Interface adı boş olamaz")
    iface = name.strip()
    # Light sanity — reject spaces inside name and obvious shell chars.
    if any(ch in iface for ch in (" ", ";", "|", "\n", "\r")):
        raise ValueError(f"Geçersiz interface adı: {iface}")
    return iface


def _validate_ipv4(v: Any) -> str:
    import ipaddress

    if not isinstance(v, str) or not v.strip():
        raise ValueError("IP adresi boş olamaz")
    try:
        ipaddress.IPv4Address(v.strip())
    except (ipaddress.AddressValueError, ValueError):
        raise ValueError(f"Geçersiz IPv4 adresi: {v}")
    return v.strip()


# ─── Operation builders ────────────────────────────────────────────────────

def _b_set_hostname(os_type: str, p: dict[str, Any]) -> list[str]:
    hostname = _norm_name(p["hostname"], 64)
    if not hostname:
        raise ValueError("Hostname boş olamaz")
    fam = vendor_family(os_type)
    if fam in {"cisco", "aoscx", "ruijie"}:
        return [f"hostname {hostname}"]
    if fam == "arubaos":
        return [f"hostname \"{hostname}\""]
    if fam == "comware":
        return [f"sysname {hostname}"]
    raise ValueError(f"Desteklenmeyen vendor ailesi: {fam}")


def _b_add_vlan(os_type: str, p: dict[str, Any]) -> list[str]:
    vid = _validate_vlan_id(p["vlan_id"])
    name = _norm_name(p.get("name") or "", 32)
    fam = vendor_family(os_type)
    if fam in {"cisco", "ruijie"}:
        cmds = [f"vlan {vid}"]
        if name:
            cmds.append(f"name {name}")
        cmds.append("exit")
        return cmds
    if fam == "aoscx":
        cmds = [f"vlan {vid}"]
        if name:
            cmds.append(f"name {name}")
        cmds.append("exit")
        return cmds
    if fam == "arubaos":
        # ArubaOS-Switch / HP: single-line `vlan N name "X"` (config mode)
        line = f"vlan {vid}"
        if name:
            line += f" name \"{name}\""
        return [line]
    if fam == "comware":
        cmds = [f"vlan {vid}"]
        if name:
            cmds.append(f"name {name}")
        cmds.append("quit")
        return cmds
    raise ValueError(fam)


def _b_delete_vlan(os_type: str, p: dict[str, Any]) -> list[str]:
    vid = _validate_vlan_id(p["vlan_id"])
    fam = vendor_family(os_type)
    if fam == "comware":
        return [f"undo vlan {vid}"]
    return [f"no vlan {vid}"]


def _b_assign_port_access_vlan(os_type: str, p: dict[str, Any]) -> list[str]:
    iface = _validate_iface(p["interface"])
    vid = _validate_vlan_id(p["vlan_id"])
    fam = vendor_family(os_type)
    if fam == "cisco":
        return [
            f"interface {iface}",
            "switchport mode access",
            f"switchport access vlan {vid}",
            "exit",
        ]
    if fam == "ruijie":
        return [
            f"interface {iface}",
            "switchport mode access",
            f"switchport access vlan {vid}",
            "exit",
        ]
    if fam == "aoscx":
        return [
            f"interface {iface}",
            f"vlan access {vid}",
            "exit",
        ]
    if fam == "arubaos":
        # ArubaOS-Switch: `vlan N untagged <iface>` from config mode.
        return [f"vlan {vid} untagged {iface}"]
    if fam == "comware":
        return [
            f"interface {iface}",
            "port link-type access",
            f"port access vlan {vid}",
            "quit",
        ]
    raise ValueError(fam)


def _b_set_port_description(os_type: str, p: dict[str, Any]) -> list[str]:
    iface = _validate_iface(p["interface"])
    desc = _norm_name(p["description"], 200)
    if not desc:
        raise ValueError("Açıklama boş olamaz")
    fam = vendor_family(os_type)
    if fam in {"cisco", "ruijie", "aoscx"}:
        return [f"interface {iface}", f"description {desc}", "exit"]
    if fam == "arubaos":
        return [f"interface {iface}", f"name \"{desc}\"", "exit"]
    if fam == "comware":
        return [f"interface {iface}", f"description {desc}", "quit"]
    raise ValueError(fam)


def _b_set_ntp_server(os_type: str, p: dict[str, Any]) -> list[str]:
    ip = _validate_ipv4(p["ip"])
    fam = vendor_family(os_type)
    if fam in {"cisco", "ruijie", "aoscx"}:
        return [f"ntp server {ip}"]
    if fam == "arubaos":
        return [f"sntp server priority 1 {ip}"]
    if fam == "comware":
        return [f"ntp-service unicast-server {ip}"]
    raise ValueError(fam)


def _b_set_syslog_server(os_type: str, p: dict[str, Any]) -> list[str]:
    ip = _validate_ipv4(p["ip"])
    fam = vendor_family(os_type)
    if fam in {"cisco", "ruijie"}:
        return [f"logging host {ip}"]
    if fam == "aoscx":
        return [f"logging {ip}"]
    if fam == "arubaos":
        return [f"logging {ip}"]
    if fam == "comware":
        return [f"info-center loghost {ip}"]
    raise ValueError(fam)


def _b_set_snmp_community(os_type: str, p: dict[str, Any]) -> list[str]:
    community = _norm_name(p["community"], 32)
    if not community:
        raise ValueError("Community string boş olamaz")
    # Reject the well-known weak defaults — would just trigger the
    # config policy checker anyway.
    if community.lower() in {"public", "private"}:
        raise ValueError("'public' / 'private' güvenli değil — özel bir community seçin.")
    mode = (p.get("mode") or "ro").lower()
    if mode not in {"ro", "rw"}:
        raise ValueError("mode 'ro' veya 'rw' olmalı")
    fam = vendor_family(os_type)
    if fam in {"cisco", "ruijie"}:
        return [f"snmp-server community {community} {mode.upper()}"]
    if fam == "aoscx":
        return [f"snmp-server community {community}"]
    if fam == "arubaos":
        # ArubaOS-Switch — community + access role
        if mode == "ro":
            return [f"snmp-server community \"{community}\" operator"]
        return [f"snmp-server community \"{community}\" manager"]
    if fam == "comware":
        return [f"snmp-agent community {mode} {community}"]
    raise ValueError(fam)


def _b_set_dns_server(os_type: str, p: dict[str, Any]) -> list[str]:
    ip = _validate_ipv4(p["ip"])
    fam = vendor_family(os_type)
    if fam in {"cisco", "ruijie"}:
        return ["ip domain-lookup", f"ip name-server {ip}"]
    if fam == "aoscx":
        return [f"ip dns server-address {ip}"]
    if fam == "arubaos":
        return [f"ip dns server-address priority 1 {ip}"]
    if fam == "comware":
        return [f"dns server {ip}"]
    raise ValueError(fam)


# ─── Operation registry ────────────────────────────────────────────────────

OPERATIONS: dict[str, OperationSpec] = {
    "set_hostname": OperationSpec(
        key="set_hostname",
        label="Hostname Ayarla",
        description="Cihazın hostname (sistem adı) değerini değiştir.",
        category="global",
        icon="EditOutlined",
        fields=[
            FieldSpec("hostname", "Yeni Hostname", "string",
                      placeholder="sw-istanbul-dc1-01",
                      help="Boşluksuz, 1-64 karakter."),
        ],
        builder=_b_set_hostname,
    ),
    "add_vlan": OperationSpec(
        key="add_vlan",
        label="VLAN Ekle",
        description="Yeni bir VLAN oluştur (opsiyonel isimle).",
        category="vlan",
        icon="PlusCircleOutlined",
        fields=[
            FieldSpec("vlan_id", "VLAN ID", "vlan_id", min=1, max=4094,
                      placeholder="örn. 100"),
            FieldSpec("name", "VLAN Adı (ops.)", "string", required=False,
                      placeholder="VOICE / GUEST / MGMT",
                      help="Boş bırakılırsa yalnız VLAN ID tanımlanır."),
        ],
        builder=_b_add_vlan,
    ),
    "delete_vlan": OperationSpec(
        key="delete_vlan",
        label="VLAN Sil",
        description="Mevcut bir VLAN tanımını kaldır (cihaz üzerindeki port atamaları etkilenir).",
        category="vlan",
        icon="DeleteOutlined",
        fields=[
            FieldSpec("vlan_id", "Silinecek VLAN ID", "vlan_id", min=1, max=4094),
        ],
        builder=_b_delete_vlan,
    ),
    "assign_port_access_vlan": OperationSpec(
        key="assign_port_access_vlan",
        label="Portu Access VLAN'a Ata",
        description="Bir portu access mode'a alıp belirtilen VLAN'a atar.",
        category="interface",
        icon="ApiOutlined",
        fields=[
            FieldSpec("interface", "Interface", "interface",
                      placeholder="GigabitEthernet1/0/24"),
            FieldSpec("vlan_id", "Hedef VLAN", "vlan_id", min=1, max=4094),
        ],
        builder=_b_assign_port_access_vlan,
    ),
    "set_port_description": OperationSpec(
        key="set_port_description",
        label="Port Açıklaması",
        description="Bir interface'e açıklama / etiket ata (envanter okunaklığı).",
        category="interface",
        icon="TagOutlined",
        fields=[
            FieldSpec("interface", "Interface", "interface",
                      placeholder="GigabitEthernet1/0/1"),
            FieldSpec("description", "Açıklama", "string",
                      placeholder="Sunucu A — VLAN 100",
                      help="Boşluk OK; çift tırnak vendor'a göre eklenir."),
        ],
        builder=_b_set_port_description,
    ),
    "set_ntp_server": OperationSpec(
        key="set_ntp_server",
        label="NTP Sunucusu",
        description="Cihaza NTP sunucusu tanımla (loglar arası zaman tutarlılığı).",
        category="global",
        icon="ClockCircleOutlined",
        fields=[
            FieldSpec("ip", "NTP Sunucu IP", "ipv4",
                      placeholder="10.0.0.1"),
        ],
        builder=_b_set_ntp_server,
    ),
    "set_syslog_server": OperationSpec(
        key="set_syslog_server",
        label="Syslog Sunucusu",
        description="Cihaz loglarının merkez bir syslog sunucusuna gönderilmesini sağla.",
        category="global",
        icon="FileTextOutlined",
        fields=[
            FieldSpec("ip", "Syslog Sunucu IP", "ipv4",
                      placeholder="10.0.0.50"),
        ],
        builder=_b_set_syslog_server,
    ),
    "set_snmp_community": OperationSpec(
        key="set_snmp_community",
        label="SNMP Community",
        description="SNMP read/write community string'i tanımla. (public/private kabul edilmez.)",
        category="global",
        icon="LockOutlined",
        fields=[
            FieldSpec("community", "Community String", "string",
                      placeholder="örn. nmgr-monitor-2026"),
            FieldSpec("mode", "Mod", "enum", default="ro",
                      options=[
                          {"value": "ro", "label": "Read-Only (RO)"},
                          {"value": "rw", "label": "Read-Write (RW)"},
                      ]),
        ],
        builder=_b_set_snmp_community,
    ),
    "set_dns_server": OperationSpec(
        key="set_dns_server",
        label="DNS Sunucusu",
        description="Cihaza DNS sunucusu tanımla.",
        category="global",
        icon="GlobalOutlined",
        fields=[
            FieldSpec("ip", "DNS Sunucu IP", "ipv4",
                      placeholder="8.8.8.8"),
        ],
        builder=_b_set_dns_server,
    ),
}


# ─── Public API ────────────────────────────────────────────────────────────

def list_operations() -> list[dict]:
    """Frontend kullanımı için operation metadata listesi."""
    return [
        {
            "key": op.key,
            "label": op.label,
            "description": op.description,
            "category": op.category,
            "icon": op.icon,
            "requires_save": op.requires_save,
            "supported_vendors": sorted(op.supported_vendors),
            "fields": [
                {
                    "name": f.name, "label": f.label, "type": f.type,
                    "required": f.required, "default": f.default,
                    "placeholder": f.placeholder, "help": f.help,
                    "options": f.options, "min": f.min, "max": f.max,
                }
                for f in op.fields
            ],
        }
        for op in OPERATIONS.values()
    ]


def build_commands(operation_key: str, os_type: str, params: dict[str, Any],
                   *, with_save: bool = True) -> list[str]:
    """Generate the final CLI command list for one operation on one device."""
    op = OPERATIONS.get(operation_key)
    if not op:
        raise ValueError(f"Bilinmeyen operation: {operation_key}")
    if os_type not in ALL_SUPPORTED:
        raise ValueError(f"Desteklenmeyen os_type: {os_type}")
    if os_type not in op.supported_vendors:
        raise ValueError(f"'{op.label}' bu vendor için desteklenmiyor: {os_type}")

    cmds = op.builder(os_type, params)
    if with_save and op.requires_save:
        cmds.append(_save_cmd(os_type))
    return cmds
