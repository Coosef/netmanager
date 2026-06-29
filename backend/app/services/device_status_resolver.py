"""Telemetry-aware device status resolution.

The previous reachability path inside `monitor_tasks._check_device_reachable`
self-locked any device whose agent was online:

    if agent_id and _agent_is_online(agent_id):
        return device.status == DeviceStatus.ONLINE

Once a device was written as OFFLINE that branch kept reporting it OFFLINE
on every subsequent poll, regardless of how much SSH/PoE/MAC telemetry had
arrived since. This module replaces that with a resolver that honours
agent reports as the primary signal AND falls back to fresh telemetry as a
recovery signal, so a single successful SSH command (or fresh PoE/MAC
snapshot) can recover a stuck-offline device.

Reason taxonomy (used in logs + Redis cache payload + tests):

    agent_report          — most recent device_status_report from the agent
    fresh_ssh_telemetry   — fresh successful agent_command_logs row
    fresh_snapshot        — fresh poe_port_snapshots or mac_address_entries row
    backend_icmp          — backend host ICMP probe outcome (agentless path)
    stale_or_unknown      — no actionable signal; preserve current status

Design points worth keeping:

- The resolver itself is a pure function: it takes a `Device`, a
  `DeviceSignal` dataclass and the optional agent_online / agent report /
  ICMP booleans, and returns a `ResolvedStatus`. That makes the seven
  documented scenarios trivially unit-testable.
- Two thin DB readers (sync + async) collect the same `DeviceSignal`. The
  sync one is used by Celery (`poll_device_status`), the async one by the
  WS handler (`_handle_device_status_report`).
- A connectivity/auth failure that is NEWER than every telemetry success
  vetoes the freshness signal. Without that veto a fresh PoE snapshot
  taken before an auth-failed Fetch Info would falsely flip the device
  back to ONLINE.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.device import DeviceStatus

# --- Reason taxonomy --------------------------------------------------------

REASON_AGENT_REPORT = "agent_report"
REASON_FRESH_SSH = "fresh_ssh_telemetry"
REASON_FRESH_SNAPSHOT = "fresh_snapshot"
REASON_BACKEND_ICMP = "backend_icmp"
REASON_STALE_OR_UNKNOWN = "stale_or_unknown"

ALL_REASONS = (
    REASON_AGENT_REPORT,
    REASON_FRESH_SSH,
    REASON_FRESH_SNAPSHOT,
    REASON_BACKEND_ICMP,
    REASON_STALE_OR_UNKNOWN,
)


# --- Failure heuristic ------------------------------------------------------

# Substrings that mark a "meaningful" connectivity/auth failure. Matched
# case-insensitively against the SSH error string written into
# agent_command_logs.command (the redacted error blob the agent sends back).
# Anything in this set will veto a freshness signal that is older than the
# failure timestamp.
_CONNECTIVITY_FAILURE_TOKENS = (
    "auth_failed",
    "connection_timeout",
    "connection_reset",
    "enable_mode_failed",
    "authentication",
    "timed out",
    "unreachable",
    "no route",
    "connection refused",
    "name or service not known",
)


def _is_connectivity_failure(blob: Optional[str]) -> bool:
    """Heuristic — True when the error string is recognisably a
    connectivity or auth failure (and therefore a meaningful reason to
    distrust nearby telemetry). False for None / empty / quirky errors."""
    if not blob:
        return False
    needle = blob.lower()
    return any(t in needle for t in _CONNECTIVITY_FAILURE_TOKENS)


# --- Window helpers ---------------------------------------------------------

def telemetry_window_seconds() -> int:
    """Resolved at call-time so tests can monkey-patch settings."""
    return int(getattr(settings, "STATUS_TELEMETRY_FRESH_WINDOW_SECONDS", 600))


def agent_report_window_seconds() -> int:
    return int(getattr(settings, "STATUS_AGENT_REPORT_FRESH_WINDOW_SECONDS", 180))


def _telemetry_window() -> timedelta:
    return timedelta(seconds=telemetry_window_seconds())


# --- Data classes -----------------------------------------------------------

@dataclass(frozen=True)
class DeviceSignal:
    """The 'something happened' freshness snapshot for one device.

    Every timestamp is UTC; callers are expected to coerce naïve values
    (e.g. SQLite test fixtures) before constructing this. The resolver
    coerces defensively as well to keep tests on SQLite frictionless.
    """
    last_command_success_ts: Optional[datetime] = None
    last_command_failure_ts: Optional[datetime] = None
    last_command_failure_kind: Optional[str] = None  # "connectivity" | "other" | None
    last_poe_snapshot_ts: Optional[datetime] = None
    last_mac_snapshot_ts: Optional[datetime] = None


@dataclass(frozen=True)
class ResolvedStatus:
    """Outcome of one resolution call. The reason is a stable enum-like
    string from the taxonomy above; detail is unstructured supplemental
    context for logs / cache payload."""
    status: str
    reason: str
    detail: dict = field(default_factory=dict)


# --- Pure freshness computation ---------------------------------------------

def _ensure_utc(ts: Optional[datetime]) -> Optional[datetime]:
    if ts is None:
        return None
    if ts.tzinfo is None:
        return ts.replace(tzinfo=timezone.utc)
    return ts


def get_device_telemetry_freshness(
    device,
    signal: DeviceSignal,
    now: Optional[datetime] = None,
) -> dict:
    """Pure function — decide whether the device has fresh telemetry.

    Applies the failure-newer-than-success veto: a connectivity/auth
    failure newer than every candidate success blocks freshness.

    Returns:
        {
          "fresh": bool,
          "newest_success_ts": Optional[datetime],
          "newest_success_kind": Optional[str],  # "fresh_ssh_telemetry" |
                                                  #  "fresh_snapshot"     |
                                                  #  "fresh_last_seen"
          "blocking_failure_ts": Optional[datetime],
        }
    """
    now = now or datetime.now(timezone.utc)
    cutoff = now - _telemetry_window()

    last_seen = _ensure_utc(getattr(device, "last_seen", None))

    candidates = [
        ("fresh_ssh_telemetry", _ensure_utc(signal.last_command_success_ts)),
        ("fresh_last_seen", last_seen),
        ("fresh_snapshot", _ensure_utc(signal.last_poe_snapshot_ts)),
        ("fresh_snapshot", _ensure_utc(signal.last_mac_snapshot_ts)),
    ]

    newest_ts: Optional[datetime] = None
    newest_kind: Optional[str] = None
    for kind, ts in candidates:
        if ts is None or ts < cutoff:
            continue
        if newest_ts is None or ts > newest_ts:
            newest_ts = ts
            newest_kind = kind

    if newest_ts is None:
        return {
            "fresh": False,
            "newest_success_ts": None,
            "newest_success_kind": None,
            "blocking_failure_ts": None,
        }

    fail_ts = _ensure_utc(signal.last_command_failure_ts)
    if (
        fail_ts is not None
        and fail_ts > newest_ts
        and signal.last_command_failure_kind == "connectivity"
    ):
        return {
            "fresh": False,
            "newest_success_ts": newest_ts,
            "newest_success_kind": newest_kind,
            "blocking_failure_ts": fail_ts,
        }

    return {
        "fresh": True,
        "newest_success_ts": newest_ts,
        "newest_success_kind": newest_kind,
        "blocking_failure_ts": None,
    }


# --- DB readers -------------------------------------------------------------

def _signal_horizon(now: datetime) -> datetime:
    """Look back 2× the telemetry window so the resolver still sees the
    most recent failure even when it sits slightly outside the freshness
    window — important for the veto."""
    return now - _telemetry_window() * 2


def get_latest_device_signal(
    db: Session,
    device_id: int,
    now: Optional[datetime] = None,
) -> DeviceSignal:
    """Sync DB reader — used from Celery's `_check_device_reachable`."""
    now = now or datetime.now(timezone.utc)
    horizon = _signal_horizon(now)

    from app.models.agent_command_log import AgentCommandLog

    success_ts = db.execute(
        select(func.max(AgentCommandLog.executed_at)).where(
            AgentCommandLog.device_id == device_id,
            AgentCommandLog.success.is_(True),
            AgentCommandLog.executed_at >= horizon,
        )
    ).scalar_one_or_none()

    failure_row = db.execute(
        select(AgentCommandLog.executed_at, AgentCommandLog.command).where(
            AgentCommandLog.device_id == device_id,
            AgentCommandLog.success.is_(False),
            AgentCommandLog.executed_at >= horizon,
        ).order_by(AgentCommandLog.executed_at.desc()).limit(1)
    ).first()

    if failure_row is not None:
        failure_ts = failure_row[0]
        failure_kind = "connectivity" if _is_connectivity_failure(failure_row[1]) else "other"
    else:
        failure_ts = None
        failure_kind = None

    try:
        from app.models.poe_port_snapshot import PoEPortSnapshot
        poe_ts = db.execute(
            select(func.max(PoEPortSnapshot.updated_at)).where(
                PoEPortSnapshot.device_id == device_id,
                PoEPortSnapshot.updated_at >= horizon,
            )
        ).scalar_one_or_none()
    except Exception:
        poe_ts = None

    try:
        from app.models.mac_arp import MacAddressEntry
        mac_ts = db.execute(
            select(func.max(MacAddressEntry.last_seen)).where(
                MacAddressEntry.device_id == device_id,
                MacAddressEntry.last_seen >= horizon,
            )
        ).scalar_one_or_none()
    except Exception:
        mac_ts = None

    return DeviceSignal(
        last_command_success_ts=success_ts,
        last_command_failure_ts=failure_ts,
        last_command_failure_kind=failure_kind,
        last_poe_snapshot_ts=poe_ts,
        last_mac_snapshot_ts=mac_ts,
    )


