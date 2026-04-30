"""
NetManager MCP Server
Exposes all NetManager operations as Claude tools via the Model Context Protocol.

Usage:
    NETMANAGER_URL=http://your-server:8000 \
    NETMANAGER_USERNAME=admin \
    NETMANAGER_PASSWORD=yourpassword \
    python netmanager_mcp.py
"""

import os
import sys
import json
import time
import logging
from typing import Optional
import httpx
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
log = logging.getLogger("netmanager-mcp")

API_URL = os.environ.get("NETMANAGER_URL", "http://localhost:8000").rstrip("/") + "/api/v1"
USERNAME = os.environ.get("NETMANAGER_USERNAME", "admin")
PASSWORD = os.environ.get("NETMANAGER_PASSWORD", "")

mcp = FastMCP("NetManager")

# ── Token cache ──────────────────────────────────────────────────────────────

_token: str = ""
_token_fetched_at: float = 0.0
TOKEN_TTL = 3600 * 8  # 8 hours


async def _get_token() -> str:
    global _token, _token_fetched_at
    if _token and (time.time() - _token_fetched_at) < TOKEN_TTL:
        return _token
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(f"{API_URL}/auth/login", json={"username": USERNAME, "password": PASSWORD})
        r.raise_for_status()
        _token = r.json()["access_token"]
        _token_fetched_at = time.time()
    return _token


async def _api(method: str, path: str, **kwargs) -> dict | list:
    token = await _get_token()
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.request(method, f"{API_URL}{path}", headers=headers, **kwargs)
        if r.status_code == 204:
            return {"ok": True}
        r.raise_for_status()
        return r.json()


def _fmt(data: dict | list) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, default=str)


# ── Devices ──────────────────────────────────────────────────────────────────

@mcp.tool()
async def list_devices(
    search: str = "",
    vendor: str = "",
    status: str = "",
    limit: int = 100,
) -> str:
    """
    List managed network devices (switches, routers).

    Args:
        search: Filter by hostname or IP address (partial match)
        vendor: Filter by vendor — cisco | aruba | ruijie | other
        status: Filter by status — online | offline | unknown | unreachable
        limit: Max results to return (default 100)
    """
    params: dict = {"limit": limit}
    if search:
        params["search"] = search
    if vendor:
        params["vendor"] = vendor
    if status:
        params["status"] = status
    data = await _api("GET", "/devices/", params=params)
    items = data.get("items", [])
    summary = [
        {"id": d["id"], "hostname": d["hostname"], "ip": d["ip_address"],
         "vendor": d["vendor"], "os_type": d["os_type"], "status": d["status"],
         "model": d.get("model"), "location": d.get("location")}
        for d in items
    ]
    return _fmt({"total": data.get("total", len(items)), "devices": summary})


@mcp.tool()
async def get_device(device_id: int) -> str:
    """
    Get full details of a specific device including model, firmware, serial number, SSH port.

    Args:
        device_id: Numeric device ID (use list_devices to find IDs)
    """
    data = await _api("GET", f"/devices/{device_id}")
    return _fmt(data)


@mcp.tool()
async def add_device(
    hostname: str,
    ip_address: str,
    ssh_username: str,
    ssh_password: str,
    vendor: str = "ruijie",
    os_type: str = "ruijie_os",
    ssh_port: int = 22,
    enable_secret: str = "",
    location: str = "",
    group_id: Optional[int] = None,
) -> str:
    """
    Add a new network device to the inventory.

    Args:
        hostname: Device hostname (e.g. CORE-SW-01)
        ip_address: Management IP address (e.g. 10.24.90.1)
        ssh_username: SSH login username
        ssh_password: SSH login password
        vendor: cisco | aruba | ruijie | other  (default: ruijie)
        os_type: cisco_ios | cisco_nxos | aruba_osswitch | ruijie_os | generic  (default: ruijie_os)
        ssh_port: SSH port number (default: 22)
        enable_secret: Enable / privileged mode secret (leave empty if not needed)
        location: Physical location description
        group_id: Device group ID to assign to (optional)
    """
    payload: dict = {
        "hostname": hostname,
        "ip_address": ip_address,
        "vendor": vendor,
        "os_type": os_type,
        "ssh_username": ssh_username,
        "ssh_password": ssh_password,
        "ssh_port": ssh_port,
    }
    if enable_secret:
        payload["enable_secret"] = enable_secret
    if location:
        payload["location"] = location
    if group_id:
        payload["group_id"] = group_id
    data = await _api("POST", "/devices/", json=payload)
    return _fmt({"added": True, "device": data})


