"""
Celery task: evaluate escalation rules against active incidents.

Runs every 5 minutes. For each (incident, rule) pair:
  1. matches_rule()  — severity / event_type / source / duration / state
  2. cooldown check  — skip if recently notified for this pair
  3. send_webhook()  — POST to Slack / Jira / generic URL
  4. log result      — EscalationNotificationLog
"""
from __future__ import annotations
import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from app.workers.celery_app import celery_app
from app.core.database import make_worker_session
from app.models.escalation_rule import EscalationRule, EscalationNotificationLog
from app.models.incident import Incident, IncidentState
from app.services.escalation_matcher import matches_rule, cooldown_cutoff
from app.services.escalation_sender import send_webhook

log = logging.getLogger(__name__)

_ACTIVE_STATES = [IncidentState.OPEN, IncidentState.DEGRADED]


async def _run() -> None:
    async with make_worker_session()() as db:
        # Load all enabled rules
        rules = (
            await db.execute(select(EscalationRule).where(EscalationRule.enabled == True))
        ).scalars().all()

        if not rules:
            return

        # Load all active incidents (OPEN or DEGRADED)
        incidents = (
            await db.execute(
                select(Incident).where(Incident.state.in_([s.value for s in _ACTIVE_STATES]))
            )
        ).scalars().all()

        if not incidents:
            return

        now = datetime.now(timezone.utc)

        for incident in incidents:
            for rule in rules:
                if not matches_rule(incident, rule, now=now):
                    continue

                # Cooldown check — look for a recent "sent" log for this pair
                cutoff = cooldown_cutoff(rule.cooldown_secs, now=now)
                recent = (
                    await db.execute(
                        select(EscalationNotificationLog).where(
                            EscalationNotificationLog.rule_id     == rule.id,
                            EscalationNotificationLog.incident_id == incident.id,
                            EscalationNotificationLog.status      == "sent",
                            EscalationNotificationLog.sent_at     >= cutoff,
                        )
                    )
                ).scalar_one_or_none()

                if recent is not None:
                    continue  # still within cooldown

                success, code, err = await send_webhook(rule, incident)

                log_entry = EscalationNotificationLog(
                    rule_id     = rule.id,
                    incident_id = incident.id,
                    channel     = rule.webhook_type,
                    status      = "sent" if success else "failed",
                    response_code = code,
                    error_msg     = err,
                )
                db.add(log_entry)

                log.info(
                    "escalation rule=%d incident=%d status=%s code=%s",
                    rule.id, incident.id, log_entry.status, code,
                )

        await db.commit()


@celery_app.task(name="app.workers.tasks.escalation_tasks.evaluate_escalation_rules", max_retries=1)
def evaluate_escalation_rules() -> None:
    asyncio.run(_run())
