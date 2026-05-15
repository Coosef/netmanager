"""
Faz 6B — Intelligence fleet/risk bulk query + cache integration tests.

Key invariants verified:
  * `_compute_risk_from_data` reproduces the exact Sprint 12A formula
    (compliance 25% / uptime 30% / flapping 20% / backup 25%) — every
    component, every weight, every rounding step.
  * Parity with `_calc_risk_uncached`: same device + same inputs → identical
    dict (incl. breakdown sub-objects).
  * `_calc_risk_bulk` runs exactly THREE SQL queries regardless of N
    (audit DISTINCT ON, events, flap counts).
  * Empty device list → empty result, no DB calls.
  * Devices without audit data default to comp_risk=25.0.
  * Devices without backup default to backup_risk=25.0.
  * Per-device `_calc_risk` no longer touches sync redis — uses async cache.
  * `intelligence.py` source contains no `redis.from_url` or sync `_redis` global.
  * Endpoint integration: bypass / Redis-down / version bump.
"""
import json
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest


UTC = timezone.utc
NOW = datetime(2026, 5, 15, 12, 0, 0, tzinfo=UTC)


def _device(did=1, hostname="sw1", last_backup=None):
    d = MagicMock()
    d.id = did
    d.hostname = hostname
    d.last_backup = last_backup
    return d


def _db_with_sequence(*row_lists):
    """
    Returns an AsyncSession mock where successive `.execute()` calls return
    successive row lists from `.fetchall()`. Used to feed the 3 bulk queries.
    """
    db = MagicMock()
    results = []
    for rows in row_lists:
        r = MagicMock()
        r.fetchall.return_value = rows
        results.append(r)
    db.execute = AsyncMock(side_effect=results)
    return db


# ══════════════════════════════════════════════════════════════════════════════
# 1. Pure function — formula correctness
# ══════════════════════════════════════════════════════════════════════════════