@mcp.tool()
async def update_device(
    device_id: int,
    hostname: str = "",
    location: str = "",
    ssh_username: str = "",
    ssh_password: str = "",
    enable_secret: str = "",
    os_type: str = "",
    vendor: str = "",
) -> str:
    """
    Update device fields. Only provided (non-empty) fields are updated.

    Args:
        device_id: Device to update
        hostname: New hostname
        location: New physical location
        ssh_username: New SSH username
        ssh_password: New SSH password
        enable_secret: New enable secret (send 'CLEAR' to remove)
        os_type: New OS type
        vendor: New vendor
    """
    payload: dict = {}
    if hostname:
        payload["hostname"] = hostname
    if location:
        payload["location"] = location
    if ssh_username:
        payload["ssh_username"] = ssh_username
    if ssh_password:
        payload["ssh_password"] = ssh_password
    if enable_secret:
        payload["enable_secret"] = "" if enable_secret == "CLEAR" else enable_secret
    if os_type:
        payload["os_type"] = os_type
    if vendor:
        payload["vendor"] = vendor
    if not payload:
        return _fmt({"error": "No fields to update provided"})
    data = await _api("PATCH", f"/devices/{device_id}", json=payload)
    return _fmt({"updated": True, "device": data})


@mcp.tool()
async def delete_device(device_id: int) -> str:
    """
    Permanently delete a device and all its config backups from inventory.

    Args:
        device_id: Numeric device ID to delete
    """
    await _api("DELETE", f"/devices/{device_id}")
    return _fmt({"deleted": True, "device_id": device_id})


@mcp.tool()
async def test_device_connection(device_id: int) -> str:
    """
    Test SSH connectivity to a device. Returns success/failure with latency.

    Args:
        device_id: Device to test
    """
    data = await _api("POST", f"/devices/{device_id}/test")
    return _fmt(data)


@mcp.tool()
async def fetch_device_info(device_id: int) -> str:
    """
    SSH into a device, run 'show version', and update its model/firmware/serial in inventory.

    Args:
        device_id: Device to fetch info from
    """
    data = await _api("POST", f"/devices/{device_id}/fetch-info")
    return _fmt(data)


@mcp.tool()
async def run_show_command(device_id: int, command: str) -> str:
    """
    Run a read-only 'show' command on a device via SSH and return the output.
    Only 'show ...' commands are allowed.

    Args:
        device_id: Target device
        command: Show command to run (e.g. 'show interfaces', 'show vlan brief')
    """
    data = await _api("POST", f"/devices/{device_id}/run-command", json={"command": command})
    return _fmt(data)


@mcp.tool()
async def get_device_config(device_id: int) -> str:
    """
    Retrieve the running configuration from a device via SSH.

    Args:
        device_id: Target device
    """
    data = await _api("GET", f"/devices/{device_id}/config")
    return _fmt(data)


@mcp.tool()
async def take_config_backup(device_id: int) -> str:
    """
    Take an immediate config backup for a device (SSH → show running-config).

    Args:
        device_id: Target device
    """
    data = await _api("POST", f"/devices/{device_id}/backups/take")
    return _fmt(data)


@mcp.tool()
async def list_device_backups(device_id: int) -> str:
    """
    List config backup history for a device.

    Args:
        device_id: Target device
    """
    data = await _api("GET", f"/devices/{device_id}/backups")
    return _fmt(data)


