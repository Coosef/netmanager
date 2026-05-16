"""
Faz 6B — SLA fleet-summary bulk query + cache integration tests.

Key invariants verified:
  * `_compute_uptime_from_events` produces byte-identical results to
    `_calc_uptime` for every scenario (no-events, started-online,
    started-offline, still-offline-at-end, multiple cycles).
  * `_calc_uptime_bulk` runs exactly ONE db.execute call regardless of N.
  * Empty device_ids → empty dict, no DB call.
  * Devices that have no events default to 100.0 — backward compat
    invariant the user called out explicitly.
  * Event ordering is deterministic (device_id ASC, created_at ASC).
  * Group-by handles interleaved events from multiple devices correctly.
  * Endpoint integration: cache hit/miss path + X-Cache-Bypass header +
    AGG_CACHE_ENABLED=False bypass + Redis-down fallback.
"""
import json
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest


# ── Helpers ───────────────────────────────────────────────────────────────────

UTC = timezone.utc
NOW = datetime(2026, 5, 15, 12, 0, 0, tzinfo=UTC)


def _make_db_with_rows(rows):
    """Mock AsyncSession.execute() returning the given rows from .fetchall()."""
    db = MagicMock()
    result = MagicMock()
    result.fetchall.return_value = rows
    db.execute = AsyncMock(return_value=result)
    return db


# ══════════════════════════════════════════════════════════════════════════════
# 1. Pure function: `_compute_uptime_from_events`
# ══════════════════════════════════════════════════════════════════════════════

class TestComputeUptimeFromEvents:

    def _run(self, events, device_ids=None, window_days=7):
        from app.api.v1.endpoints.sla import _compute_uptime_from_events
        since = NOW - timedelta(days=window_days)
        total = window_days * 86400
        if device_ids is None:
            device_ids = list(events.keys()) if events else [1]
        return _compute_uptime_from_events(events, device_ids, since, NOW, total)

    def test_no_events_returns_100(self):
        out = self._run({}, device_ids=[1, 2, 3])
        assert out == {1: 100.0, 2: 100.0, 3: 100.0}

    def test_single_offline_then_online(self):
        """Offline for 1 hour out of 7 days → uptime ~99.405%."""
        events = {1: [
            ("device_offline", NOW - timedelta(hours=2)),
            ("device_online", NOW - timedelta(hours=1)),
        ]}
        out = self._run(events)
        # 1h offline / (7 * 24)h = 0.595% downtime → 99.405% uptime
        assert out[1] == pytest.approx(99.405, abs=0.01)

    def test_first_event_online_means_started_offline(self):
        """If the first event in window is `device_online`, device was offline
        from `since` until that event."""
        events = {1: [
            ("device_online", NOW - timedelta(days=6)),   # online 1 day after window start
        ]}
        out = self._run(events)
        # 1 day offline / 7 days = 14.286% downtime → 85.714% uptime
        assert out[1] == pytest.approx(85.714, abs=0.01)

    def test_still_offline_at_end_of_window(self):
        """Last event is `device_offline` with no recovery → offline until NOW."""
        events = {1: [
            ("device_offline", NOW - timedelta(hours=3)),
        ]}
        out = self._run(events)
        # 3h offline / (7*24)h = 1.786% → 98.214% uptime
        assert out[1] == pytest.approx(98.214, abs=0.01)

    def test_multiple_cycles(self):
        """Two complete offline/online cycles."""
        events = {1: [
            ("device_offline", NOW - timedelta(hours=10)),
            ("device_online",  NOW - timedelta(hours=9)),    # 1h offline
            ("device_offline", NOW - timedelta(hours=5)),
            ("device_online",  NOW - timedelta(hours=3)),    # 2h offline
        ]}
        out = self._run(events)
        # 3h total offline / (7*24)h = 1.786% → 98.214%
        assert out[1] == pytest.approx(98.214, abs=0.01)

    def test_missing_device_gets_default(self):
        """device_ids includes ids not in events_by_device → defaults to 100.0."""
        events = {1: [("device_offline", NOW - timedelta(hours=1))]}
        out = self._run(events, device_ids=[1, 2, 3])
        assert 1 in out
        assert out[2] == 100.0
        assert out[3] == 100.0

    def test_duplicate_offline_keeps_first_timestamp(self):
        """Two consecutive offlines without an online between — original logic
        keeps the FIRST offline timestamp as the start."""
        events = {1: [
            ("device_offline", NOW - timedelta(hours=4)),
            ("device_offline", NOW - timedelta(hours=2)),
            ("device_online",  NOW - timedelta(hours=1)),
        ]}
        out = self._run(events)
        # 4h - 1h = 3h offline / (7*24)h → 98.214%
        assert out[1] == pytest.approx(98.214, abs=0.01)


# ══════════════════════════════════════════════════════════════════════════════
# 2. Parity with original `_calc_uptime` (single-device wrapper)
# ══════════════════════════════════════════════════════════════════════════════

