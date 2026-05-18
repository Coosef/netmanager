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
