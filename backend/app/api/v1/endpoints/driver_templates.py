import asyncio
import json
import re
from datetime import datetime, timezone
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.driver_template import DriverTemplate
from app.models.command_execution import CommandExecution
from app.schemas.driver_template import (
    AISuggestRequest,
    AISuggestResponse,
    DriverTemplateCreate,
    DriverTemplateResponse,
    DriverTemplateUpdate,
    ProbeDeviceResponse,
    ResolveRequest,
    ResolveResponse,
    TemplateHealthSummary,
    TestParseRequest,
    TestParseResponse,
)
from app.services.template_resolver import template_resolver
from app.services.parser_engine import parser_engine

router = APIRouter()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _to_response(t: DriverTemplate) -> DriverTemplateResponse:
    return DriverTemplateResponse(
        id=t.id,
        os_type=t.os_type,
        os_version_pattern=t.os_version_pattern,
        command_type=t.command_type,
        command_string=t.command_string,
        parser_type=t.parser_type,
        parser_template=t.parser_template,
        sample_output=t.sample_output,
        is_verified=t.is_verified,
        is_active=t.is_active,
        priority=t.priority,
        success_count=t.success_count,
        failure_count=t.failure_count,
        last_success_at=t.last_success_at,
        last_failure_at=t.last_failure_at,
        success_rate=t.success_rate,
        health_status=t.health_status,
        notes=t.notes,
        created_by=t.created_by,
        created_at=t.created_at,
        updated_at=t.updated_at,
    )




# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

@router.get("/", response_model=List[DriverTemplateResponse])
async def list_templates(
    os_type: Optional[str] = None,
    command_type: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _current_user: CurrentUser = None,
):
    q = select(DriverTemplate).order_by(DriverTemplate.os_type, DriverTemplate.command_type)
    if os_type:
        q = q.where(DriverTemplate.os_type == os_type)
    if command_type:
        q = q.where(DriverTemplate.command_type == command_type)
    result = await db.execute(q)
    return [_to_response(t) for t in result.scalars().all()]


