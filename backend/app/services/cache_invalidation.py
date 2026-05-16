"""
Sync cache invalidation helpers — Faz 6B G4

Called from Celery worker hot paths (correlation_engine, backup tasks,
security audit tasks, bulk operations) to invalidate the Faz 6B
aggregation cache entries:

  agg:risk:device:{id}         — per-device risk score cache
  agg:_version:risk_fleet      — INCR'd to invalidate ALL fleet risk keys
  agg:_version:sla_fleet       — INCR'd to invalidate ALL fleet SLA keys
  agg:dirty:device             — SET of device_ids needing rebuild
  agg:dirty:tenant             — SET of tenant_ids needing rebuild (optional)

All operations:
  * are SYNC (called from Celery workers, never block an event loop here)
  * are wrapped in try/except — Redis errors NEVER propagate to the caller
  * use the sync redis.Redis client that was already constructed with
    socket_timeout=5 by agent_manager._get_sync_redis (callers pass it in)

Designed so cache invalidation can never break the correlation flow or
the task that triggered it. Worst case: cache serves slightly stale data
until TTL or the next event triggers another invalidation.

Versioning model (NOT pattern-DELETE):
  Fleet caches use a key that includes a version segment:
      agg:sla:fleet:v={ver}:t={tenant}:loc={hash}:w={d}:s={site}
  Bumping the version makes every previous key effectively dead — readers
  compose a new key on next request. Old keys fall out via their TTL.
  This avoids expensive SCAN+DEL on every device CRUD.
"""
from __future__ import annotations

import logging
from typing import Optional

log = logging.getLogger(__name__)

# Key constants — mirror app/services/cache.py and the endpoint code.
_RISK_DEVICE_KEY = "agg:risk:device:{device_id}"
_SLA_FLEET_VERSION = "agg:_version:sla_fleet"
_RISK_FLEET_VERSION = "agg:_version:risk_fleet"
_DIRTY_DEVICE_SET = "agg:dirty:device"
_DIRTY_TENANT_SET = "agg:dirty:tenant"

# Safety net: dirty sets auto-expire so a stalled warmer doesn't accumulate
# unbounded membership. Warmer runs every 60s (G5) so 10 min is plenty.
_DIRTY_SET_TTL_SECS = 600

# Event types that change uptime / flap inputs of the risk and sla aggregations.
_RISK_INVALIDATING_EVENTS = frozenset({
    "device_offline", "device_online", "device_flapping",
    # Synthetic probe events — affect uptime component of risk
    "device_unreachable", "port_down", "service_unavailable", "dns_failure",
})
_SLA_INVALIDATING_EVENTS = frozenset({
    "device_offline", "device_online",
    "device_unreachable", "port_down", "service_unavailable", "dns_failure",
})


# ── Public API ────────────────────────────────────────────────────────────────

def invalidate_for_event(
    sync_redis,
    device_id: int,
    event_type: str,
    tenant_id: Optional[int] = None,
) -> None:
    """
    Invalidate aggregation cache for a network event.

    Called from `correlation_engine.process_event` after the event has been
    classified. Decides per event_type which scopes to invalidate:

      device_offline / device_online   → risk + sla (uptime changed)
      device_flapping                  → risk only  (flap count changed)
      synthetic probe events           → risk + sla (uptime via probe)
      anything else                    → no-op

    Never raises. Errors logged at DEBUG so they do not flood production logs.
    """
    affects_risk = event_type in _RISK_INVALIDATING_EVENTS
    affects_sla = event_type in _SLA_INVALIDATING_EVENTS
    if not (affects_risk or affects_sla):
        return

    if affects_risk:
        # Per-device delete is NOT debounced — cheap, and the single-device
        # endpoint must stay correct. Fleet version bump IS debounced.
        _try_delete(sync_redis, _RISK_DEVICE_KEY.format(device_id=device_id))
        _bump_fleet_version_debounced(sync_redis, _RISK_FLEET_VERSION)
    if affects_sla:
        _bump_fleet_version_debounced(sync_redis, _SLA_FLEET_VERSION)

    _mark_dirty(sync_redis, device_id, tenant_id)


