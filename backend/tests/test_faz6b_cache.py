"""
Faz 6B — AggregationCache unit tests.

Pure unit tests — no real Redis. The async Redis client is a thin mock that
behaves like the real one for the operations we use (get / set / delete /
incr / set with nx+ex). Each test owns its own AggregationCache instance via
the helper at the top.

Tested behaviors:
  * MISS path: compute called, result written, status=MISS
  * HIT_FRESH path: cached entry within fresh_secs returned without compute
  * HIT_STALE path: cached entry past fresh returned + background refresh kicked off
  * BYPASS: feature flag off OR bypass=True skips read/write, compute always runs
  * REDIS_DOWN: Redis GET raises → compute runs, no write attempted
  * Single-flight: 5 concurrent cold requests → exactly 1 compute
  * Invalidate: delete + INCR version helpers
  * JSON encoder: datetime / date / Decimal / UUID round-trip cleanly
  * Slow compute warning: duration > threshold logs warning
  * Corrupt entry: malformed JSON treated as miss (no exception)
"""
import asyncio
import json
import logging
import time
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional

import pytest
from redis.exceptions import RedisError

from app.services.cache import (
    AggregationCache,
    CacheStatus,
    _AggEncoder,
    _serialize,
    _deserialize,
)


# ── Fake async Redis ──────────────────────────────────────────────────────────

class FakeAsyncRedis:
    """Async Redis stub. Tests can flip `down=True` to simulate Redis errors."""

    def __init__(self):
        self.store: dict[str, str] = {}
        self.versions: dict[str, int] = {}
        self.down = False
        self.get_calls = 0
        self.set_calls = 0
        self.delete_calls = 0

    async def get(self, key):
        self.get_calls += 1
        if self.down:
            raise RedisError("simulated down")
        return self.store.get(key)

    async def set(self, key, value, *, ex=None, nx=False):
        self.set_calls += 1
        if self.down:
            raise RedisError("simulated down")
        if nx and key in self.store:
            return False
        self.store[key] = value
        return True

    async def delete(self, key):
        self.delete_calls += 1
        if self.down:
            raise RedisError("simulated down")
        existed = key in self.store
        self.store.pop(key, None)
        return 1 if existed else 0

    async def incr(self, key):
        if self.down:
            raise RedisError("simulated down")
        self.versions[key] = self.versions.get(key, 0) + 1
        self.store[key] = str(self.versions[key])
        return self.versions[key]


def _cache_with_fake() -> tuple[AggregationCache, FakeAsyncRedis]:
    r = FakeAsyncRedis()
    return AggregationCache(r), r


# ── 1. Serialization / encoder ────────────────────────────────────────────────

class TestEncoder:

    def test_datetime_round_trip(self):
        now = datetime(2026, 5, 15, 12, 0, 0, tzinfo=timezone.utc)
        s = _serialize({"ts": now})
        d = _deserialize(s)
        assert d["ts"] == now.isoformat()

    def test_date_decimal_uuid(self):
        payload = {
            "day": date(2026, 5, 15),
            "amount": Decimal("12.345"),
            "id": uuid.UUID("12345678-1234-5678-1234-567812345678"),
        }
        s = _serialize(payload)
        d = _deserialize(s)
        assert d["day"] == "2026-05-15"
        assert d["amount"] == 12.345
        assert d["id"] == "12345678-1234-5678-1234-567812345678"

    def test_set_serialized_as_list(self):
        s = _serialize({"tags": {"a", "b"}})
        d = _deserialize(s)
        assert sorted(d["tags"]) == ["a", "b"]


# ── 2. Cache hit / miss paths ─────────────────────────────────────────────────