async def get_latest_device_signal_async(
    db: AsyncSession,
    device_id: int,
    now: Optional[datetime] = None,
) -> DeviceSignal:
    """Async DB reader — used from `agent_manager._handle_device_status_report`."""
    now = now or datetime.now(timezone.utc)
    horizon = _signal_horizon(now)

    from app.models.agent_command_log import AgentCommandLog

    success_ts = (await db.execute(
        select(func.max(AgentCommandLog.executed_at)).where(
            AgentCommandLog.device_id == device_id,
            AgentCommandLog.success.is_(True),
            AgentCommandLog.executed_at >= horizon,
        )
    )).scalar_one_or_none()

    failure_row = (await db.execute(
        select(AgentCommandLog.executed_at, AgentCommandLog.command).where(
            AgentCommandLog.device_id == device_id,
            AgentCommandLog.success.is_(False),
            AgentCommandLog.executed_at >= horizon,
        ).order_by(AgentCommandLog.executed_at.desc()).limit(1)
    )).first()

    if failure_row is not None:
        failure_ts = failure_row[0]
        failure_kind = "connectivity" if _is_connectivity_failure(failure_row[1]) else "other"
    else:
        failure_ts = None
        failure_kind = None

    try:
        from app.models.poe_port_snapshot import PoEPortSnapshot
        poe_ts = (await db.execute(
            select(func.max(PoEPortSnapshot.updated_at)).where(
                PoEPortSnapshot.device_id == device_id,
                PoEPortSnapshot.updated_at >= horizon,
            )
        )).scalar_one_or_none()
    except Exception:
        poe_ts = None

    try:
        from app.models.mac_arp import MacAddressEntry
        mac_ts = (await db.execute(
            select(func.max(MacAddressEntry.last_seen)).where(
                MacAddressEntry.device_id == device_id,
                MacAddressEntry.last_seen >= horizon,
            )
        )).scalar_one_or_none()
    except Exception:
        mac_ts = None

    return DeviceSignal(
        last_command_success_ts=success_ts,
        last_command_failure_ts=failure_ts,
        last_command_failure_kind=failure_kind,
        last_poe_snapshot_ts=poe_ts,
        last_mac_snapshot_ts=mac_ts,
    )