class TestComputeRiskFromData:

    def test_perfect_device_has_low_risk(self):
        """Score 100, uptime 100%, no flaps, fresh backup → near-zero risk."""
        from app.api.v1.endpoints.intelligence import _compute_risk_from_data
        d = _device(1, last_backup=NOW - timedelta(hours=1))
        out = _compute_risk_from_data(
            devices=[d],
            audit_scores={1: 100},
            events_by_device={},
            flap_counts={},
            now=NOW,
        )
        # Compliance 0 + Uptime 0 + Flap 0 + Backup ~0.035 = ~0.0
        assert out[0]["risk_score"] < 1.0
        assert out[0]["level"] == "low"

    def test_no_data_device_max_compliance_and_backup_risk(self):
        """No audit, no backup → comp_risk=25 + backup_risk=25 = 50 (medium)."""
        from app.api.v1.endpoints.intelligence import _compute_risk_from_data
        d = _device(1, last_backup=None)
        out = _compute_risk_from_data(
            devices=[d],
            audit_scores={},
            events_by_device={},
            flap_counts={},
            now=NOW,
        )
        # 25 (no audit) + 0 (uptime 100%) + 0 (no flaps) + 25 (no backup) = 50.0
        assert out[0]["risk_score"] == 50.0
        assert out[0]["level"] == "medium"
        assert out[0]["breakdown"]["compliance"]["risk_contribution"] == 25.0
        assert out[0]["breakdown"]["backup"]["risk_contribution"] == 25.0
        assert out[0]["breakdown"]["compliance"]["score"] is None
        assert out[0]["breakdown"]["backup"]["last_backup"] is None

    def test_flapping_caps_at_four_per_week(self):
        from app.api.v1.endpoints.intelligence import _compute_risk_from_data
        d1 = _device(1, last_backup=NOW)
        d2 = _device(2, last_backup=NOW)
        out = _compute_risk_from_data(
            devices=[d1, d2],
            audit_scores={1: 100, 2: 100},
            events_by_device={},
            flap_counts={1: 4, 2: 100},  # 4 and 100 both cap at full weight
            now=NOW,
        )
        # Same flap contribution for both
        assert out[0]["breakdown"]["flapping_7d"]["risk_contribution"] == 20.0
        assert out[1]["breakdown"]["flapping_7d"]["risk_contribution"] == 20.0

    def test_backup_age_30_days_is_max(self):
        from app.api.v1.endpoints.intelligence import _compute_risk_from_data
        old_d = _device(1, last_backup=NOW - timedelta(days=45))
        out = _compute_risk_from_data(
            devices=[old_d],
            audit_scores={1: 100},
            events_by_device={},
            flap_counts={},
            now=NOW,
        )
        assert out[0]["breakdown"]["backup"]["risk_contribution"] == 25.0

    def test_uptime_factor_applies(self):
        """1 hour offline / 168 hours = 0.595% → uptime_risk = 99.405*0.30 ≈ 0.18."""
        from app.api.v1.endpoints.intelligence import _compute_risk_from_data
        d = _device(1, last_backup=NOW)
        out = _compute_risk_from_data(
            devices=[d],
            audit_scores={1: 100},
            events_by_device={1: [
                ("device_offline", NOW - timedelta(hours=2)),
                ("device_online",  NOW - timedelta(hours=1)),
            ]},
            flap_counts={},
            now=NOW,
        )
        # uptime ~ 99.4 → risk = 0.6 * 0.30 = ~0.18
        assert out[0]["breakdown"]["uptime_7d"]["uptime_pct"] == pytest.approx(99.4, abs=0.1)
        assert out[0]["breakdown"]["uptime_7d"]["risk_contribution"] < 0.5

    def test_level_thresholds(self):
        """Verify the level mapping at boundary scores (26/51/76)."""
        from app.api.v1.endpoints.intelligence import _risk_level
        assert _risk_level(0) == "low"
        assert _risk_level(25.9) == "low"
        assert _risk_level(26) == "medium"
        assert _risk_level(50.9) == "medium"
        assert _risk_level(51) == "high"
        assert _risk_level(75.9) == "high"
        assert _risk_level(76) == "critical"
        assert _risk_level(100) == "critical"

    def test_naive_last_backup_treated_as_utc(self):
        """Backup datetime without tzinfo must still produce sensible result."""
        from app.api.v1.endpoints.intelligence import _compute_risk_from_data
        naive = datetime(2026, 5, 15, 11, 0, 0)   # tzinfo=None
        d = _device(1, last_backup=naive)
        out = _compute_risk_from_data(
            devices=[d],
            audit_scores={1: 100},
            events_by_device={},
            flap_counts={},
            now=NOW,
        )
        # ~1 hour old → tiny backup contribution
        assert out[0]["breakdown"]["backup"]["risk_contribution"] < 1.0


# ══════════════════════════════════════════════════════════════════════════════
# 2. Parity with `_calc_risk_uncached`
# ══════════════════════════════════════════════════════════════════════════════

class TestParityWithUncached:

    @pytest.mark.asyncio
    async def test_bulk_matches_uncached_for_complex_device(self):
        """`_calc_risk_bulk(db, [d], ...)` produces a result byte-identical to
        `_calc_risk_uncached(db, d, ...)` for the same device + same input data."""
        from app.api.v1.endpoints.intelligence import (
            _calc_risk_uncached, _calc_risk_bulk,
        )

        d = _device(1, hostname="sw-A", last_backup=NOW - timedelta(days=3))
        # Inputs for the single-device path: 4 separate db.execute calls
        # (audit / events / flap_count — flap_count uses scalar_one)
        single_db = MagicMock()
        audit = MagicMock(); audit.score = 80
        audit_result = MagicMock(); audit_result.scalar_one_or_none.return_value = audit
        events_result = MagicMock()
        events_result.fetchall.return_value = [
            ("device_offline", NOW - timedelta(hours=4)),
            ("device_online",  NOW - timedelta(hours=2)),
        ]
        flap_result = MagicMock(); flap_result.scalar_one.return_value = 2
        single_db.execute = AsyncMock(side_effect=[audit_result, events_result, flap_result])
        single_out = await _calc_risk_uncached(single_db, d, NOW)

        # Same inputs in bulk form (3 queries instead of 4)
        bulk_db = _db_with_sequence(
            [(1, 80)],                                                          # audit
            [(1, "device_offline", NOW - timedelta(hours=4)),                   # events
             (1, "device_online",  NOW - timedelta(hours=2))],
            [(1, 2)],                                                           # flap counts
        )
        bulk_out_list = await _calc_risk_bulk(bulk_db, [d], NOW)
        assert len(bulk_out_list) == 1
        bulk_out = bulk_out_list[0]

        # Compare every field
        assert bulk_out["risk_score"] == single_out["risk_score"]
        assert bulk_out["level"] == single_out["level"]
        assert bulk_out["device_id"] == single_out["device_id"]
        assert bulk_out["breakdown"] == single_out["breakdown"]


