"""
Async webhook sender for escalation notifications.
Isolated from the Celery task so it can be tested and called from dry-run endpoints.
"""
from __future__ import annotations
import json
import logging
from typing import Optional, TYPE_CHECKING

import httpx

from app.core.security import decrypt_credential_safe
from app.services.escalation_matcher import build_payload

if TYPE_CHECKING:
    from app.models.escalation_rule import EscalationRule
    from app.models.incident import Incident

log = logging.getLogger(__name__)

_TIMEOUT = 10  # seconds


async def send_webhook(
    rule: "EscalationRule",
    incident: "Incident",
    dry_run: bool = False,
) -> tuple[bool, Optional[int], Optional[str]]:
    """
    POST the escalation notification to rule.webhook_url.

    Returns (success, http_status_code, error_message).
    Failures are non-fatal — callers should log and continue.
    """
    payload = build_payload(rule.webhook_type, incident)
    headers = {"Content-Type": "application/json"}

    if rule.webhook_headers:
        try:
            _raw = decrypt_credential_safe(rule.webhook_headers)
            if _raw:
                extra = json.loads(_raw)
                if isinstance(extra, dict):
                    headers.update(extra)
        except (json.JSONDecodeError, TypeError):
            log.warning("escalation rule %d: invalid webhook_headers JSON", rule.id)

    if dry_run:
        log.info(
            "DRY-RUN rule=%d incident=%d payload=%s",
            rule.id, incident.id, json.dumps(payload)[:500],
        )
        return True, None, None

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(rule.webhook_url, json=payload, headers=headers)
            success = resp.status_code < 400
            if not success:
                log.warning(
                    "escalation rule=%d incident=%d webhook returned %d",
                    rule.id, incident.id, resp.status_code,
                )
            return success, resp.status_code, None
    except httpx.TimeoutException:
        msg = f"timeout after {_TIMEOUT}s"
        log.warning("escalation rule=%d incident=%d %s", rule.id, incident.id, msg)
        return False, None, msg
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        log.warning("escalation rule=%d incident=%d error: %s", rule.id, incident.id, msg)
        return False, None, msg