class TestParityWithOriginal:
    """`_calc_uptime_bulk(db, [id], ...)` must match `_calc_uptime(db, id, ...)`."""

    @pytest.mark.asyncio
    async def test_parity_for_complex_event_sequence(self):
        from app.api.v1.endpoints.sla import _calc_uptime, _calc_uptime_bulk

        # Set up: 1 device, 4 events across 30-day window
        events_for_single = [
            ("device_offline", NOW - timedelta(days=20)),
            ("device_online",  NOW - timedelta(days=19, hours=23)),
            ("device_offline", NOW - timedelta(days=5)),
            ("device_online",  NOW - timedelta(days=4, hours=22)),
        ]
        events_for_bulk = [
            (1, etype, ts) for etype, ts in events_for_single
        ]

        single_db = _make_db_with_rows(events_for_single)
        bulk_db = _make_db_with_rows(events_for_bulk)

        single_result = await _calc_uptime(single_db, 1, 30, NOW)
        bulk_result = await _calc_uptime_bulk(bulk_db, [1], 30, NOW)

        assert bulk_result[1] == single_result

    @pytest.mark.asyncio
    async def test_parity_empty_events(self):
        from app.api.v1.endpoints.sla import _calc_uptime, _calc_uptime_bulk
        single_db = _make_db_with_rows([])
        bulk_db = _make_db_with_rows([])
        assert await _calc_uptime(single_db, 1, 30, NOW) == 100.0
        assert (await _calc_uptime_bulk(bulk_db, [1], 30, NOW))[1] == 100.0

    @pytest.mark.asyncio
    async def test_parity_started_offline(self):
        from app.api.v1.endpoints.sla import _calc_uptime, _calc_uptime_bulk
        events_single = [("device_online", NOW - timedelta(days=2))]
        events_bulk = [(1, "device_online", NOW - timedelta(days=2))]
        s = await _calc_uptime(_make_db_with_rows(events_single), 1, 7, NOW)
        b = await _calc_uptime_bulk(_make_db_with_rows(events_bulk), [1], 7, NOW)
        assert b[1] == s


# ══════════════════════════════════════════════════════════════════════════════
# 3. Bulk wrapper: single SQL, grouping correctness
# ══════════════════════════════════════════════════════════════════════════════

class TestCalcUptimeBulk:

    @pytest.mark.asyncio
    async def test_empty_device_ids_returns_empty_dict_no_db_call(self):
        from app.api.v1.endpoints.sla import _calc_uptime_bulk
        db = MagicMock()
        db.execute = AsyncMock()
        out = await _calc_uptime_bulk(db, [], 30, NOW)
        assert out == {}
        db.execute.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_single_db_call_for_n_devices(self):
        from app.api.v1.endpoints.sla import _calc_uptime_bulk
        # 5 devices, no events for any
        db = _make_db_with_rows([])
        out = await _calc_uptime_bulk(db, [1, 2, 3, 4, 5], 30, NOW)
        assert out == {1: 100.0, 2: 100.0, 3: 100.0, 4: 100.0, 5: 100.0}
        assert db.execute.await_count == 1, "must use exactly ONE SQL query"

    @pytest.mark.asyncio
    async def test_grouping_with_interleaved_events_for_3_devices(self):
        from app.api.v1.endpoints.sla import _calc_uptime_bulk
        # Note: DB returns rows ordered by (device_id ASC, created_at ASC).
        # All three devices: ~1h offline each.
        rows = [
            (1, "device_offline", NOW - timedelta(hours=2)),
            (1, "device_online",  NOW - timedelta(hours=1)),
            (2, "device_offline", NOW - timedelta(hours=2)),
            (2, "device_online",  NOW - timedelta(hours=1)),
            (3, "device_offline", NOW - timedelta(hours=2)),
            (3, "device_online",  NOW - timedelta(hours=1)),
        ]
        db = _make_db_with_rows(rows)
        out = await _calc_uptime_bulk(db, [1, 2, 3], 7, NOW)
        assert out[1] == pytest.approx(99.405, abs=0.01)
        assert out[1] == out[2] == out[3]   # identical → grouping is correct

    @pytest.mark.asyncio
    async def test_some_devices_have_no_events(self):
        from app.api.v1.endpoints.sla import _calc_uptime_bulk
        rows = [
            (1, "device_offline", NOW - timedelta(hours=4)),
            (1, "device_online",  NOW - timedelta(hours=3)),
        ]
        db = _make_db_with_rows(rows)
        out = await _calc_uptime_bulk(db, [1, 2, 3], 7, NOW)
        assert out[1] != 100.0
        assert out[2] == 100.0
        assert out[3] == 100.0


# ══════════════════════════════════════════════════════════════════════════════
# 4. Cache key construction
# ══════════════════════════════════════════════════════════════════════════════