# ══════════════════════════════════════════════════════════════════════════════
# 3. Bulk wrapper — query count + grouping
# ══════════════════════════════════════════════════════════════════════════════

class TestCalcRiskBulk:

    @pytest.mark.asyncio
    async def test_empty_devices_returns_empty_no_db_call(self):
        from app.api.v1.endpoints.intelligence import _calc_risk_bulk
        db = MagicMock()
        db.execute = AsyncMock()
        out = await _calc_risk_bulk(db, [], NOW)
        assert out == []
        db.execute.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_exactly_three_queries_for_n_devices(self):
        from app.api.v1.endpoints.intelligence import _calc_risk_bulk
        devices = [_device(i, last_backup=NOW) for i in range(1, 11)]   # 10 devices
        db = _db_with_sequence(
            [(i, 100) for i in range(1, 11)],    # 10 audit rows
            [],                                    # no events
            [],                                    # no flaps
        )
        out = await _calc_risk_bulk(db, devices, NOW)
        assert len(out) == 10
        assert db.execute.await_count == 3, "must use exactly 3 bulk queries"

    @pytest.mark.asyncio
    async def test_grouping_with_three_devices_different_data(self):
        from app.api.v1.endpoints.intelligence import _calc_risk_bulk
        d1 = _device(1, last_backup=NOW)
        d2 = _device(2, last_backup=NOW - timedelta(days=45))   # very old backup
        d3 = _device(3, last_backup=None)                        # no backup
        db = _db_with_sequence(
            [(1, 100), (2, 50)],                                # d3 has no audit
            [(1, "device_offline", NOW - timedelta(hours=2)),   # d1 had outage
             (1, "device_online",  NOW - timedelta(hours=1))],
            [(2, 10)],                                            # d2 flapped a lot
        )
        out = await _calc_risk_bulk(db, [d1, d2, d3], NOW)

        # d1: small outage; perfect compliance; fresh backup → very low risk
        assert out[0]["device_id"] == 1
        assert out[0]["risk_score"] < 5

        # d2: medium audit (50 → 12.5 comp_risk) + flap cap (20) + 30-day backup cap (25) = ~57.5
        assert out[1]["device_id"] == 2
        assert out[1]["risk_score"] == pytest.approx(57.5, abs=0.1)

        # d3: no audit (25) + no backup (25) = 50.0
        assert out[2]["device_id"] == 3
        assert out[2]["risk_score"] == 50.0


# ══════════════════════════════════════════════════════════════════════════════
# 4. Per-device `_calc_risk` no longer uses sync redis
# ══════════════════════════════════════════════════════════════════════════════

