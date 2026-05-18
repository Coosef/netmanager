"""
SNMP ingest — Faz 6C.1

Shared SNMP poll-result persistence, used by:
  * the event_consumer service — drains the `ingest:snmp` stream and
    bulk-persists batches;
  * the snmp_tasks fallback path — direct insert when the event bus is
    unavailable.

Unlike syslog, SNMP poll results do NOT feed the correlation engine
(poll_snmp_all collects interface counters; availability detection lives
in monitor_tasks.check_port_status). So this is a pure bulk insert — no
correlation step.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)


def _parse_dt(value) -> datetime:
    """Accept a datetime (fallback path) or an ISO string (stream path)."""
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            pass
    return datetime.now(timezone.utc)


def build_snmp_row(payload: dict):
    """Build a SnmpPollResult ORM object from a stream/fallback payload dict.

    Shared by persist_snmp_batch (consumer) and the snmp_tasks fallback so
    the two paths produce identical rows.
    """
    from app.models.snmp_metric import SnmpPollResult

    return SnmpPollResult(
        device_id=payload["device_id"],
        polled_at=_parse_dt(payload.get("polled_at")),
        if_index=payload.get("if_index"),
        if_name=payload.get("if_name"),
        speed_mbps=payload.get("speed_mbps"),
        in_octets=payload.get("in_octets"),
        out_octets=payload.get("out_octets"),
        in_errors=payload.get("in_errors"),
        out_errors=payload.get("out_errors"),
        in_utilization_pct=payload.get("in_utilization_pct"),
        out_utilization_pct=payload.get("out_utilization_pct"),
    )


async def persist_snmp_batch(db, payloads: list[dict]) -> int:
    """
    Bulk-insert SNMP poll-result rows in ONE commit. Returns rows persisted.

    db        — caller-supplied AsyncSession (the consumer's batch session).
    payloads  — list of SnmpPollResult field dicts from the ingest:snmp stream.
    """
    if not payloads:
        return 0
    rows = [build_snmp_row(p) for p in payloads]
    db.add_all(rows)
    await db.commit()
    return len(rows)
