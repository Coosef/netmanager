"""Org-scoped realtime event publishing — Faz 7 phase 6d.

Network events and anomalies are published to PER-ORGANIZATION Redis
channels. A WebSocket connection subscribes only to its own org's
channel, so a cross-org realtime frame is never delivered to the
socket — isolation holds at the pub/sub layer, not as an after-the-fact
filter on a shared channel.

    network:events:org:{org}             per-org event channel
    network:events:recent:org:{org}      per-org replay list (last 500)
    anomalies:org:{org}                  per-org anomaly channel

The org (and location) are resolved from the payload's device_id. An
event with no resolvable device/org goes to the '{org}=admin' channel,
which only super-admin connections subscribe to.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from typing import Optional, Union

import redis as _redis_sync

from app.core.config import settings

log = logging.getLogger("netmanager.event_publish")

_ADMIN = "admin"          # channel suffix for org-less / system events
_CACHE_TTL = 120.0        # device → (org, loc) cache lifetime, seconds
_RECENT_MAX = 499

# device_id → (org_suffix, location_id, expiry_monotonic)
_scope_cache: dict[int, tuple[str, Optional[int], float]] = {}

_sync_client: Optional[_redis_sync.Redis] = None


def _sync_redis() -> _redis_sync.Redis:
    """Process-wide sync Redis client — for async callers that publish via
    a thread and for any site without its own client."""
    global _sync_client
    if _sync_client is None:
        _sync_client = _redis_sync.from_url(
            settings.REDIS_URL, decode_responses=True,
            socket_connect_timeout=5, socket_timeout=5,
        )
    return _sync_client


def _resolve_scope(device_id) -> tuple[str, Optional[int]]:
    """Map a device_id to (org-channel-suffix, location_id). Cached. A
    missing / unknown device resolves to the admin (super-admin) channel."""
    if not device_id:
        return _ADMIN, None
    now = time.monotonic()
    hit = _scope_cache.get(device_id)
    if hit and hit[2] > now:
        return hit[0], hit[1]

    org_suffix, loc_id = _ADMIN, None
    try:
        from sqlalchemy import text
        from app.core.database import SyncSessionLocal
        from app.core.org_context import superadmin_context
        # superadmin_context bypasses RLS — this is a system-level lookup.
        with superadmin_context(), SyncSessionLocal() as db:
            row = db.execute(
                text("SELECT organization_id, location_id "
                     "FROM devices WHERE id = :i"),
                {"i": device_id},
            ).first()
        if row is not None:
            if row[0] is not None:
                org_suffix = str(row[0])
            loc_id = row[1]
    except Exception:
        log.exception("event_publish: scope lookup failed for device %s",
                       device_id)

    _scope_cache[device_id] = (org_suffix, loc_id, now + _CACHE_TTL)
    return org_suffix, loc_id


def _publish(channel_base: str, payload: Union[dict, str], redis_client,
             keep_recent: bool, organization_id: Optional[int],
             location_id: Optional[int]) -> None:
    data = json.loads(payload) if isinstance(payload, str) else dict(payload)
    if organization_id is not None:
        # Caller knows the org (e.g. an agent-scoped, device-less event).
        org_suffix, loc_id = str(organization_id), location_id
    else:
        org_suffix, loc_id = _resolve_scope(data.get("device_id"))
    data["organization_id"] = None if org_suffix == _ADMIN else int(org_suffix)
    if loc_id is not None and data.get("location_id") is None:
        data["location_id"] = loc_id
    raw = json.dumps(data)
    r = redis_client or _sync_redis()
    try:
        r.publish(f"{channel_base}:org:{org_suffix}", raw)
        if keep_recent:
            key = f"{channel_base}:recent:org:{org_suffix}"
            r.lpush(key, raw)
            r.ltrim(key, 0, _RECENT_MAX)
    except Exception:
        log.exception("event_publish: publish to %s failed", channel_base)


def publish_network_event(payload: Union[dict, str], redis_client=None, *,
                           organization_id: Optional[int] = None,
                           location_id: Optional[int] = None) -> None:
    """Publish a network event to its organization's channel + replay list.
    `payload` may be a dict or an already-encoded JSON string. Pass
    organization_id explicitly for device-less (e.g. agent-scoped) events."""
    _publish("network:events", payload, redis_client, True,
             organization_id, location_id)


def publish_anomaly(payload: Union[dict, str], redis_client=None, *,
                     organization_id: Optional[int] = None,
                     location_id: Optional[int] = None) -> None:
    """Publish an anomaly to its organization's channel."""
    _publish("anomalies", payload, redis_client, False,
             organization_id, location_id)


# Topology realtime event types — carried on the per-org network:events
# channel so the topology UI can patch its graph incrementally instead of
# polling. The frontend filters frames whose event_type starts "topology_".
TOPOLOGY_EVENT_TYPES = (
    "topology_links_updated",   # a discovery run changed links
    "topology_node_added",      # a device entered the topology
    "topology_node_removed",    # a device left the topology
    "topology_node_updated",    # a device's attributes/status changed
    "topology_edge_added",      # a link appeared
    "topology_edge_removed",    # a link disappeared
    "topology_edge_updated",    # a link's metrics changed
    "topology_drift",           # current topology diverged from the golden snapshot
)


def _graphver_key(organization_id: int) -> str:
    return f"topology:graphver:o={organization_id}"


def get_topology_graph_version(organization_id: int, redis_client=None) -> int:
    """Current monotonic topology graph version for an org. The v2 graph
    response carries this; every topology realtime event carries the next
    value, so the frontend can detect a missed patch and full-refetch."""
    r = redis_client or _sync_redis()
    try:
        v = r.get(_graphver_key(organization_id))
        return int(v) if v is not None else 0
    except Exception:
        return 0


def bump_topology_graph_version(organization_id: int, redis_client=None) -> int:
    """Increment and return the org's topology graph version — called by
    any flow that mutates the topology (discovery, link save, drift)."""
    r = redis_client or _sync_redis()
    try:
        return int(r.incr(_graphver_key(organization_id)))
    except Exception:
        return 0


def publish_topology_event(event_type: str, organization_id: int,
                           redis_client=None, *, location_id: Optional[int] = None,
                           **extra) -> None:
    """Publish a dedicated topology realtime event to an organization's
    channel. `event_type` should be one of TOPOLOGY_EVENT_TYPES. The org
    is explicit (topology events are often device-less / fleet-level), so
    isolation never depends on device_id resolution.

    Every event bumps and carries the org's `graph_version` — the v2 graph
    response exposes the same counter, giving the frontend a sequence it
    can reconcile against (a gap ⇒ full refetch)."""
    r = redis_client  # may be None → helpers fall back to _sync_redis()
    graph_version = bump_topology_graph_version(organization_id, r)
    payload = {
        "event_type": event_type,
        "severity": extra.pop("severity", "info"),
        "ts": datetime.now(timezone.utc).isoformat(),
        "graph_version": graph_version,
        **extra,
    }
    publish_network_event(payload, r,
                          organization_id=organization_id, location_id=location_id)