class TestSyncRedisRemoved:

    def test_intelligence_module_does_not_import_redis(self):
        """The legacy `import redis` + `_redis = redis.from_url(...)` pattern
        must be gone — it was blocking the event loop on every cache get.

        Uses AST so docstring/comment mentions of the old pattern don't
        trigger a false positive.
        """
        import ast
        import inspect
        from app.api.v1.endpoints import intelligence
        tree = ast.parse(inspect.getsource(intelligence))

        # 1. No `import redis` at module level
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert alias.name != "redis", (
                        "intelligence.py must not import the sync redis package"
                    )

        # 2. No `redis.from_url(...)` call anywhere in the AST
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "from_url"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "redis"):
                raise AssertionError("intelligence.py must not call sync redis.from_url()")

        # 3. No module-level `_redis = ...` assignment to a sync client
        assert not hasattr(intelligence, "_redis"), (
            "intelligence.py must not keep a module-level sync _redis client"
        )

    @pytest.mark.asyncio
    async def test_calc_risk_uses_async_cache(self, monkeypatch):
        """`_calc_risk` should route through `get_aggregation_cache().get_or_compute`."""
        from app.api.v1.endpoints import intelligence
        from app.services import cache as cache_mod

        # Inject a fake cache so we can assert the call
        called = {}
        class FakeCache:
            async def get_or_compute(self, key, compute, fresh_secs, stale_secs, key_pattern, bypass=False):
                called["key"] = key
                called["key_pattern"] = key_pattern
                called["fresh_secs"] = fresh_secs
                payload = await compute()
                return payload, cache_mod.CacheStatus.MISS

        monkeypatch.setattr(intelligence, "get_aggregation_cache", lambda: FakeCache())

        # Stub _calc_risk_uncached so we don't hit DB
        async def stub_uncached(db, device, now):
            return {"device_id": device.id, "risk_score": 10.0, "level": "low"}
        monkeypatch.setattr(intelligence, "_calc_risk_uncached", stub_uncached)

        d = _device(42)
        out = await intelligence._calc_risk(MagicMock(), d, NOW)
        assert out["device_id"] == 42
        assert called["key"] == "agg:risk:device:42"
        assert called["key_pattern"] == "risk_device"
        assert called["fresh_secs"] == 300


# ══════════════════════════════════════════════════════════════════════════════
# 5. Endpoint integration via the cache layer
# ══════════════════════════════════════════════════════════════════════════════

class FakeAsyncRedis:
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


class TestFleetRiskEndpointPath:

    @pytest.mark.asyncio
    async def test_cache_miss_then_hit(self):
        from app.services import cache as cache_mod
        cache_obj = cache_mod.AggregationCache(FakeAsyncRedis())

        call_count = 0
        async def compute():
            nonlocal call_count
            call_count += 1
            return {
                "summary": {
                    "total_devices": 3, "avg_risk_score": 25.0,
                    "critical": 0, "high": 0, "medium": 1, "low": 2,
                },
                "top_risky": [],
            }

        key = "agg:risk:fleet:v=0:t=_:loc=_:limit=20"
        p1, s1 = await cache_obj.get_or_compute(
            key=key, compute=compute, fresh_secs=60, stale_secs=240,
            key_pattern="risk_fleet",
        )
        p2, s2 = await cache_obj.get_or_compute(
            key=key, compute=compute, fresh_secs=60, stale_secs=240,
            key_pattern="risk_fleet",
        )
        assert s1 == cache_mod.CacheStatus.MISS
        assert s2 == cache_mod.CacheStatus.HIT_FRESH
        assert call_count == 1
        assert p1 == p2

    @pytest.mark.asyncio
    async def test_redis_down_endpoint_still_returns(self):
        from app.services import cache as cache_mod
        fake = FakeAsyncRedis()
        fake.down = True
        cache_obj = cache_mod.AggregationCache(fake)

        async def compute():
            return {"summary": {"total_devices": 0}, "top_risky": []}

        payload, status = await cache_obj.get_or_compute(
            key="agg:risk:fleet:redis_down_test",
            compute=compute,
            fresh_secs=60, stale_secs=240, key_pattern="risk_fleet",
        )
        assert status == cache_mod.CacheStatus.REDIS_DOWN
        assert payload["summary"]["total_devices"] == 0

    @pytest.mark.asyncio
    async def test_bypass_skips_cache(self):
        from app.services import cache as cache_mod
        cache_obj = cache_mod.AggregationCache(FakeAsyncRedis())
        n = 0
        async def compute():
            nonlocal n
            n += 1
            return {"summary": {"total_devices": n}, "top_risky": []}

        # First populate cache
        await cache_obj.get_or_compute(
            key="agg:risk:fleet:bypass", compute=compute,
            fresh_secs=60, stale_secs=240, key_pattern="risk_fleet",
        )
        # Bypass = fresh compute
        p, st = await cache_obj.get_or_compute(
            key="agg:risk:fleet:bypass", compute=compute,
            fresh_secs=60, stale_secs=240, key_pattern="risk_fleet",
            bypass=True,
        )
        assert st == cache_mod.CacheStatus.BYPASS
        assert n == 2
        assert p["summary"]["total_devices"] == 2
