"""
Faz 6B G4 — cache_invalidation sync helpers + correlation_engine hook tests.

Coverage:
  * invalidate_for_event:
      - device_offline / online → DEL device key + INCR risk_fleet + INCR sla_fleet + dirty
      - device_flapping → DEL device key + INCR risk_fleet only (NOT sla_fleet)
      - synthetic probe types (port_down, dns_failure, etc.) → both fleets
      - unrelated event types → no-op
      - tenant_id provided → dirty:tenant SADD; omitted → no tenant SADD
  * invalidate_device_risk: DEL device key + INCR risk_fleet only
  * invalidate_all_fleet_caches: bumps BOTH versions
  * Redis errors are swallowed (caller never sees exception)
  * Dirty sets get their TTL refreshed on every SADD
  * correlation_engine.process_event calls invalidate_for_event on the hot path
"""
from unittest.mock import MagicMock

import pytest


# ── Fake sync redis ───────────────────────────────────────────────────────────

class FakeSyncRedis:
    """Minimal sync redis stub. Flip `down=True` to make every op raise."""

    def __init__(self):
        self.kv: dict[str, str] = {}
        self.sets: dict[str, set] = {}
        self.expiries: dict[str, int] = {}
        self.counters: dict[str, int] = {}
        self.calls: list[tuple] = []
        self.down = False

    def _check(self, op: str, *args):
        self.calls.append((op, *args))
        if self.down:
            raise __import__("redis").exceptions.RedisError("simulated down")

    def delete(self, key):
        self._check("delete", key)
        existed = key in self.kv
        self.kv.pop(key, None)
        self.sets.pop(key, None)
        return 1 if existed else 0

    def incr(self, key):
        self._check("incr", key)
        self.counters[key] = self.counters.get(key, 0) + 1
        return self.counters[key]

    def sadd(self, key, member):
        self._check("sadd", key, member)
        self.sets.setdefault(key, set()).add(member)
        return 1

    def expire(self, key, ttl):
        self._check("expire", key, ttl)
        self.expiries[key] = ttl
        return True


def _ops_only(fake_redis, op_name: str):
    """Filter recorded calls by op name."""
    return [call for call in fake_redis.calls if call[0] == op_name]


# ══════════════════════════════════════════════════════════════════════════════
# 1. invalidate_for_event — event_type dispatch
# ══════════════════════════════════════════════════════════════════════════════