@mcp.tool()
async def bulk_update_credentials(
    device_ids: list[int],
    source_device_id: Optional[int] = None,
    ssh_username: str = "",
    ssh_password: str = "",
    enable_secret: str = "",
) -> str:
    """
    Copy SSH/enable credentials to multiple devices at once.
    Either provide source_device_id to copy from an existing device,
    or provide ssh_username + ssh_password manually.

    Args:
        device_ids: List of device IDs to update
        source_device_id: Copy credentials from this device (optional)
        ssh_username: Manual SSH username (if no source_device_id)
        ssh_password: Manual SSH password (if no source_device_id)
        enable_secret: Manual enable secret (if no source_device_id, optional)
    """
    payload: dict = {"device_ids": device_ids}
    if source_device_id:
        payload["source_device_id"] = source_device_id
    else:
        payload["ssh_username"] = ssh_username
        payload["ssh_password"] = ssh_password
        if enable_secret:
            payload["enable_secret"] = enable_secret
    data = await _api("POST", "/devices/bulk-update-credentials", json=payload)
    return _fmt(data)


# ── Device Groups ─────────────────────────────────────────────────────────────

@mcp.tool()
async def list_device_groups() -> str:
    """List all device groups."""
    data = await _api("GET", "/devices/groups")
    return _fmt(data)


@mcp.tool()
async def create_device_group(name: str, description: str = "") -> str:
    """
    Create a new device group.

    Args:
        name: Group name
        description: Optional description
    """
    payload: dict = {"name": name}
    if description:
        payload["description"] = description
    data = await _api("POST", "/devices/groups", json=payload)
    return _fmt(data)


# ── Topology ─────────────────────────────────────────────────────────────────

@mcp.tool()
async def get_topology(group_id: Optional[int] = None) -> str:
    """
    Get the network topology graph (devices and LLDP/CDP links between them).
    Returns nodes (devices) and edges (links) suitable for visualization.

    Args:
        group_id: Filter topology to a specific device group (optional)
    """
    params = {}
    if group_id:
        params["group_id"] = group_id
    data = await _api("GET", "/topology/graph", params=params)
    nodes = data.get("nodes", [])
    edges = data.get("edges", [])
    summary = {
        "node_count": len(nodes),
        "edge_count": len(edges),
        "nodes": [
            {"id": n["id"], "label": n.get("label"), "type": n.get("type"),
             "status": n.get("status"), "ip": n.get("ip_address"), "vendor": n.get("vendor")}
            for n in nodes
        ],
        "edges": [
            {"source": e.get("source"), "target": e.get("target"),
             "local_port": e.get("local_port"), "remote_port": e.get("remote_port"),
             "protocol": e.get("protocol")}
            for e in edges
        ],
    }
    return _fmt(summary)


@mcp.tool()
async def get_lldp_inventory() -> str:
    """
    Get the LLDP discovery inventory — all neighboring devices found via LLDP/CDP
    that are NOT yet in the main inventory (APs, phones, cameras, printers, ghost switches).
    """
    data = await _api("GET", "/topology/lldp-inventory")
    return _fmt(data)


# ── Tasks ─────────────────────────────────────────────────────────────────────

@mcp.tool()
async def list_tasks(status: str = "", task_type: str = "", limit: int = 50) -> str:
    """
    List background tasks (config backup, topology discovery, bulk commands, etc).

    Args:
        status: Filter — pending | running | success | partial | failed | cancelled
        task_type: Filter — backup_config | bulk_command | topology_discover | hop_discover | bulk_password_change | monitor_poll
        limit: Max results (default 50)
    """
    params: dict = {"limit": limit}
    if status:
        params["status"] = status
    if task_type:
        params["type"] = task_type
    data = await _api("GET", "/tasks/", params=params)
    items = data.get("items", [])
    summary = [
        {"id": t["id"], "name": t["name"], "type": t["type"], "status": t["status"],
         "progress": f"{t.get('completed_devices', 0)}/{t.get('total_devices', 0)}",
         "created_at": t.get("created_at")}
        for t in items
    ]
    return _fmt({"total": data.get("total", len(items)), "tasks": summary})


@mcp.tool()
async def get_task(task_id: int) -> str:
    """
    Get full details and results of a specific task.

    Args:
        task_id: Task ID
    """
    data = await _api("GET", f"/tasks/{task_id}")
    return _fmt(data)