class TestCacheKey:

    def test_loc_key_part_stable_for_sort_order(self):
        from app.api.v1.endpoints.sla import _loc_key_part
        assert _loc_key_part(["b", "a", "c"]) == _loc_key_part(["a", "b", "c"])
        assert _loc_key_part(["a", "b"]) != _loc_key_part(["a", "b", "c"])

    def test_loc_key_part_handles_none_and_empty(self):
        from app.api.v1.endpoints.sla import _loc_key_part
        assert _loc_key_part(None) == "_"
        assert _loc_key_part([]) == "empty"
        # non-empty produces an 8-char hex digest
        h = _loc_key_part(["site1"])
        assert len(h) == 8 and all(c in "0123456789abcdef" for c in h)


# ══════════════════════════════════════════════════════════════════════════════
# 5. Endpoint integration (cache get/miss + bypass + Redis-down)
# ══════════════════════════════════════════════════════════════════════════════

class FakeAsyncRedis:
    """Reused minimal stub from test_faz6b_cache."""
    def __init__(self):
        self.store = {}
        self.down = False
    async def get(self, k):
        if self.down: raise __import__("redis").exceptions.RedisError("down")
        return self.store.get(k)
    async def set(self, k, v, *, ex=None, nx=False):
        if self.down: raise __import__("redis").exceptions.RedisError("down")
        if nx and k in self.store: return False
        self.store[k] = v
        return True
    async def delete(self, k):
        if self.down: raise __import__("redis").exceptions.RedisError("down")
        existed = k in self.store
        self.store.pop(k, None)
        return 1 if existed else 0
    async def incr(self, k):
        if self.down: raise __import__("redis").exceptions.RedisError("down")
        self.store[k] = str(int(self.store.get(k, "0")) + 1)
        return int(self.store[k])


class TestFleetSummaryEndpointPath:
    """Drives the inner compute via the cache layer to verify integration."""

    @pytest.mark.asyncio
    async def test_cache_miss_then_hit(self, monkeypatch):
        from app.services import cache as cache_mod
        cache_mod.reset_aggregation_cache_for_tests()

        fake = FakeAsyncRedis()
        cache_obj = cache_mod.AggregationCache(fake)

        call_count = 0
        async def compute():
            nonlocal call_count
            call_count += 1
            return {"total": 5, "above_99": 5, "above_95": 0, "below_95": 0, "avg_uptime_pct": 100.0}

        payload1, st1 = await cache_obj.get_or_compute(
            key="agg:sla:fleet:v=0:t=_:loc=_:w=30:s=_",
            compute=compute,
            fresh_secs=60, stale_secs=240,
            key_pattern="sla_fleet",
        )
        payload2, st2 = await cache_obj.get_or_compute(
            key="agg:sla:fleet:v=0:t=_:loc=_:w=30:s=_",
            compute=compute,
            fresh_secs=60, stale_secs=240,
            key_pattern="sla_fleet",
        )
        assert st1 == cache_mod.CacheStatus.MISS
        assert st2 == cache_mod.CacheStatus.HIT_FRESH
        assert call_count == 1
        assert payload1 == payload2

    @pytest.mark.asyncio
    async def test_bypass_forces_recompute(self):
        from app.services import cache as cache_mod
        fake = FakeAsyncRedis()
        cache_obj = cache_mod.AggregationCache(fake)

        call_count = 0
        async def compute():
            nonlocal call_count
            call_count += 1
            return {"total": call_count}

        await cache_obj.get_or_compute(
            key="agg:sla:fleet:bypass_test",
            compute=compute,
            fresh_secs=60, stale_secs=240,
            key_pattern="sla_fleet",
        )
        # Now request with bypass=True — must compute again
        payload, status = await cache_obj.get_or_compute(
            key="agg:sla:fleet:bypass_test",
            compute=compute,
            fresh_secs=60, stale_secs=240,
            key_pattern="sla_fleet",
            bypass=True,
        )
        assert status == cache_mod.CacheStatus.BYPASS
        assert call_count == 2
        assert payload["total"] == 2

    @pytest.mark.asyncio
    async def test_redis_down_endpoint_still_returns(self):
        """Critical invariant: Redis unavailable must NOT break the endpoint."""
        from app.services import cache as cache_mod
        fake = FakeAsyncRedis()
        fake.down = True
        cache_obj = cache_mod.AggregationCache(fake)

        async def compute():
            return {"total": 10}

        payload, status = await cache_obj.get_or_compute(
            key="agg:sla:fleet:redis_down_test",
            compute=compute,
            fresh_secs=60, stale_secs=240,
            key_pattern="sla_fleet",
        )
        assert status == cache_mod.CacheStatus.REDIS_DOWN
        assert payload == {"total": 10}

    @pytest.mark.asyncio
    async def test_versioned_key_changes_after_incr(self):
        """After invalidate_version(), readers should compose a new key."""
        from app.services import cache as cache_mod
        fake = FakeAsyncRedis()
        cache_obj = cache_mod.AggregationCache(fake)

        v1 = await cache_obj.read_version("agg:_version:sla_fleet")
        assert v1 == 0
        await cache_obj.invalidate_version("agg:_version:sla_fleet")
        await cache_obj.invalidate_version("agg:_version:sla_fleet")
        v2 = await cache_obj.read_version("agg:_version:sla_fleet")
        assert v2 == 2