class TestInvalidateForEvent:

    @pytest.mark.parametrize("event_type", ["device_offline", "device_online"])
    def test_device_state_change_invalidates_both_fleets(self, event_type):
        from app.services.cache_invalidation import invalidate_for_event
        r = FakeSyncRedis()
        invalidate_for_event(r, device_id=42, event_type=event_type)

        # Per-device risk key deleted
        assert ("delete", "agg:risk:device:42") in r.calls
        # Both fleet versions bumped
        assert r.counters["agg:_version:risk_fleet"] == 1
        assert r.counters["agg:_version:sla_fleet"] == 1
        # Device added to dirty set
        assert "42" in r.sets["agg:dirty:device"]

    def test_device_flapping_only_affects_risk(self):
        from app.services.cache_invalidation import invalidate_for_event
        r = FakeSyncRedis()
        invalidate_for_event(r, device_id=1, event_type="device_flapping")

        assert ("delete", "agg:risk:device:1") in r.calls
        assert r.counters["agg:_version:risk_fleet"] == 1
        assert "agg:_version:sla_fleet" not in r.counters, (
            "flapping changes flap_count but not uptime — sla_fleet must NOT bump"
        )

    @pytest.mark.parametrize("event_type", [
        "port_down", "service_unavailable", "dns_failure", "device_unreachable",
    ])
    def test_synthetic_probe_events_invalidate_both(self, event_type):
        from app.services.cache_invalidation import invalidate_for_event
        r = FakeSyncRedis()
        invalidate_for_event(r, device_id=7, event_type=event_type)
        assert r.counters["agg:_version:risk_fleet"] == 1
        assert r.counters["agg:_version:sla_fleet"] == 1

    def test_unrelated_event_is_noop(self):
        from app.services.cache_invalidation import invalidate_for_event
        r = FakeSyncRedis()
        invalidate_for_event(r, device_id=1, event_type="device_added")
        assert r.calls == []
        assert not r.counters

    def test_tenant_id_optional(self):
        from app.services.cache_invalidation import invalidate_for_event
        r = FakeSyncRedis()
        invalidate_for_event(r, device_id=5, event_type="device_offline", tenant_id=99)
        assert "99" in r.sets["agg:dirty:tenant"]

    def test_tenant_id_omitted_skips_tenant_set(self):
        from app.services.cache_invalidation import invalidate_for_event
        r = FakeSyncRedis()
        invalidate_for_event(r, device_id=5, event_type="device_offline")
        assert "agg:dirty:tenant" not in r.sets

    def test_dirty_set_gets_ttl_on_every_sadd(self):
        from app.services.cache_invalidation import invalidate_for_event
        r = FakeSyncRedis()
        invalidate_for_event(r, device_id=1, event_type="device_offline")
        invalidate_for_event(r, device_id=2, event_type="device_offline")
        # Two sadd calls → two expire calls (one per add)
        sadd_count = sum(1 for c in r.calls if c[0] == "sadd" and c[1] == "agg:dirty:device")
        expire_count = sum(1 for c in r.calls if c[0] == "expire" and c[1] == "agg:dirty:device")
        assert sadd_count == 2
        assert expire_count == 2


# ══════════════════════════════════════════════════════════════════════════════
# 2. invalidate_device_risk — non-event paths (backup, audit)
# ══════════════════════════════════════════════════════════════════════════════

class TestInvalidateDeviceRisk:

    def test_invalidates_only_risk_not_sla(self):
        from app.services.cache_invalidation import invalidate_device_risk
        r = FakeSyncRedis()
        invalidate_device_risk(r, device_id=42)
        assert ("delete", "agg:risk:device:42") in r.calls
        assert r.counters["agg:_version:risk_fleet"] == 1
        assert "agg:_version:sla_fleet" not in r.counters

    def test_dirty_marker_set(self):
        from app.services.cache_invalidation import invalidate_device_risk
        r = FakeSyncRedis()
        invalidate_device_risk(r, device_id=42, tenant_id=7)
        assert "42" in r.sets["agg:dirty:device"]
        assert "7" in r.sets["agg:dirty:tenant"]


# ══════════════════════════════════════════════════════════════════════════════
# 3. invalidate_all_fleet_caches — device CRUD path
# ══════════════════════════════════════════════════════════════════════════════

class TestInvalidateAllFleetCaches:

    def test_bumps_both_versions(self):
        from app.services.cache_invalidation import invalidate_all_fleet_caches
        r = FakeSyncRedis()
        invalidate_all_fleet_caches(r)
        assert r.counters["agg:_version:risk_fleet"] == 1
        assert r.counters["agg:_version:sla_fleet"] == 1

    def test_no_per_device_delete(self):
        from app.services.cache_invalidation import invalidate_all_fleet_caches
        r = FakeSyncRedis()
        invalidate_all_fleet_caches(r)
        # No per-device key, no dirty marker — this is a fleet-only operation
        assert all(c[0] != "delete" for c in r.calls)
        assert all(c[0] != "sadd" for c in r.calls)


# ══════════════════════════════════════════════════════════════════════════════
# 4. Redis errors never escape
# ══════════════════════════════════════════════════════════════════════════════