@mcp.tool()
async def create_task(
    name: str,
    task_type: str,
    device_ids: list[int],
    commands: list[str] = [],
    new_password: str = "",
) -> str:
    """
    Create and immediately start a background task.

    Args:
        name: Human-readable task name
        task_type: backup_config | bulk_command | topology_discover | bulk_password_change | monitor_poll
        device_ids: List of device IDs to run the task against
        commands: For bulk_command tasks — list of 'show ...' commands to run
        new_password: For bulk_password_change tasks — the new password to set
    """
    payload: dict = {"name": name, "type": task_type, "device_ids": device_ids, "parameters": {}}
    if commands:
        payload["parameters"]["commands"] = commands
    if new_password:
        payload["parameters"]["new_password"] = new_password
    data = await _api("POST", "/tasks/", json=payload)
    return _fmt({"created": True, "task": data})


@mcp.tool()
async def cancel_task(task_id: int) -> str:
    """
    Cancel a running or pending task.

    Args:
        task_id: Task ID to cancel
    """
    data = await _api("POST", f"/tasks/{task_id}/cancel")
    return _fmt(data)


@mcp.tool()
async def discover_topology(device_ids: list[int] = []) -> str:
    """
    Start a topology discovery task that SSH-es into devices and collects LLDP/CDP neighbor data.
    If no device_ids provided, discovers all active devices.

    Args:
        device_ids: Specific device IDs to discover (empty = all devices)
    """
    if not device_ids:
        all_devices = await _api("GET", "/devices/", params={"limit": 2000})
        device_ids = [d["id"] for d in all_devices.get("items", [])]

    if not device_ids:
        return _fmt({"error": "No devices found"})

    payload = {
        "name": "Topology Discovery (via agent)",
        "type": "topology_discover",
        "device_ids": device_ids,
    }
    data = await _api("POST", "/tasks/", json=payload)
    return _fmt({"started": True, "task_id": data.get("id"), "device_count": len(device_ids)})


# ── Audit Log ────────────────────────────────────────────────────────────────

@mcp.tool()
async def get_audit_log(
    action: str = "",
    resource_type: str = "",
    username: str = "",
    limit: int = 50,
) -> str:
    """
    View the audit log — who did what and when.

    Args:
        action: Filter by action keyword (e.g. 'login', 'device_created', 'backup')
        resource_type: Filter by resource — device | task | group
        username: Filter by username
        limit: Max entries to return (default 50)
    """
    params: dict = {"limit": limit}
    if action:
        params["action"] = action
    if resource_type:
        params["resource_type"] = resource_type
    if username:
        params["username"] = username
    data = await _api("GET", "/tasks/audit-log", params=params)
    return _fmt(data)


# ── Network Interfaces & VLANs ───────────────────────────────────────────────

@mcp.tool()
async def get_device_interfaces(device_id: int) -> str:
    """
    Get all interfaces of a device (name, status, speed, description, VLAN).

    Args:
        device_id: Target device
    """
    data = await _api("GET", f"/devices/{device_id}/interfaces")
    return _fmt(data)


@mcp.tool()
async def get_device_vlans(device_id: int) -> str:
    """
    Get the VLAN table of a device.

    Args:
        device_id: Target device
    """
    data = await _api("GET", f"/devices/{device_id}/vlans")
    return _fmt(data)


# ── System Info ───────────────────────────────────────────────────────────────

@mcp.tool()
async def get_network_summary() -> str:
    """
    Get a high-level summary of the entire managed network:
    device counts by status and vendor, recent tasks, topology size.
    """
    devices_data = await _api("GET", "/devices/", params={"limit": 2000})
    tasks_data = await _api("GET", "/tasks/", params={"limit": 5})

    devices = devices_data.get("items", [])
    status_counts: dict[str, int] = {}
    vendor_counts: dict[str, int] = {}
    for d in devices:
        status_counts[d["status"]] = status_counts.get(d["status"], 0) + 1
        vendor_counts[d["vendor"]] = vendor_counts.get(d["vendor"], 0) + 1

    return _fmt({
        "devices": {
            "total": devices_data.get("total", 0),
            "by_status": status_counts,
            "by_vendor": vendor_counts,
        },
        "recent_tasks": [
            {"id": t["id"], "name": t["name"], "status": t["status"], "created_at": t.get("created_at")}
            for t in tasks_data.get("items", [])
        ],
    })


if __name__ == "__main__":
    if not PASSWORD:
        print("ERROR: NETMANAGER_PASSWORD environment variable is required", file=sys.stderr)
        sys.exit(1)
    mcp.run(transport="stdio")
