"""Telemetry-aware device status resolver — scenario coverage.

The resolver lives at `app.services.device_status_resolver`. Every test
here exercises the pure resolution branch through a hand-built
`DeviceSignal` so we avoid the DB layer entirely; the sync/async DB
readers are exercised indirectly by their callers (poll_device_status,
_handle_device_status_report) in their own test suites.

Scenarios (operator brief):
  1. Agent online + DB status offline + fresh successful SSH command  → ONLINE
  2. Agent online + DB status offline + fresh PoE/VLAN/MAC telemetry  → ONLINE
  3. Agent online + stale telemetry + reachable=false agent report    → OFFLINE
  4. Agent offline + backend ICMP succeeds                            → ONLINE
  5. Agent offline + backend ICMP fails                               → OFFLINE
  6. Fresh telemetry exists but newer connectivity failure exists     → respect OFFLINE
  7. Existing agentless device behavior (regression — no false-positive ONLINE)
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.models.device import DeviceStatus
from app.services.device_status_resolver import (
    DeviceSignal,
    REASON_AGENT_REPORT,
    REASON_BACKEND_ICMP,
    REASON_FRESH_SNAPSHOT,
    REASON_FRESH_SSH,
    REASON_STALE_OR_UNKNOWN,
    get_device_telemetry_freshness,
    resolve_device_status,
)


# ── Helpers ────────────────────────────────────────────────────────────────

NOW = datetime(2026, 6, 29, 12, 0, 0, tzinfo=timezone.utc)


def make_device(status: str = DeviceStatus.OFFLINE.value, last_seen=None):
    """Lightweight Device-like duck — the resolver only reads .status and
    .last_seen. Using a Device row directly would drag the whole ORM in."""
    return SimpleNamespace(
        id=42,
        status=status,
        last_seen=last_seen,
    )


def fresh_signal(success_offset_s: int = 60) -> DeviceSignal:
    """A DeviceSignal whose newest success is `success_offset_s` ago."""
    return DeviceSignal(
        last_command_success_ts=NOW - timedelta(seconds=success_offset_s),
        last_command_failure_ts=None,
        last_command_failure_kind=None,
        last_poe_snapshot_ts=None,
        last_mac_snapshot_ts=None,
    )


def fresh_snapshot_signal(snapshot_offset_s: int = 60, kind: str = "poe") -> DeviceSignal:
    """A DeviceSignal whose newest success is a PoE or MAC snapshot."""
    ts = NOW - timedelta(seconds=snapshot_offset_s)
    return DeviceSignal(
        last_command_success_ts=None,
        last_command_failure_ts=None,
        last_command_failure_kind=None,
        last_poe_snapshot_ts=ts if kind == "poe" else None,
        last_mac_snapshot_ts=ts if kind == "mac" else None,
    )


def stale_signal() -> DeviceSignal:
    """A DeviceSignal with all timestamps outside the telemetry window."""
    far = NOW - timedelta(hours=2)
    return DeviceSignal(
        last_command_success_ts=far,
        last_command_failure_ts=None,
        last_command_failure_kind=None,
        last_poe_snapshot_ts=far,
        last_mac_snapshot_ts=far,
    )


# ── 1. Agent online + DB offline + fresh SSH success → ONLINE ──────────────

def test_agent_online_fresh_ssh_recovers_offline():
    device = make_device(status=DeviceStatus.OFFLINE.value)
    signal = fresh_signal(success_offset_s=120)  # 2 min ago, inside 10 min window
    resolved = resolve_device_status(
        device, signal,
        agent_online=True,
        agent_reachable_report=None,
        icmp_reachable=None,
        now=NOW,
    )
    assert resolved.status == DeviceStatus.ONLINE.value
    assert resolved.reason == REASON_FRESH_SSH


# ── 2. Agent online + DB offline + fresh PoE / MAC snapshot → ONLINE ───────

@pytest.mark.parametrize("kind", ["poe", "mac"])
def test_agent_online_fresh_snapshot_recovers_offline(kind):
    device = make_device(status=DeviceStatus.OFFLINE.value)
    signal = fresh_snapshot_signal(snapshot_offset_s=120, kind=kind)
    resolved = resolve_device_status(
        device, signal,
        agent_online=True,
        agent_reachable_report=None,
        icmp_reachable=None,
        now=NOW,
    )
    assert resolved.status == DeviceStatus.ONLINE.value
    assert resolved.reason == REASON_FRESH_SNAPSHOT


# ── 3. Agent online + stale telemetry + reachable=false → OFFLINE ──────────

def test_agent_online_stale_with_unreachable_report_is_offline():
    device = make_device(status=DeviceStatus.ONLINE.value)
    signal = stale_signal()
    resolved = resolve_device_status(
        device, signal,
        agent_online=True,
        agent_reachable_report=False,
        icmp_reachable=None,
        now=NOW,
    )
    assert resolved.status == DeviceStatus.OFFLINE.value
    assert resolved.reason == REASON_AGENT_REPORT


# ── 4. Agent offline + backend ICMP succeeds → ONLINE ──────────────────────

def test_agentless_icmp_success_is_online():
    device = make_device(status=DeviceStatus.OFFLINE.value)
    signal = DeviceSignal()  # empty — agentless devices have no agent_command_logs
    resolved = resolve_device_status(
        device, signal,
        agent_online=False,
        agent_reachable_report=None,
        icmp_reachable=True,
        now=NOW,
    )
    assert resolved.status == DeviceStatus.ONLINE.value
    assert resolved.reason == REASON_BACKEND_ICMP


# ── 5. Agent offline + backend ICMP fails → OFFLINE ────────────────────────

def test_agentless_icmp_failure_is_offline():
    device = make_device(status=DeviceStatus.ONLINE.value)
    signal = DeviceSignal()
    resolved = resolve_device_status(
        device, signal,
        agent_online=False,
        agent_reachable_report=None,
        icmp_reachable=False,
        now=NOW,
    )
    assert resolved.status == DeviceStatus.OFFLINE.value
    assert resolved.reason == REASON_BACKEND_ICMP


# ── 6. Fresh telemetry + newer connectivity failure → no false ONLINE ──────

def test_fresh_success_then_newer_connectivity_failure_is_vetoed():
    """The resolver must not flip ONLINE just because a recent PoE
    snapshot exists when a newer auth/connectivity failure proves the
    device is in fact unreachable right now."""
    device = make_device(status=DeviceStatus.OFFLINE.value)
    success_ts = NOW - timedelta(seconds=240)            # 4 min ago — fresh
    failure_ts = NOW - timedelta(seconds=60)             # 1 min ago — NEWER
    signal = DeviceSignal(
        last_command_success_ts=success_ts,
        last_command_failure_ts=failure_ts,
        last_command_failure_kind="connectivity",
        last_poe_snapshot_ts=success_ts,                 # fresh snapshot too
        last_mac_snapshot_ts=None,
    )
    freshness = get_device_telemetry_freshness(device, signal, now=NOW)
    assert freshness["fresh"] is False, (
        "newer connectivity failure must veto fresh telemetry"
    )
    assert freshness["blocking_failure_ts"] == failure_ts

    # And the resolver must NOT flip back to ONLINE.
    resolved = resolve_device_status(
        device, signal,
        agent_online=True,
        agent_reachable_report=False,
        icmp_reachable=None,
        now=NOW,
    )
    assert resolved.status == DeviceStatus.OFFLINE.value
    assert resolved.reason == REASON_AGENT_REPORT
    assert resolved.detail.get("blocking_failure_ts") is not None


def test_non_connectivity_failure_does_not_veto():
    """A 'best-effort' failure (e.g. a quirky CLI parse error stamped as
    success=False) must NOT veto fresh telemetry — only recognisable
    connectivity / auth failures do."""
    device = make_device(status=DeviceStatus.OFFLINE.value)
    success_ts = NOW - timedelta(seconds=240)
    failure_ts = NOW - timedelta(seconds=60)
    signal = DeviceSignal(
        last_command_success_ts=success_ts,
        last_command_failure_ts=failure_ts,
        last_command_failure_kind="other",
        last_poe_snapshot_ts=None,
        last_mac_snapshot_ts=None,
    )
    freshness = get_device_telemetry_freshness(device, signal, now=NOW)
    assert freshness["fresh"] is True, (
        "a non-connectivity failure must NOT block freshness"
    )


# ── 7. Agentless regression — no false ONLINE without ICMP signal ─────────

def test_agentless_without_icmp_preserves_status():
    """The agentless path must NOT use telemetry as a recovery signal —
    the agentless poll always pings, so the resolver should NEVER be
    called with both agent_online=False and icmp_reachable=None in
    production. Make the contract explicit anyway: when neither side
    presents a signal, fall through to stale_or_unknown."""
    device = make_device(status=DeviceStatus.OFFLINE.value)
    signal = fresh_signal(success_offset_s=120)
    resolved = resolve_device_status(
        device, signal,
        agent_online=False,
        agent_reachable_report=None,
        icmp_reachable=None,
        now=NOW,
    )
    # The previous behaviour stays: offline stays offline.
    assert resolved.status == DeviceStatus.OFFLINE.value
    assert resolved.reason == REASON_STALE_OR_UNKNOWN


# ── Extra: agent_report=True always wins over freshness ───────────────────

def test_agent_report_reachable_true_dominates_freshness():
    """When the agent positively reports the device reachable, the
    resolver MUST report ONLINE with reason=agent_report — even if no
    telemetry is fresh — because the agent itself just measured it."""
    device = make_device(status=DeviceStatus.OFFLINE.value)
    signal = stale_signal()
    resolved = resolve_device_status(
        device, signal,
        agent_online=True,
        agent_reachable_report=True,
        icmp_reachable=None,
        now=NOW,
    )
    assert resolved.status == DeviceStatus.ONLINE.value
    assert resolved.reason == REASON_AGENT_REPORT


# ── QA precedence fix (PR #121 signal precedence review) ──────────────────
#
# The first revision of the resolver placed the "fresh telemetry" rule
# BEFORE the "agent reports reachable=false" rule. That meant a fresh
# successful SSH command from 60 s ago could overrule the agent's
# right-now reachable=false probe — producing a false-positive ONLINE on
# cable pulls, reboots and WS blips. The fix is a single-block reorder
# in resolve_device_status; these tests pin the new precedence so a
# future refactor cannot silently bring the bug back.

def test_unreachable_report_overrules_fresh_telemetry():
    """Signal precedence regression: an explicit reachable=false MUST win
    over fresh telemetry, because the agent report is — by construction —
    the newest reachability measurement available.

    Setup mirrors the operator's worst-case timeline: a successful SSH
    command ~60 s ago AND a fresh PoE snapshot, with the agent now
    reporting the device unreachable. The previous (buggy) rule order
    returned ONLINE here; the fix returns OFFLINE / agent_report."""
    device = make_device(status=DeviceStatus.ONLINE.value)
    success_ts = NOW - timedelta(seconds=60)
    poe_ts = NOW - timedelta(seconds=45)
    signal = DeviceSignal(
        last_command_success_ts=success_ts,
        last_command_failure_ts=None,
        last_command_failure_kind=None,
        last_poe_snapshot_ts=poe_ts,
        last_mac_snapshot_ts=None,
    )
    resolved = resolve_device_status(
        device, signal,
        agent_online=True,
        agent_reachable_report=False,
        icmp_reachable=None,
        now=NOW,
    )
    assert resolved.status == DeviceStatus.OFFLINE.value
    assert resolved.reason == REASON_AGENT_REPORT
    # The suppressed-but-real fresh success is exposed via detail for
    # debug; that contract is part of the precedence fix.
    assert resolved.detail.get("agent_reachable") is False
    assert resolved.detail.get("suppressed_fresh_success_ts") is not None


def test_newer_success_after_older_connectivity_failure_is_online():
    """Symmetric guard for the precedence fix: when no agent report is
    in flight (poll path → agent_reachable_report=None), a successful
    telemetry result that is NEWER than the most recent connectivity
    failure must lift the device back to ONLINE. The failure-newer-than-
    success veto only fires when the failure is the latest event."""
    device = make_device(status=DeviceStatus.OFFLINE.value)
    old_failure_ts = NOW - timedelta(seconds=300)   # 5 min ago — older
    new_success_ts = NOW - timedelta(seconds=60)    # 1 min ago — newer
    signal = DeviceSignal(
        last_command_success_ts=new_success_ts,
        last_command_failure_ts=old_failure_ts,
        last_command_failure_kind="connectivity",
        last_poe_snapshot_ts=None,
        last_mac_snapshot_ts=None,
    )
    # Sanity check the freshness helper first.
    freshness = get_device_telemetry_freshness(device, signal, now=NOW)
    assert freshness["fresh"] is True
    assert freshness["blocking_failure_ts"] is None

    # And the resolver, with no agent report this turn.
    resolved = resolve_device_status(
        device, signal,
        agent_online=True,
        agent_reachable_report=None,
        icmp_reachable=None,
        now=NOW,
    )
    assert resolved.status == DeviceStatus.ONLINE.value
    assert resolved.reason == REASON_FRESH_SSH


# ── Extra: stale_or_unknown preserves last status ─────────────────────────

def test_stale_or_unknown_preserves_status():
    device = make_device(status=DeviceStatus.UNREACHABLE.value)
    resolved = resolve_device_status(
        device,
        stale_signal(),
        agent_online=True,
        agent_reachable_report=None,
        icmp_reachable=None,
        now=NOW,
    )
    assert resolved.status == DeviceStatus.UNREACHABLE.value
    assert resolved.reason == REASON_STALE_OR_UNKNOWN