class TestGetOrCompute:

    @pytest.mark.asyncio
    async def test_miss_calls_compute_and_writes(self):
        cache, r = _cache_with_fake()
        calls = []

        async def compute():
            calls.append("c")
            return {"value": 42}

        payload, status = await cache.get_or_compute(
            key="agg:test:1", compute=compute,
            fresh_secs=60, stale_secs=240, key_pattern="test",
        )
        assert status == CacheStatus.MISS
        assert payload == {"value": 42}
        assert len(calls) == 1
        assert "agg:test:1" in r.store

    @pytest.mark.asyncio
    async def test_hit_fresh_skips_compute(self):
        cache, r = _cache_with_fake()
        calls = []

        async def compute():
            calls.append("c")
            return {"value": 1}

        # First call populates cache
        await cache.get_or_compute(
            key="agg:test:2", compute=compute,
            fresh_secs=60, stale_secs=240, key_pattern="test",
        )
        assert len(calls) == 1

        # Second call hits cache — compute NOT called again
        payload, status = await cache.get_or_compute(
            key="agg:test:2", compute=compute,
            fresh_secs=60, stale_secs=240, key_pattern="test",
        )
        assert status == CacheStatus.HIT_FRESH
        assert payload == {"value": 1}
        assert len(calls) == 1   # still only 1 call

    @pytest.mark.asyncio
    async def test_stale_entry_recomputed_synchronously(self):
        """A stale entry triggers a synchronous recompute (no background task).

        Background refresh was removed: a detached task would outlive the
        caller's DB session. Stale → compute inline, single-flight protected.
        """
        cache, r = _cache_with_fake()
        envelope = {
            "payload": {"value": "old"},
            "written_at": time.time() - 120,   # 120s old → past 60s fresh window
            "fresh_secs": 60,
        }
        r.store["agg:test:3"] = json.dumps(envelope)

        compute_calls = []

        async def compute():
            compute_calls.append("c")
            return {"value": "new"}

        payload, status = await cache.get_or_compute(
            key="agg:test:3", compute=compute,
            fresh_secs=60, stale_secs=240, key_pattern="test",
        )
        # Stale → synchronous recompute → fresh value returned, status MISS
        assert status == CacheStatus.MISS
        assert payload == {"value": "new"}
        assert len(compute_calls) == 1
        # Cache now holds the freshly computed value
        new_envelope = json.loads(r.store["agg:test:3"])
        assert new_envelope["payload"] == {"value": "new"}

    @pytest.mark.asyncio
    async def test_stale_served_when_compute_fails(self):
        """If recompute fails but a stale entry exists, serve stale as fallback."""
        cache, r = _cache_with_fake()
        envelope = {
            "payload": {"value": "stale-fallback"},
            "written_at": time.time() - 120,
            "fresh_secs": 60,
        }
        r.store["agg:test:3b"] = json.dumps(envelope)

        async def failing_compute():
            raise RuntimeError("DB down")

        payload, status = await cache.get_or_compute(
            key="agg:test:3b", compute=failing_compute,
            fresh_secs=60, stale_secs=240, key_pattern="test",
        )
        assert status == CacheStatus.HIT_STALE
        assert payload == {"value": "stale-fallback"}


# ── 3. Bypass behavior ────────────────────────────────────────────────────────

class TestBypass:

    @pytest.mark.asyncio
    async def test_bypass_flag_skips_cache(self):
        cache, r = _cache_with_fake()
        # Pre-populate so a non-bypass would hit
        envelope = {"payload": {"v": 1}, "written_at": time.time(), "fresh_secs": 60}
        r.store["agg:test:4"] = json.dumps(envelope)

        async def compute():
            return {"v": 2}

        payload, status = await cache.get_or_compute(
            key="agg:test:4", compute=compute,
            fresh_secs=60, stale_secs=240, key_pattern="test",
            bypass=True,
        )
        assert status == CacheStatus.BYPASS
        assert payload == {"v": 2}

    @pytest.mark.asyncio
    async def test_disabled_setting_acts_as_bypass(self, monkeypatch):
        from app.core import config
        monkeypatch.setattr(config.settings, "AGG_CACHE_ENABLED", False)

        cache, r = _cache_with_fake()
        async def compute():
            return {"v": 9}

        payload, status = await cache.get_or_compute(
            key="agg:test:5", compute=compute,
            fresh_secs=60, stale_secs=240, key_pattern="test",
        )
        assert status == CacheStatus.BYPASS
        assert payload == {"v": 9}
        # No write happened
        assert "agg:test:5" not in r.store


# ── 4. Redis-down fallback ────────────────────────────────────────────────────

class TestRedisDown:

    @pytest.mark.asyncio
    async def test_redis_down_falls_through_to_compute(self):
        cache, r = _cache_with_fake()
        r.down = True

        async def compute():
            return {"v": "computed"}

        payload, status = await cache.get_or_compute(
            key="agg:test:6", compute=compute,
            fresh_secs=60, stale_secs=240, key_pattern="test",
        )
        assert status == CacheStatus.REDIS_DOWN
        assert payload == {"v": "computed"}
        # No write attempted into the store
        assert "agg:test:6" not in r.store

    @pytest.mark.asyncio
    async def test_corrupt_entry_treated_as_miss(self):
        cache, r = _cache_with_fake()
        r.store["agg:test:7"] = "{not valid json"

        async def compute():
            return {"v": "recovered"}

        payload, status = await cache.get_or_compute(
            key="agg:test:7", compute=compute,
            fresh_secs=60, stale_secs=240, key_pattern="test",
        )
        assert status == CacheStatus.MISS
        assert payload == {"v": "recovered"}


