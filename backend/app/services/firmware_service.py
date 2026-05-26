"""T9 Tur 8 — Firmware install command templates + version parsing.

Vendor-aware helpers for the install worker. The artifact catalog stores
`install_commands` as JSON when the operator wants to override the
defaults; falls back to these per-vendor templates if missing.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class InstallPlan:
    """The command list executed per stage. Stages run in sequence:

      1. transfer_cmds    — pull the firmware file onto the device
                            (SCP / TFTP / agent-relayed copy)
      2. boot_set_cmds    — set the new image as boot target
      3. save_cmds        — persist running config
      4. reload_cmds      — reboot (operator-gated)
      5. verify_cmd       — single 'show version' after reload, used to
                            extract post_version
    """
    transfer_cmds: list[str]
    boot_set_cmds: list[str]
    save_cmds: list[str]
    reload_cmds: list[str]
    verify_cmd: str


def default_install_plan(
    os_type: str, *, source_url: str, file_basename: str,
    transfer_method: str = "scp",
) -> InstallPlan:
    """Per-OS-type default install plan. `source_url` is the URL the device
    fetches from (HTTP/TFTP/SCP); `file_basename` is the destination
    filename on the device's flash."""
    if os_type in {"cisco_ios", "cisco_xe", "cisco_nxos"}:
        return InstallPlan(
            transfer_cmds=[f"copy {source_url} flash:{file_basename}"],
            boot_set_cmds=[
                f"no boot system",
                f"boot system flash:{file_basename}",
            ],
            save_cmds=["copy running-config startup-config"],
            reload_cmds=["reload"],
            verify_cmd="show version",
        )
    if os_type in {"aruba_osswitch", "hp_procurve"}:
        # ArubaOS-Switch: copy {tftp|scp} flash {primary|secondary} <ip> <file>
        return InstallPlan(
            transfer_cmds=[f"copy {source_url} flash secondary"],
            boot_set_cmds=["boot system flash secondary"],
            save_cmds=["write memory"],
            reload_cmds=["reload"],
            verify_cmd="show version",
        )
    if os_type == "aruba_aoscx":
        return InstallPlan(
            transfer_cmds=[f"copy {source_url} primary"],
            boot_set_cmds=["boot system primary"],
            save_cmds=["write memory"],
            reload_cmds=["boot system"],
            verify_cmd="show version",
        )
    if os_type == "ruijie_os":
        return InstallPlan(
            transfer_cmds=[f"copy {source_url} flash:{file_basename}"],
            boot_set_cmds=[f"boot system flash:{file_basename}"],
            save_cmds=["write"],
            reload_cmds=["reload"],
            verify_cmd="show version",
        )
    if os_type == "comware":
        # H3C / HPE Comware
        return InstallPlan(
            transfer_cmds=[f"copy {source_url} {file_basename}"],
            boot_set_cmds=[f"boot-loader file {file_basename} slot 1 main"],
            save_cmds=["save force"],
            reload_cmds=["reboot"],
            verify_cmd="display version",
        )
    raise ValueError(f"Firmware update for {os_type} not yet supported")


# ── Version extraction ─────────────────────────────────────────────────────

_VERSION_PATTERNS = [
    # Cisco IOS: "Cisco IOS Software, ..., Version 15.2(4)E10"
    re.compile(r"Version\s+([0-9][\w.()]+)", re.IGNORECASE),
    # Aruba AOS-Switch: "Software revision   YA.16.10.0007"
    re.compile(r"Software revision\s*[:]?\s*(\S+)", re.IGNORECASE),
    # ArubaOS-CX: "Version      : FL.10.10.1000"
    re.compile(r"Version\s*[:]\s*(\S+)", re.IGNORECASE),
    # Comware: "H3C Comware Software, Version 7.1.075"
    re.compile(r"Comware Software,\s*Version\s+(\S+)", re.IGNORECASE),
    # Ruijie: same family as Cisco, Version pattern works.
]


def extract_version(show_version_output: str) -> str | None:
    """Best-effort version string extraction from `show version` output.

    Tries the per-vendor patterns; returns the first match. Returns None
    when nothing matched — the operator will see 'unknown' in the post
    field and can investigate manually.
    """
    if not show_version_output:
        return None
    for pat in _VERSION_PATTERNS:
        m = pat.search(show_version_output)
        if m:
            return m.group(1).strip(" ,.")
    return None


def build_install_plan(
    artifact_install_commands: dict | None,
    os_type: str,
    *,
    source_url: str,
    file_basename: str,
    transfer_method: str,
) -> InstallPlan:
    """If the artifact has an operator-supplied install_commands override,
    use it; else fall back to per-os defaults."""
    if artifact_install_commands:
        try:
            return InstallPlan(
                transfer_cmds=list(artifact_install_commands.get("transfer_cmds") or []),
                boot_set_cmds=list(artifact_install_commands.get("boot_set_cmds") or []),
                save_cmds=list(artifact_install_commands.get("save_cmds") or []),
                reload_cmds=list(artifact_install_commands.get("reload_cmds") or []),
                verify_cmd=str(artifact_install_commands.get("verify_cmd") or "show version"),
            )
        except (TypeError, AttributeError) as exc:
            raise ValueError(f"install_commands JSON malformed: {exc}")
    return default_install_plan(
        os_type,
        source_url=source_url,
        file_basename=file_basename,
        transfer_method=transfer_method,
    )
