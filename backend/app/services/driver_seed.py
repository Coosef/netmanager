"""
Seed built-in driver templates from the existing hardcoded commands.
Called once at startup if the driver_templates table is empty.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.driver_template import DriverTemplate

BUILTIN_TEMPLATES = [
    # -----------------------------------------------------------------------
    # show_version
    # -----------------------------------------------------------------------
    {"os_type": "cisco_ios",       "command_type": "show_version",        "command_string": "show version",                    "parser_type": "raw"},
    {"os_type": "cisco_nxos",      "command_type": "show_version",        "command_string": "show version",                    "parser_type": "raw"},
    {"os_type": "cisco_sg300",     "command_type": "show_version",        "command_string": "show version",                    "parser_type": "raw"},
    {"os_type": "ruijie_os",       "command_type": "show_version",        "command_string": "show version",                    "parser_type": "raw"},
    {"os_type": "aruba_osswitch",  "command_type": "show_version",        "command_string": "show version",                    "parser_type": "raw"},
    {"os_type": "aruba_aoscx",     "command_type": "show_version",        "command_string": "show version",                    "parser_type": "raw"},
    {"os_type": "hp_procurve",     "command_type": "show_version",        "command_string": "show version",                    "parser_type": "raw"},
    {"os_type": "h3c_comware",     "command_type": "show_version",        "command_string": "display version",                 "parser_type": "raw"},

    # -----------------------------------------------------------------------
    # show_running_config
    # -----------------------------------------------------------------------
    {"os_type": "cisco_ios",       "command_type": "show_running_config", "command_string": "show running-config",             "parser_type": "raw"},
    {"os_type": "cisco_nxos",      "command_type": "show_running_config", "command_string": "show running-config",             "parser_type": "raw"},
    {"os_type": "cisco_sg300",     "command_type": "show_running_config", "command_string": "show running-config",             "parser_type": "raw"},
    {"os_type": "ruijie_os",       "command_type": "show_running_config", "command_string": "show running-config",             "parser_type": "raw"},
    {"os_type": "aruba_osswitch",  "command_type": "show_running_config", "command_string": "show running-config",             "parser_type": "raw"},
    {"os_type": "aruba_aoscx",     "command_type": "show_running_config", "command_string": "show running-config",             "parser_type": "raw"},
    {"os_type": "hp_procurve",     "command_type": "show_running_config", "command_string": "show running-config",             "parser_type": "raw"},
    {"os_type": "h3c_comware",     "command_type": "show_running_config", "command_string": "display current-configuration",   "parser_type": "raw"},

    # -----------------------------------------------------------------------
    # show_interfaces
    # -----------------------------------------------------------------------
    {"os_type": "cisco_ios",       "command_type": "show_interfaces",     "command_string": "show interfaces status",          "parser_type": "regex",
     "parser_template": r"^(?P<port>\S+)\s+(?P<desc>.{0,20}?)\s{2,}(?P<status>connected|notconnect|disabled|err-disabled)\s+(?P<vlan>\S+)\s+(?P<duplex>\S+)\s+(?P<speed>\S+)"},
    {"os_type": "cisco_nxos",      "command_type": "show_interfaces",     "command_string": "show interfaces status",          "parser_type": "regex",
     "parser_template": r"^(?P<port>\S+)\s+(?P<desc>.{0,20}?)\s{2,}(?P<status>connected|notconnect|disabled|err-disabled)\s+(?P<vlan>\S+)\s+(?P<duplex>\S+)\s+(?P<speed>\S+)"},
    {"os_type": "cisco_sg300",     "command_type": "show_interfaces",     "command_string": "show interfaces status",          "parser_type": "raw"},
    {"os_type": "ruijie_os",       "command_type": "show_interfaces",     "command_string": "show interfaces status",          "parser_type": "raw"},
    {"os_type": "aruba_osswitch",  "command_type": "show_interfaces",     "command_string": "show interfaces brief",           "parser_type": "raw"},
    {"os_type": "aruba_aoscx",     "command_type": "show_interfaces",     "command_string": "show interface brief",            "parser_type": "raw"},
    {"os_type": "hp_procurve",     "command_type": "show_interfaces",     "command_string": "show interfaces brief",           "parser_type": "raw"},
    {"os_type": "h3c_comware",     "command_type": "show_interfaces",     "command_string": "display interface brief",         "parser_type": "raw"},

    # -----------------------------------------------------------------------
    # show_vlan
    # -----------------------------------------------------------------------
    {"os_type": "cisco_ios",       "command_type": "show_vlan",           "command_string": "show vlan brief",                 "parser_type": "regex",
     "parser_template": r"^(?P<vlan_id>\d+)\s+(?P<name>\S+)\s+(?P<status>active|act|unsup)\s+(?P<ports>.*)$"},
    {"os_type": "cisco_nxos",      "command_type": "show_vlan",           "command_string": "show vlan brief",                 "parser_type": "regex",
     "parser_template": r"^(?P<vlan_id>\d+)\s+(?P<name>\S+)\s+(?P<status>active|act|unsup)\s+(?P<ports>.*)$"},
    {"os_type": "cisco_sg300",     "command_type": "show_vlan",           "command_string": "show vlan",                       "parser_type": "raw"},
    {"os_type": "ruijie_os",       "command_type": "show_vlan",           "command_string": "show vlan",                       "parser_type": "raw"},
    {"os_type": "aruba_osswitch",  "command_type": "show_vlan",           "command_string": "show running-config",             "parser_type": "raw",
     "notes": "VLAN info parsed from running-config VLAN blocks"},
    {"os_type": "aruba_aoscx",     "command_type": "show_vlan",           "command_string": "show vlan",                       "parser_type": "raw"},
    {"os_type": "hp_procurve",     "command_type": "show_vlan",           "command_string": "show vlan",                       "parser_type": "raw"},
    {"os_type": "h3c_comware",     "command_type": "show_vlan",           "command_string": "display vlan all",                "parser_type": "raw"},

    # -----------------------------------------------------------------------
    # show_lldp
    # -----------------------------------------------------------------------
    {"os_type": "cisco_ios",       "command_type": "show_lldp",           "command_string": "show lldp neighbors detail",      "parser_type": "raw"},
    {"os_type": "cisco_nxos",      "command_type": "show_lldp",           "command_string": "show lldp neighbors detail",      "parser_type": "raw"},
    {"os_type": "cisco_sg300",     "command_type": "show_lldp",           "command_string": "show lldp neighbors detail",      "parser_type": "raw"},
    {"os_type": "ruijie_os",       "command_type": "show_lldp",           "command_string": "show lldp neighbors detail",      "parser_type": "raw"},
    {"os_type": "aruba_osswitch",  "command_type": "show_lldp",           "command_string": "show lldp info remote-device detail", "parser_type": "raw"},
    {"os_type": "aruba_aoscx",     "command_type": "show_lldp",           "command_string": "show lldp neighbor-info detail",  "parser_type": "raw"},
    {"os_type": "hp_procurve",     "command_type": "show_lldp",           "command_string": "show lldp info remote-device detail", "parser_type": "raw"},
    {"os_type": "h3c_comware",     "command_type": "show_lldp",           "command_string": "display lldp neighbor-information verbose", "parser_type": "raw"},

    # -----------------------------------------------------------------------
    # show_cdp (Cisco only)
    # -----------------------------------------------------------------------
    {"os_type": "cisco_ios",       "command_type": "show_cdp",            "command_string": "show cdp neighbors detail",       "parser_type": "raw"},
    {"os_type": "cisco_nxos",      "command_type": "show_cdp",            "command_string": "show cdp neighbors detail",       "parser_type": "raw"},

    # -----------------------------------------------------------------------
    # show_mac_table
    # -----------------------------------------------------------------------
    {"os_type": "cisco_ios",       "command_type": "show_mac_table",      "command_string": "show mac address-table",          "parser_type": "regex",
     "parser_template": r"^\s*(?P<vlan>\d+)\s+(?P<mac>[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+(?P<type>\S+)\s+(?P<port>\S+)"},
    {"os_type": "cisco_nxos",      "command_type": "show_mac_table",      "command_string": "show mac address-table",          "parser_type": "regex",
     "parser_template": r"^\s*(?P<vlan>\d+)\s+(?P<mac>[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+(?P<type>\S+)\s+(?P<port>\S+)"},
    {"os_type": "ruijie_os",       "command_type": "show_mac_table",      "command_string": "show mac-address-table",          "parser_type": "regex",
     "parser_template": r"^(?P<vlan>\d+)\s+(?P<mac>[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+(?P<type>\S+)\s+(?P<port>.*?)\s+\d+d"},
    {"os_type": "aruba_osswitch",  "command_type": "show_mac_table",      "command_string": "show mac-address",                "parser_type": "regex",
     "parser_template": r"^\s*(?P<vlan>\d+)\s+(?P<mac>[0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2})\s+(?P<type>\S+)\s+(?P<port>\S+)"},
    {"os_type": "aruba_aoscx",     "command_type": "show_mac_table",      "command_string": "show mac-address-table",          "parser_type": "raw"},
    {"os_type": "hp_procurve",     "command_type": "show_mac_table",      "command_string": "show mac-address",                "parser_type": "raw"},
    {"os_type": "h3c_comware",     "command_type": "show_mac_table",      "command_string": "display mac-address",             "parser_type": "raw"},

    # -----------------------------------------------------------------------
    # show_arp
    # -----------------------------------------------------------------------
    {"os_type": "cisco_ios",       "command_type": "show_arp",            "command_string": "show arp",                        "parser_type": "regex",
     "parser_template": r"^Internet\s+(?P<ip>\d+\.\d+\.\d+\.\d+)\s+\d+\s+(?P<mac>[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+ARPA\s+(?P<iface>\S+)"},
    {"os_type": "cisco_nxos",      "command_type": "show_arp",            "command_string": "show ip arp",                     "parser_type": "regex",
     "parser_template": r"^(?P<ip>\d+\.\d+\.\d+\.\d+)\s+\S+\s+(?P<mac>[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+(?P<iface>\S+)"},
    {"os_type": "ruijie_os",       "command_type": "show_arp",            "command_string": "show arp",                        "parser_type": "raw"},
    {"os_type": "aruba_osswitch",  "command_type": "show_arp",            "command_string": "show arp",                        "parser_type": "raw"},
    {"os_type": "aruba_aoscx",     "command_type": "show_arp",            "command_string": "show arp",                        "parser_type": "raw"},
    {"os_type": "hp_procurve",     "command_type": "show_arp",            "command_string": "show arp",                        "parser_type": "raw"},
    {"os_type": "h3c_comware",     "command_type": "show_arp",            "command_string": "display arp",                     "parser_type": "raw"},

    # -----------------------------------------------------------------------
    # show_power_inline
    # -----------------------------------------------------------------------
    {"os_type": "cisco_ios",       "command_type": "show_power_inline",   "command_string": "show power inline",               "parser_type": "raw"},
    {"os_type": "ruijie_os",       "command_type": "show_power_inline",   "command_string": "show power inline",               "parser_type": "raw"},

    # -----------------------------------------------------------------------
    # show_switchport
    # -----------------------------------------------------------------------
    {"os_type": "cisco_ios",       "command_type": "show_switchport",     "command_string": "show interfaces switchport",      "parser_type": "raw"},
    {"os_type": "cisco_nxos",      "command_type": "show_switchport",     "command_string": "show interfaces switchport",      "parser_type": "raw"},
    {"os_type": "cisco_sg300",     "command_type": "show_switchport",     "command_string": "show interfaces switchport",      "parser_type": "raw"},
    {"os_type": "ruijie_os",       "command_type": "show_switchport",     "command_string": "show interfaces switchport",      "parser_type": "raw"},
]


async def seed_driver_templates(db: AsyncSession) -> None:
    result = await db.execute(select(DriverTemplate).limit(1))
    if result.scalar_one_or_none() is not None:
        return  # Already seeded

    for entry in BUILTIN_TEMPLATES:
        t = DriverTemplate(
            os_type=entry["os_type"],
            command_type=entry["command_type"],
            command_string=entry["command_string"],
            parser_type=entry.get("parser_type", "raw"),
            parser_template=entry.get("parser_template"),
            notes=entry.get("notes", "Built-in default"),
            is_verified=True,
            is_active=True,
        )
        db.add(t)
    await db.commit()