class TestRedisErrorIsolation:

    def test_invalidate_for_event_swallows_redis_down(self):
        from app.services.cache_invalidation import invalidate_for_event
        r = FakeSyncRedis()
        r.down = True
        # Must not raise
        invalidate_for_event(r, device_id=1, event_type="device_offline")

    def test_invalidate_device_risk_swallows_redis_down(self):
        from app.services.cache_invalidation import invalidate_device_risk
        r = FakeSyncRedis()
        r.down = True
        invalidate_device_risk(r, device_id=1)

    def test_invalidate_all_fleet_swallows_redis_down(self):
        from app.services.cache_invalidation import invalidate_all_fleet_caches
        r = FakeSyncRedis()
        r.down = True
        invalidate_all_fleet_caches(r)


# ══════════════════════════════════════════════════════════════════════════════
# 5. correlation_engine integration
# ══════════════════════════════════════════════════════════════════════════════

class TestCorrelationEngineHook:
    """The hot path — process_event must call invalidate_for_event at the end."""

    @pytest.mark.asyncio
    async def test_process_event_invalidates_on_problem_path(self, monkeypatch):
        from app.services import correlation_engine

        # Stub _handle_problem so we don't need the full incident machinery
        called = {}
        async def stub_problem(*args, **kwargs):
            called["problem"] = True
            return None
        monkeypatch.setattr(correlation_engine, "_handle_problem", stub_problem)

        # Capture invalidation
        invalidation_calls = []
        def stub_inv(redis_client, device_id, event_type, tenant_id=None):
            invalidation_calls.append((device_id, event_type))

        # Inject our stub into the module's namespace BEFORE process_event imports it
        monkeypatch.setattr(
            "app.services.cache_invalidation.invalidate_for_event", stub_inv,
        )

        # Minimal fake redis + db
        sync_redis = MagicMock()
        sync_redis.incr.return_value = 1   # flap_count == 1 (below threshold)
        sync_redis.expire.return_value = True

        db = MagicMock()
        result = MagicMock()
        result.scalar_one_or_none.return_value = None
        async def _exec(*a, **kw):
            return result
        db.execute = _exec

        await correlation_engine.process_event(
            device_id=11,
            event_type="device_offline",
            component="device",
            source="snmp",
            is_problem=True,
            db=db,
            sync_redis=sync_redis,
        )

        assert called.get("problem") is True
        assert (11, "device_offline") in invalidation_calls

    @pytest.mark.asyncio
    async def test_process_event_invalidation_failure_does_not_break_correlation(
        self, monkeypatch,
    ):
        """If invalidate_for_event raises, process_event must still return its result."""
        from app.services import correlation_engine

        async def stub_problem(*args, **kwargs):
            return "SENTINEL_INCIDENT"
        monkeypatch.setattr(correlation_engine, "_handle_problem", stub_problem)

        def raising_inv(*args, **kwargs):
            raise RuntimeError("simulated invalidation crash")
        monkeypatch.setattr(
            "app.services.cache_invalidation.invalidate_for_event", raising_inv,
        )

        sync_redis = MagicMock()
        sync_redis.incr.return_value = 1
        sync_redis.expire.return_value = True

        db = MagicMock()
        result = MagicMock()
        result.scalar_one_or_none.return_value = None
        async def _exec(*a, **kw):
            return result
        db.execute = _exec

        # Must not raise; must return the handler's value
        out = await correlation_engine.process_event(
            device_id=1,
            event_type="device_offline",
            component="device",
            source="snmp",
            is_problem=True,
            db=db,
            sync_redis=sync_redis,
        )
        assert out == "SENTINEL_INCIDENT"


# ══════════════════════════════════════════════════════════════════════════════
# 6. Event-type coverage (regression guard)
# ══════════════════════════════════════════════════════════════════════════════

class TestEventTypeCoverage:

    def test_known_event_types_are_covered(self):
        """If a new event_type is added without invalidation, this test flags it.

        Adjust the expected set when intentionally adding/removing coverage.
        """
        from app.services.cache_invalidation import invalidate_for_event_types
        expected = {
            "device_offline", "device_online", "device_flapping",
            "device_unreachable", "port_down", "service_unavailable", "dns_failure",
        }
        assert invalidate_for_event_types() == expected