# ── 5. Single-flight stampede protection ──────────────────────────────────────

class TestStampedeProtection:

    @pytest.mark.asyncio
    async def test_concurrent_cold_requests_compute_once(self):
        cache, r = _cache_with_fake()
        call_count = 0
        compute_started = asyncio.Event()
        compute_can_finish = asyncio.Event()

        async def compute():
            nonlocal call_count
            call_count += 1
            compute_started.set()
            # Hold compute open so all 5 requests arrive while we're computing
            await compute_can_finish.wait()
            return {"v": "shared"}

        async def caller(i):
            return await cache.get_or_compute(
                key="agg:test:hot", compute=compute,
                fresh_secs=60, stale_secs=240, key_pattern="test",
            )

        # Launch 5 concurrent cold callers
        tasks = [asyncio.create_task(caller(i)) for i in range(5)]
        # Wait for the first one to enter compute
        await compute_started.wait()
        # Let the rest pile up behind the lock
        await asyncio.sleep(0.1)
        # Release compute
        compute_can_finish.set()

        results = await asyncio.gather(*tasks)
        # Exactly one compute happened
        assert call_count == 1
        # All requests got the same payload
        for payload, _status in results:
            assert payload == {"v": "shared"}
        # Statuses include 1 MISS + 4 HIT_FRESH (from polling after write)
        statuses = [s for _p, s in results]
        assert statuses.count(CacheStatus.MISS) == 1
        assert statuses.count(CacheStatus.HIT_FRESH) == 4


# ── 6. Invalidation helpers ───────────────────────────────────────────────────

class TestInvalidation:

    @pytest.mark.asyncio
    async def test_invalidate_removes_key(self):
        cache, r = _cache_with_fake()
        r.store["agg:foo"] = "anything"
        removed = await cache.invalidate("agg:foo", key_pattern="test")
        assert removed is True
        assert "agg:foo" not in r.store

    @pytest.mark.asyncio
    async def test_invalidate_missing_key_returns_false(self):
        cache, r = _cache_with_fake()
        removed = await cache.invalidate("agg:missing", key_pattern="test")
        assert removed is False

    @pytest.mark.asyncio
    async def test_version_incr_and_read(self):
        cache, r = _cache_with_fake()
        v1 = await cache.invalidate_version("agg:_version:fleet")
        v2 = await cache.invalidate_version("agg:_version:fleet")
        assert v1 == 1
        assert v2 == 2
        current = await cache.read_version("agg:_version:fleet")
        assert current == 2

    @pytest.mark.asyncio
    async def test_version_read_on_missing_returns_zero(self):
        cache, _r = _cache_with_fake()
        assert await cache.read_version("agg:_version:nothing") == 0


# ── 7. Slow compute warning ───────────────────────────────────────────────────

class TestSlowCompute:

    @pytest.mark.asyncio
    async def test_slow_compute_logs_warning(self, monkeypatch, caplog):
        from app.core import config
        # Drop threshold to 50ms so the test runs fast
        monkeypatch.setattr(config.settings, "AGG_CACHE_SLOW_COMPUTE_WARN_SECS", 0.05)

        cache, _r = _cache_with_fake()

        async def slow_compute():
            await asyncio.sleep(0.1)   # 100ms — over threshold
            return {"v": "slow"}

        with caplog.at_level(logging.WARNING, logger="app.services.cache"):
            payload, status = await cache.get_or_compute(
                key="agg:test:slow", compute=slow_compute,
                fresh_secs=60, stale_secs=240, key_pattern="test_slow",
            )

        assert payload == {"v": "slow"}
        assert any("slow aggregation" in r.message for r in caplog.records), (
            f"Expected slow-aggregation warning, got: {[r.message for r in caplog.records]}"
        )

    @pytest.mark.asyncio
    async def test_fast_compute_does_not_warn(self, caplog):
        cache, _r = _cache_with_fake()

        async def fast_compute():
            return {"v": "fast"}

        with caplog.at_level(logging.WARNING, logger="app.services.cache"):
            await cache.get_or_compute(
                key="agg:test:fast", compute=fast_compute,
                fresh_secs=60, stale_secs=240, key_pattern="test_fast",
            )

        assert not any("slow aggregation" in r.message for r in caplog.records)