# --- Core resolver ----------------------------------------------------------

def resolve_device_status(
    device,
    signal: DeviceSignal,
    *,
    agent_online: bool,
    agent_reachable_report: Optional[bool] = None,
    icmp_reachable: Optional[bool] = None,
    now: Optional[datetime] = None,
) -> ResolvedStatus:
    """Telemetry-aware device status resolution.

    Decision order (first match wins):
      1. agent_online + agent reports reachable=true       → ONLINE  (agent_report)
      2. agent_online + telemetry fresh                    → ONLINE  (fresh_*)
      3. agent_online + telemetry stale + reachable=false  → OFFLINE (agent_report)
      4. agent offline / no agent + icmp_reachable=true    → ONLINE  (backend_icmp)
      5. agent offline / no agent + icmp_reachable=false   → OFFLINE (backend_icmp)
      6. nothing actionable                                → preserve device.status
                                                              (stale_or_unknown)
    """
    now = now or datetime.now(timezone.utc)
    freshness = get_device_telemetry_freshness(device, signal, now=now)

    # 1.
    if agent_online and agent_reachable_report is True:
        return ResolvedStatus(
            status=DeviceStatus.ONLINE.value,
            reason=REASON_AGENT_REPORT,
            detail={"agent_reachable": True},
        )

    # 2.
    if agent_online and freshness["fresh"]:
        reason = (
            REASON_FRESH_SSH
            if freshness["newest_success_kind"] == "fresh_ssh_telemetry"
            else REASON_FRESH_SNAPSHOT
        )
        ts = freshness["newest_success_ts"]
        return ResolvedStatus(
            status=DeviceStatus.ONLINE.value,
            reason=reason,
            detail={
                "newest_success_ts": ts.isoformat() if ts else None,
                "newest_success_kind": freshness["newest_success_kind"],
            },
        )

    # 3.
    if agent_online and agent_reachable_report is False:
        block_ts = freshness.get("blocking_failure_ts")
        return ResolvedStatus(
            status=DeviceStatus.OFFLINE.value,
            reason=REASON_AGENT_REPORT,
            detail={
                "agent_reachable": False,
                "blocking_failure_ts": block_ts.isoformat() if block_ts else None,
            },
        )

    # 4 / 5.
    if icmp_reachable is True:
        return ResolvedStatus(
            status=DeviceStatus.ONLINE.value,
            reason=REASON_BACKEND_ICMP,
            detail={"icmp": True},
        )
    if icmp_reachable is False:
        return ResolvedStatus(
            status=DeviceStatus.OFFLINE.value,
            reason=REASON_BACKEND_ICMP,
            detail={"icmp": False},
        )

    # 6.
    return ResolvedStatus(
        status=getattr(device, "status", DeviceStatus.UNKNOWN.value),
        reason=REASON_STALE_OR_UNKNOWN,
        detail={},
    )
