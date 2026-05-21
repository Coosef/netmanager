"""
Cache warmer tests (Faz 6B G5, post Faz 9 #4).

Coverage:
  * build_warm_targets — pure: always the two no-filter kinds (sla, risk).
  * _warm() guards:
      - AGG_CACHE_ENABLED=false → status=disabled, no Redis touched
      - warmer lock already held → status=locked
      - Redis down on lock attempt → status=redis_down (no raise)
  * _cleanup_legacy_keys — best-effort one-time DEL of agg:dirty:tenant.
  * _run_warm orchestration:
      - happy path warms both targets, drains dirty:device markers
      - no-filter failure keeps dirty:device markers (next cycle retries)
      - per-target exception is isolated (gather return_exceptions=True)
  * fleet cache key builders are drift-free (same key for same inputs).
  * warm_aggregation_cache task never raises (returns error dict on crash).

Faz 9 #4 — the per-tenant warm path (agg:dirty:tenant set + per-tenant
targets) was retired. RLS scopes reads at the DB layer; the warmer only
needs to keep two no-filter fleet keys warm. Tests that exercised the
per-tenant branch were removed.
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest


# ── Fake async redis ──────────────────────────────────────────────────────────

class FakeAsyncRedis:
    def __init__(self):
        self.kv = {}
        self.sets = {}
        self.down = False
        self.srem_calls = []
        self.delete_calls = []
        self.lock_held = False  # simulate another runner holding the lock
        self.closed = False

    async def set(self, key, value, *, nx=False, ex=None):
        if self.down:
            raise __import__("redis").exceptions.RedisError("down")
        if nx and (key in self.kv or (key == "agg:warmer:lock" and self.lock_held)):
            return None  # NX fails — lock contended
        self.kv[key] = value
        return True

    async def delete(self, key):
        self.delete_calls.append(key)
        self.kv.pop(key, None)
        self.sets.pop(key, None)
        return 1

    async def smembers(self, key):
        if self.down:
            raise __import__("redis").exceptions.RedisError("down")
        return set(self.sets.get(key, set()))

    async def srem(self, key, *members):
        self.srem_calls.append((key, set(members)))
        s = self.sets.get(key, set())
        removed = 0
        for m in members:
            if m in s:
                s.discard(m)
                removed += 1
        return removed

    async def aclose(self):
        self.closed = True


# ══════════════════════════════════════════════════════════════════════════════
# 1. build_warm_targets — pure
# ══════════════════════════════════════════════════════════════════════════════

class TestBuildWarmTargets:

    def test_returns_two_no_filter_targets(self):
        from app.workers.tasks.cache_warmer_tasks import build_warm_targets
        targets = build_warm_targets()
        assert targets == ["sla", "risk"]

    def test_targets_stable_across_calls(self):
        from app.workers.tasks.cache_warmer_tasks import build_warm_targets
        assert build_warm_targets() == build_warm_targets()


# ══════════════════════════════════════════════════════════════════════════════
# 2. _warm() guards
# ══════════════════════════════════════════════════════════════════════════════

class TestWarmGuards:

    @pytest.mark.asyncio
    async def test_disabled_returns_noop(self, monkeypatch):
        from app.core import config
        from app.workers.tasks import cache_warmer_tasks
        monkeypatch.setattr(config.settings, "AGG_CACHE_ENABLED", False)

        out = await cache_warmer_tasks._warm()
        assert out["status"] == "disabled"
        assert out["warmed"] == 0

    @pytest.mark.asyncio
    async def test_lock_contended_returns_locked(self, monkeypatch):
        from app.core import config
        from app.workers.tasks import cache_warmer_tasks
        monkeypatch.setattr(config.settings, "AGG_CACHE_ENABLED", True)

        fake = FakeAsyncRedis()
        fake.lock_held = True   # another runner holds it
        # _warm() builds its own client via redis.asyncio.from_url — patch that
        import redis.asyncio as aioredis
        monkeypatch.setattr(aioredis, "from_url", lambda *a, **k: fake)

        out = await cache_warmer_tasks._warm()
        assert out["status"] == "locked"
        assert fake.closed is True   # per-run client must be closed

    @pytest.mark.asyncio
    async def test_redis_down_returns_redis_down(self, monkeypatch):
        from app.core import config
        from app.workers.tasks import cache_warmer_tasks
        monkeypatch.setattr(config.settings, "AGG_CACHE_ENABLED", True)

        fake = FakeAsyncRedis()
        fake.down = True
        import redis.asyncio as aioredis
        monkeypatch.setattr(aioredis, "from_url", lambda *a, **k: fake)

        out = await cache_warmer_tasks._warm()
        assert out["status"] == "redis_down"
        assert fake.closed is True


# ══════════════════════════════════════════════════════════════════════════════
# 3. Legacy-key cleanup
# ══════════════════════════════════════════════════════════════════════════════

class TestLegacyCleanup:

    @pytest.mark.asyncio
    async def test_legacy_dirty_tenant_set_deleted_each_cycle(self):
        """Faz 9 #4 — best-effort one-time DEL on every warm cycle (idempotent
        on empty/missing sets; clears stragglers that survived the M6 upgrade)."""
        from app.workers.tasks import cache_warmer_tasks

        fake = FakeAsyncRedis()
        fake.sets["agg:dirty:tenant"] = {"7", "9"}  # stale from before M6

        await cache_warmer_tasks._cleanup_legacy_keys(fake)
        assert "agg:dirty:tenant" in fake.delete_calls
        assert "agg:dirty:tenant" not in fake.sets

    @pytest.mark.asyncio
    async def test_legacy_cleanup_never_raises_on_redis_error(self):
        """Even if Redis throws, the cleanup must not propagate."""
        from app.workers.tasks import cache_warmer_tasks

        fake = FakeAsyncRedis()
        fake.down = True  # any redis call raises
        # _cleanup_legacy_keys catches errors; this must return normally
        await cache_warmer_tasks._cleanup_legacy_keys(fake)


# ══════════════════════════════════════════════════════════════════════════════
# 4. _run_warm orchestration + dirty-device drain
# ══════════════════════════════════════════════════════════════════════════════

class TestRunWarmOrchestration:

    @pytest.mark.asyncio
    async def test_happy_path_warms_both_and_drains_device_markers(self, monkeypatch):
        from app.workers.tasks import cache_warmer_tasks

        fake = FakeAsyncRedis()
        fake.sets["agg:dirty:device"] = {"1", "2"}

        async def stub_warm(kind, sem, settings, cache):
            return True
        monkeypatch.setattr(cache_warmer_tasks, "_warm_target", stub_warm)

        out = await cache_warmer_tasks._run_warm(fake, MagicMock(), MagicMock())

        assert out["status"] == "ok"
        assert out["warmed"] == 2          # no-filter sla + risk
        assert out["errors"] == 0
        assert out["targets"] == 2
        assert out["dirty_devices_seen"] == 2

        srem_keys = [c[0] for c in fake.srem_calls]
        assert "agg:dirty:device" in srem_keys
        # Drain uses SREM, never DELETE on the device set
        assert "agg:dirty:device" not in fake.delete_calls

    @pytest.mark.asyncio
    async def test_no_dirty_devices_still_succeeds(self, monkeypatch):
        """Common steady-state — no device changed since last cycle. Warmer
        still hits both no-filter caches and returns ok."""
        from app.workers.tasks import cache_warmer_tasks

        fake = FakeAsyncRedis()
        # No dirty markers anywhere

        async def stub_warm(kind, sem, settings, cache):
            return True
        monkeypatch.setattr(cache_warmer_tasks, "_warm_target", stub_warm)

        out = await cache_warmer_tasks._run_warm(fake, MagicMock(), MagicMock())

        assert out["status"] == "ok"
        assert out["warmed"] == 2
        assert out["dirty_devices_seen"] == 0
        # Nothing to SREM
        device_srems = [c for c in fake.srem_calls if c[0] == "agg:dirty:device"]
        assert device_srems == []

    @pytest.mark.asyncio
    async def test_no_filter_failure_keeps_device_markers(self, monkeypatch):
        """If a no-filter warm fails, agg:dirty:device must not be drained."""
        from app.workers.tasks import cache_warmer_tasks

        fake = FakeAsyncRedis()
        fake.sets["agg:dirty:device"] = {"1", "2", "3"}

        async def stub_warm(kind, sem, settings, cache):
            if kind == "sla":
                return False   # no-filter sla fails
            return True
        monkeypatch.setattr(cache_warmer_tasks, "_warm_target", stub_warm)

        out = await cache_warmer_tasks._run_warm(fake, MagicMock(), MagicMock())
        assert out["errors"] == 1
        device_srems = [c for c in fake.srem_calls if c[0] == "agg:dirty:device"]
        assert device_srems == [], "device markers must survive a no-filter failure"

    @pytest.mark.asyncio
    async def test_per_target_exception_isolated(self, monkeypatch):
        """One target raising must not abort the others (gather return_exceptions)."""
        from app.workers.tasks import cache_warmer_tasks

        fake = FakeAsyncRedis()

        async def stub_warm(kind, sem, settings, cache):
            if kind == "risk":
                raise RuntimeError("boom")
            return True
        monkeypatch.setattr(cache_warmer_tasks, "_warm_target", stub_warm)

        out = await cache_warmer_tasks._run_warm(fake, MagicMock(), MagicMock())
        # sla succeeded, risk raised → counted as error, no crash
        assert out["status"] == "ok"
        assert out["warmed"] == 1
        assert out["errors"] == 1


# ══════════════════════════════════════════════════════════════════════════════
# 5. Cache key builder drift guard
# ══════════════════════════════════════════════════════════════════════════════

class TestKeyBuilders:

    def test_sla_key_deterministic(self):
        from app.api.v1.endpoints.sla import fleet_summary_cache_key
        k1 = fleet_summary_cache_key(3, None, None, 30, None)
        k2 = fleet_summary_cache_key(3, None, None, 30, None)
        assert k1 == k2
        assert k1 == "agg:sla:fleet:v=3:t=_:loc=_:w=30:s=_"

    def test_risk_key_deterministic(self):
        from app.api.v1.endpoints.intelligence import fleet_risk_cache_key
        k1 = fleet_risk_cache_key(5, None, None, 20)
        k2 = fleet_risk_cache_key(5, None, None, 20)
        assert k1 == k2
        assert k1 == "agg:risk:fleet:v=5:t=_:loc=_:limit=20"

    def test_version_bump_changes_key(self):
        from app.api.v1.endpoints.sla import fleet_summary_cache_key
        assert (fleet_summary_cache_key(1, None, None, 30, None)
                != fleet_summary_cache_key(2, None, None, 30, None))


# ══════════════════════════════════════════════════════════════════════════════
# 6. Task entry point never raises
# ══════════════════════════════════════════════════════════════════════════════

class TestTaskEntryPoint:

    def test_task_returns_error_dict_on_crash(self, monkeypatch):
        """warm_aggregation_cache must swallow any crash and return a dict."""
        from app.workers.tasks import cache_warmer_tasks

        async def boom():
            raise RuntimeError("simulated catastrophic failure")
        monkeypatch.setattr(cache_warmer_tasks, "_warm", boom)

        # Must not raise
        out = cache_warmer_tasks.warm_aggregation_cache()
        assert out["status"] == "error"
        assert out["warmed"] == 0