def invalidate_device_risk(
    sync_redis,
    device_id: int,
    tenant_id: Optional[int] = None,
) -> None:
    """
    Invalidate ONLY the per-device risk cache + bump risk-fleet version.

    Use when a device's risk inputs change without a network event:
      - Backup completed       → backup_risk component changed
      - Security audit done    → compliance_risk component changed

    SLA fleet cache is NOT bumped here — uptime is unaffected.
    """
    _try_delete(sync_redis, _RISK_DEVICE_KEY.format(device_id=device_id))
    _bump_fleet_version_debounced(sync_redis, _RISK_FLEET_VERSION)
    _mark_dirty(sync_redis, device_id, tenant_id)


def invalidate_all_fleet_caches(sync_redis) -> None:
    """
    Bump BOTH fleet version counters. Use when device CRUD invalidates every
    fleet-scoped cache (insert/delete/site change/tenant change/is_active flip).

    NOT debounced — device CRUD is rare and admin-initiated; the new device
    must show up immediately.
    """
    _try_incr(sync_redis, _SLA_FLEET_VERSION)
    _try_incr(sync_redis, _RISK_FLEET_VERSION)


def invalidate_for_event_types() -> frozenset[str]:
    """Expose event_type set so tests can assert coverage without importing privates."""
    return _RISK_INVALIDATING_EVENTS | _SLA_INVALIDATING_EVENTS


# ── Internals ─────────────────────────────────────────────────────────────────

def _mark_dirty(sync_redis, device_id: int, tenant_id: Optional[int]) -> None:
    _try_sadd_with_ttl(sync_redis, _DIRTY_DEVICE_SET, str(device_id))
    if tenant_id is not None:
        _try_sadd_with_ttl(sync_redis, _DIRTY_TENANT_SET, str(tenant_id))


def _try_delete(sync_redis, key: str) -> None:
    try:
        sync_redis.delete(key)
    except Exception as exc:
        log.debug("cache-invalidate: del %s failed — %s", key, exc)


def _try_incr(sync_redis, key: str) -> None:
    try:
        sync_redis.incr(key)
    except Exception as exc:
        log.debug("cache-invalidate: incr %s failed — %s", key, exc)


def _bump_fleet_version_debounced(sync_redis, version_key: str) -> None:
    """
    INCR the fleet version at most once per debounce window.

    A guard key (`<version_key>:debounce`) is SET NX EX <window>. Only the
    event that wins the SETNX — the first in the window — performs the INCR;
    every other event in the window is coalesced into that single bump.

    Effect: under a burst of device events the fleet cache key stays stable
    instead of being killed on every event, so reads keep hitting the cache.
    Trade-off: at most ~<window> seconds of added staleness on fleet data,
    which the cache warmer then refreshes anyway.
    """
    from app.core.config import settings

    window = settings.AGG_CACHE_INVALIDATION_DEBOUNCE_SECS
    if window <= 0:
        # Debounce disabled — behave like the plain INCR.
        _try_incr(sync_redis, version_key)
        return

    guard_key = f"{version_key}:debounce"
    try:
        first_in_window = sync_redis.set(guard_key, "1", nx=True, ex=window)
        if first_in_window:
            sync_redis.incr(version_key)
    except Exception as exc:
        log.debug("cache-invalidate: debounced bump %s failed — %s", version_key, exc)


def _try_sadd_with_ttl(sync_redis, set_key: str, member: str) -> None:
    try:
        sync_redis.sadd(set_key, member)
        # Refresh TTL on every add so a continuously-fed set never expires.
        sync_redis.expire(set_key, _DIRTY_SET_TTL_SECS)
    except Exception as exc:
        log.debug("cache-invalidate: sadd %s+%s failed — %s", set_key, member, exc)