@router.post("/", response_model=DriverTemplateResponse)
async def create_template(
    payload: DriverTemplateCreate,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    t = DriverTemplate(**payload.model_dump(), created_by=current_user.id)
    db.add(t)
    await db.commit()
    await db.refresh(t)
    return _to_response(t)


@router.put("/{template_id}", response_model=DriverTemplateResponse)
async def update_template(
    template_id: int,
    payload: DriverTemplateUpdate,
    db: AsyncSession = Depends(get_db),
    _current_user: CurrentUser = None,
):
    result = await db.execute(select(DriverTemplate).where(DriverTemplate.id == template_id))
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(404, "Template not found")
    for field, value in payload.model_dump(exclude_none=True).items():
        setattr(t, field, value)
    t.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(t)
    return _to_response(t)


@router.delete("/{template_id}")
async def delete_template(
    template_id: int,
    db: AsyncSession = Depends(get_db),
    _current_user: CurrentUser = None,
):
    result = await db.execute(select(DriverTemplate).where(DriverTemplate.id == template_id))
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(404, "Template not found")
    await db.delete(t)
    await db.commit()
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Test parse
# ---------------------------------------------------------------------------

@router.post("/test-parse", response_model=TestParseResponse)
async def test_parse(payload: TestParseRequest, _current_user: CurrentUser = None):
    result = parser_engine.parse(
        payload.raw_output,
        payload.parser_type,
        payload.parser_template,
    )
    return TestParseResponse(
        success=result.success,
        parsed_result=result.data,
        error=result.error,
    )


# ---------------------------------------------------------------------------
# Template Resolver — find best template for a device
# ---------------------------------------------------------------------------

@router.post("/resolve", response_model=ResolveResponse)
async def resolve_template(
    payload: ResolveRequest,
    db: AsyncSession = Depends(get_db),
    _current_user: CurrentUser = None,
):
    """Return the highest-scoring template for a given (os_type, command_type, firmware)."""
    template = await template_resolver.resolve(
        db,
        os_type=payload.os_type,
        command_type=payload.command_type,
        firmware_version=payload.firmware_version,
    )
    if not template:
        return ResolveResponse(found=False, source="none")
    return ResolveResponse(found=True, template=_to_response(template), source="db")


# ---------------------------------------------------------------------------
# Health dashboard
# ---------------------------------------------------------------------------

@router.get("/health", response_model=List[TemplateHealthSummary])
async def get_health(
    db: AsyncSession = Depends(get_db),
    _current_user: CurrentUser = None,
):
    """Return templates that are broken/warning or have recent failures."""
    result = await db.execute(
        select(DriverTemplate)
        .where(DriverTemplate.is_active.is_(True))
        .order_by(DriverTemplate.last_failure_at.desc().nullslast())
    )
    templates = result.scalars().all()

    summaries = []
    for t in templates:
        total = t.success_count + t.failure_count
        if total < 5 and t.failure_count == 0:
            continue  # not enough data, skip healthy new templates
        status = t.health_status
        if status == "healthy" and t.failure_count == 0:
            continue  # only report problems
        summaries.append(
            TemplateHealthSummary(
                template_id=t.id,
                os_type=t.os_type,
                command_type=t.command_type,
                health_status=status,
                success_rate=t.success_rate,
                success_count=t.success_count,
                failure_count=t.failure_count,
                last_failure_at=t.last_failure_at,
                notes=t.notes,
            )
        )
    return summaries


# ---------------------------------------------------------------------------
# Recent command execution log (raw output archive)
# ---------------------------------------------------------------------------

@router.get("/executions")
async def list_executions(
    device_id: Optional[int] = None,
    command_type: Optional[str] = None,
    parse_success: Optional[bool] = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    _current_user: CurrentUser = None,
):
    q = select(CommandExecution).order_by(CommandExecution.created_at.desc()).limit(limit)
    if device_id is not None:
        q = q.where(CommandExecution.device_id == device_id)
    if command_type:
        q = q.where(CommandExecution.command_type == command_type)
    if parse_success is not None:
        q = q.where(CommandExecution.parse_success == parse_success)
    result = await db.execute(q)
    rows = result.scalars().all()
    return [
        {
            "id": r.id,
            "device_id": r.device_id,
            "template_id": r.template_id,
            "os_type": r.os_type,
            "command_type": r.command_type,
            "command_string": r.command_string,
            "parse_success": r.parse_success,
            "validation_success": r.validation_success,
            "error_message": r.error_message,
            "execution_time_ms": r.execution_time_ms,
            "firmware_version": r.firmware_version,
            "raw_output": r.raw_output,
            "created_at": r.created_at,
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# AI Suggest
# ---------------------------------------------------------------------------

COMMAND_TYPE_DESCRIPTIONS = {
    "show_version": "hardware model, firmware version, serial number, hostname",
    "show_interfaces": "interface name, status (up/down), speed, duplex, description",
    "show_vlan": "VLAN ID, VLAN name, member ports",
    "show_lldp": "neighbor hostname, neighbor port, local port",
    "show_cdp": "neighbor hostname, neighbor port, local port, platform",
    "show_mac_table": "VLAN ID, MAC address, port/interface",
    "show_arp": "IP address, MAC address, interface",
    "show_running_config": "full device configuration text",
    "show_power_inline": "interface, PoE watts consumed, PoE status",
    "show_switchport": "interface, access VLAN, trunk VLANs, mode",
}

AI_SYSTEM_PROMPT = """You are a network automation expert specializing in CLI output parsing.
Your task: given a device's CLI output, produce a JSON response with exactly these fields:
{
  "command_string": "<the exact CLI command that produces this output>",
  "parser_type": "regex" or "textfsm",
  "parser_template": "<regex pattern with named groups OR TextFSM template body>",
  "parsed_result": [<array of parsed records>],
  "explanation": "<brief explanation of what changed / how to use this>"
}

Rules:
- Prefer TextFSM for structured table outputs (multiple rows with consistent columns)
- Use regex with named groups (?P<name>...) for simpler single-value or sparse outputs
- parsed_result must be a real parse of the provided raw_output using your template
- Return ONLY the JSON object, no markdown, no extra text
"""


@router.post("/ai-suggest", response_model=AISuggestResponse)
async def ai_suggest(
    payload: AISuggestRequest,
    db: AsyncSession = Depends(get_db),
    _current_user: CurrentUser = None,
):
    if not settings.ANTHROPIC_API_KEY:
        raise HTTPException(400, "ANTHROPIC_API_KEY is not configured")

    try:
        import anthropic
    except ImportError:
        raise HTTPException(500, "anthropic package not installed")

    field_hint = COMMAND_TYPE_DESCRIPTIONS.get(payload.command_type, "relevant network data")
    version_hint = f"Firmware/OS version: {payload.firmware_version}" if payload.firmware_version else ""

    user_message = f"""OS type: {payload.os_type}
Command type: {payload.command_type} (extract: {field_hint})
{version_hint}

Raw CLI output:
---
{payload.raw_output[:4000]}
---

Generate a parser for this output."""

    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
    message = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=2048,
        system=AI_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
    )

    raw_response = message.content[0].text.strip()

    # Strip markdown fences if present
    if raw_response.startswith("```"):
        raw_response = re.sub(r"^```[a-z]*\n?", "", raw_response)
        raw_response = re.sub(r"\n?```$", "", raw_response)

    try:
        data = json.loads(raw_response)
    except json.JSONDecodeError as e:
        raise HTTPException(500, f"AI returned invalid JSON: {e}") from e

    # Save as unverified template in DB
    t = DriverTemplate(
        os_type=payload.os_type,
        command_type=payload.command_type,
        command_string=data.get("command_string", ""),
        parser_type=data.get("parser_type", "regex"),
        parser_template=data.get("parser_template"),
        sample_output=payload.raw_output[:4000],
        is_verified=False,
        notes=f"AI-generated. {data.get('explanation', '')}",
    )
    db.add(t)
    await db.commit()

    return AISuggestResponse(
        command_string=data.get("command_string", ""),
        parser_type=data.get("parser_type", "regex"),
        parser_template=data.get("parser_template"),
        parsed_result=data.get("parsed_result"),
        explanation=data.get("explanation", ""),
    )


# ---------------------------------------------------------------------------
# Auto-probe device
# ---------------------------------------------------------------------------

# Candidate "show version" commands to try on unknown devices
_VERSION_PROBES = [
    "show version",
    "display version",
    "show system information",
    "get system status",
    "show system",
]

# For each command_type, ordered list of candidate CLI commands to try
_COMMAND_CANDIDATES: dict[str, list[str]] = {
    "show_interfaces":    ["show interfaces status", "show interfaces brief", "show interface brief", "display interface brief"],
    "show_vlan":          ["show vlan brief", "show vlan", "display vlan all", "display vlan"],
    "show_lldp":          ["show lldp neighbors detail", "show lldp info remote-device detail", "show lldp neighbor-info detail", "display lldp neighbor-information verbose"],
    "show_mac_table":     ["show mac address-table", "show mac-address-table", "show mac-address", "display mac-address"],
    "show_arp":           ["show arp", "show ip arp", "display arp"],
    "show_running_config":["show running-config", "display current-configuration"],
    "show_power_inline":  ["show power inline", "display poe interface"],
    "show_switchport":    ["show interfaces switchport", "display port access-vlan"],
}

DETECT_SYSTEM_PROMPT = """You are a network device identification expert.
Given CLI output from an unknown device, extract vendor, model, firmware version, and the correct Netmiko os_type.

Respond with ONLY a JSON object:
{
  "vendor": "<vendor name, e.g. Cisco, Ruijie, Aruba, H3C, Juniper, MikroTik, Fortinet>",
  "model": "<model number/name>",
  "firmware": "<firmware/OS version string>",
  "os_type": "<netmiko driver name: cisco_ios | cisco_nxos | cisco_sg300 | ruijie_os | aruba_osswitch | aruba_aoscx | hp_procurve | h3c_comware | fortios | junos | mikrotik_routeros | generic>",
  "confidence": "high" | "medium" | "low"
}"""


def _call_ai_sync(client, system: str, user: str, max_tokens: int = 1024) -> dict:
    """Synchronous Claude call — used inside thread executor."""
    msg = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    raw = msg.content[0].text.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-z]*\n?", "", raw)
        raw = re.sub(r"\n?```$", "", raw)
    return json.loads(raw)


@router.post("/probe-device/{device_id}", response_model=ProbeDeviceResponse)
async def probe_device(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    _current_user: CurrentUser = None,
):
    """
    SSH into a device, auto-detect vendor/model/firmware via AI,
    then generate missing parser templates for all command types.
    """
    if not settings.ANTHROPIC_API_KEY:
        raise HTTPException(400, "ANTHROPIC_API_KEY is not configured")

    try:
        import anthropic
    except ImportError:
        raise HTTPException(500, "anthropic package not installed")

    from sqlalchemy import select as sa_select
    from app.models.device import Device
    from app.services.ssh_manager import ssh_manager

    # Load device
    result = await db.execute(sa_select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(404, "Device not found")

    ai_client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
    loop = asyncio.get_running_loop()

    # Step 1: Get show version output
    version_output = ""
    for probe_cmd in _VERSION_PROBES:
        try:
            res = await ssh_manager.execute_command(device, probe_cmd)
            if res.success and len(res.output.strip()) > 20:
                version_output = res.output
                break
        except Exception:
            continue

    if not version_output:
        raise HTTPException(502, "Could not retrieve version info — check SSH credentials")

    # Step 2: AI identifies the device
    try:
        detection = await loop.run_in_executor(
            None,
            lambda: _call_ai_sync(
                ai_client,
                DETECT_SYSTEM_PROMPT,
                f"CLI output:\n{version_output[:3000]}",
            ),
        )
    except (json.JSONDecodeError, Exception) as e:
        raise HTTPException(500, f"AI detection failed: {e}") from e

    detected_os = detection.get("os_type") or device.os_type
    detected_vendor = detection.get("vendor")
    detected_model = detection.get("model")
    detected_firmware = detection.get("firmware")

    # Update device record if confidence is not low
    firmware_changed = False
    if detection.get("confidence") != "low":
        if detected_vendor:
            device.vendor = detected_vendor.lower()
        if detected_model and not device.model:
            device.model = detected_model
        if detected_firmware:
            if device.firmware_version and device.firmware_version != detected_firmware:
                firmware_changed = True
            device.firmware_version = detected_firmware
        if detected_os and detected_os != device.os_type:
            device.os_type = detected_os
        await db.commit()

    # Step 3: Find which command_types already have templates for this os_type
    existing_q = await db.execute(
        sa_select(DriverTemplate.command_type).where(
            DriverTemplate.os_type == detected_os,
            DriverTemplate.is_active.is_(True),
        )
    )
    existing_cmd_types = {row[0] for row in existing_q.all()}

    # Step 4: For each missing command_type, try candidates and generate template
    templates_created = 0
    templates_skipped = 0
    details = []

    for cmd_type, candidates in _COMMAND_CANDIDATES.items():
        if cmd_type in existing_cmd_types:
            templates_skipped += 1
            details.append({"command_type": cmd_type, "status": "skipped", "reason": "template already exists"})
            continue

        # Try candidate commands
        cmd_output = ""
        used_cmd = ""
        for candidate in candidates:
            try:
                res = await ssh_manager.execute_command(device, candidate)
                if res.success and len(res.output.strip()) > 10:
                    cmd_output = res.output
                    used_cmd = candidate
                    break
            except Exception:
                continue

        if not cmd_output:
            details.append({"command_type": cmd_type, "status": "skipped", "reason": "all candidate commands failed"})
            continue

        # Generate template via AI
        field_hint = COMMAND_TYPE_DESCRIPTIONS.get(cmd_type, "relevant network data")
        try:
            ai_data = await loop.run_in_executor(
                None,
                lambda cmd=cmd_output, hint=field_hint, cmd_str=used_cmd: _call_ai_sync(
                    ai_client,
                    AI_SYSTEM_PROMPT,
                    f"OS type: {detected_os}\nCommand type: {cmd_type} (extract: {hint})\nCommand used: {cmd_str}\n\nRaw CLI output:\n---\n{cmd[:3000]}\n---\n\nGenerate a parser.",
                    max_tokens=2048,
                ),
            )
        except Exception as e:
            details.append({"command_type": cmd_type, "status": "error", "reason": str(e)})
            continue

        t = DriverTemplate(
            os_type=detected_os,
            command_type=cmd_type,
            command_string=ai_data.get("command_string") or used_cmd,
            parser_type=ai_data.get("parser_type", "raw"),
            parser_template=ai_data.get("parser_template"),
            sample_output=cmd_output[:4000],
            is_verified=False,
            notes=f"Auto-generated by probe. Device: {device.hostname} ({device.ip_address}). {ai_data.get('explanation', '')}",
        )
        db.add(t)
        templates_created += 1
        details.append({
            "command_type": cmd_type,
            "status": "created",
            "command_string": t.command_string,
            "parser_type": t.parser_type,
        })

    if templates_created > 0:
        await db.commit()

    return ProbeDeviceResponse(
        device_id=device_id,
        detected_vendor=detected_vendor,
        detected_model=detected_model,
        detected_firmware=detected_firmware,
        detected_os_type=detected_os,
        templates_created=templates_created,
        templates_skipped=templates_skipped,
        firmware_changed=firmware_changed,
        details=details,
    )
