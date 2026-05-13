"""
Pure, side-effect-free functions for escalation rule matching and payload building.
No DB/IO — all testable in isolation.
"""
from __future__ import annotations
import json
from datetime import datetime, timezone
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from app.models.escalation_rule import EscalationRule
    from app.models.incident import Incident


# ── Matcher ───────────────────────────────────────────────────────────────────

def matches_rule(incident: "Incident", rule: "EscalationRule", now: Optional[datetime] = None) -> bool:
    """Return True when incident satisfies all non-null conditions on rule."""
    if not rule.enabled:
        return False

    # State filter
    allowed_states = _parse_json_list(rule.match_states) or ["OPEN", "DEGRADED"]
    if incident.state not in allowed_states:
        return False

    # Severity filter
    if rule.match_severity:
        allowed = _parse_json_list(rule.match_severity)
        if allowed and incident.severity not in allowed:
            return False

    # Event type filter
    if rule.match_event_types:
        allowed = _parse_json_list(rule.match_event_types)
        if allowed and incident.event_type not in allowed:
            return False

    # Source filter — any match is sufficient
    if rule.match_sources:
        allowed = set(_parse_json_list(rule.match_sources) or [])
        sources = incident.sources or []
        incident_sources = {s.get("source") for s in sources if isinstance(s, dict)}
        if allowed and not allowed.intersection(incident_sources):
            return False

    # Minimum duration
    if rule.min_duration_secs is not None and incident.opened_at:
        _now = now or datetime.now(timezone.utc)
        elapsed = (_now - incident.opened_at).total_seconds()
        if elapsed < rule.min_duration_secs:
            return False

    return True


# ── Cooldown check ────────────────────────────────────────────────────────────

def cooldown_cutoff(cooldown_secs: int, now: Optional[datetime] = None) -> datetime:
    """Return the datetime before which a sent notification counts as 'on cooldown'."""
    from datetime import timedelta
    _now = now or datetime.now(timezone.utc)
    return _now - timedelta(seconds=cooldown_secs)


# ── Payload builders ──────────────────────────────────────────────────────────

def build_slack_payload(incident: "Incident") -> dict[str, Any]:
    color = {"critical": "#ef4444", "warning": "#f59e0b", "info": "#3b82f6"}.get(
        incident.severity, "#64748b"
    )
    opened_ts = int(incident.opened_at.timestamp()) if incident.opened_at else None
    text_lines = [
        f"*Cihaz:* {incident.device_hostname or '—'} `{incident.device_ip or '—'}`",
        f"*Olay:* `{incident.event_type}`",
        f"*Durum:* {incident.state}",
    ]
    if incident.component:
        text_lines.append(f"*Bileşen:* {incident.component}")
    payload: dict[str, Any] = {
        "attachments": [
            {
                "color": color,
                "title": f"[{incident.severity.upper()}] {incident.event_type}",
                "text": "\n".join(text_lines),
                "footer": "NetManager · Escalation Engine",
            }
        ]
    }
    if opened_ts:
        payload["attachments"][0]["ts"] = opened_ts
    return payload


def build_generic_payload(incident: "Incident") -> dict[str, Any]:
    return {
        "incident_id":     incident.id,
        "fingerprint":     incident.fingerprint,
        "severity":        incident.severity,
        "event_type":      incident.event_type,
        "component":       incident.component,
        "state":           incident.state,
        "device_id":       incident.device_id,
        "device_hostname": incident.device_hostname,
        "device_ip":       incident.device_ip,
        "opened_at":       incident.opened_at.isoformat() if incident.opened_at else None,
        "closed_at":       incident.closed_at.isoformat() if incident.closed_at else None,
    }


def build_jira_payload(incident: "Incident") -> dict[str, Any]:
    """Jira automation webhook — generic trigger format."""
    sev_priority = {"critical": "Highest", "warning": "Medium", "info": "Low"}
    return {
        "summary": f"[{incident.severity.upper()}] {incident.event_type} — {incident.device_hostname or incident.device_ip}",
        "description": (
            f"Incident #{incident.id} detected.\n"
            f"Device: {incident.device_hostname} ({incident.device_ip})\n"
            f"Event: {incident.event_type}\n"
            f"State: {incident.state}\n"
            f"Opened: {incident.opened_at.isoformat() if incident.opened_at else 'unknown'}"
        ),
        "priority": sev_priority.get(incident.severity, "Medium"),
        "labels": ["netmanager", "auto-escalation", incident.severity],
        "incident_id": incident.id,
    }


def build_payload(webhook_type: str, incident: "Incident") -> dict[str, Any]:
    if webhook_type == "slack":
        return build_slack_payload(incident)
    if webhook_type == "jira":
        return build_jira_payload(incident)
    return build_generic_payload(incident)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_json_list(value: Optional[str]) -> list[str]:
    if not value:
        return []
    try:
        result = json.loads(value)
        return result if isinstance(result, list) else []
    except (json.JSONDecodeError, TypeError):
        return []
