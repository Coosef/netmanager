"""
Faz 6B G5 — cache warmer tests.

Coverage:
  * build_warm_targets — pure: no-filter always present, per-tenant added,
    deduplicated, non-integer tenant members skipped.
  * _warm() guards:
      - AGG_CACHE_ENABLED=false → status=disabled, no Redis touched
      - warmer lock already held → status=locked
      - Redis down on lock attempt → status=redis_down (no raise)
  * _run_warm orchestration:
      - dirty tenants drive extra targets
      - SREM drains only fully-warmed tenants (failed tenant marker survives)
      - dirty:device cleared only when no-filter warm succeeded
      - drain uses SREM (member-specific), never DEL
  * fleet cache key builders are drift-free (same key for same inputs).
  * warm_aggregation_cache task never raises (returns error dict on crash).
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


# ══════════════════════════════════════════════════════════════════════════════
# 1. build_warm_targets — pure
# ══════════════════════════════════════════════════════════════════════════════

class TestBuildWarmTargets:

    def test_no_dirty_tenants_gives_two_no_filter_targets(self):
        from app.workers.tasks.cache_warmer_tasks import build_warm_targets
        targets = build_warm_targets(set())
        assert targets == [("sla", None), ("risk", None)]

    def test_dirty_tenants_add_per_tenant_targets(self):
        from app.workers.tasks.cache_warmer_tasks import build_warm_targets
        targets = build_warm_targets({"7", "9"})
        assert ("sla", None) in targets
        assert ("risk", None) in targets
        assert ("sla", 7) in targets
        assert ("risk", 7) in targets
        assert ("sla", 9) in targets
        assert ("risk", 9) in targets
        assert len(targets) == 6

    def test_non_integer_tenant_members_skipped(self):
        from app.workers.tasks.cache_warmer_tasks import build_warm_targets
        targets = build_warm_targets({"42", "garbage", "", None})
        assert ("sla", 42) in targets
        # only no-filter (2) + tenant 42 (2) = 4
        assert len(targets) == 4

    def test_targets_deduplicated(self):
        from app.workers.tasks.cache_warmer_tasks import build_warm_targets
        # Same tenant twice (set already dedups, but verify no dup output)
        targets = build_warm_targets({"5"})
        assert len(targets) == len(set(targets))


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
        monkeypatch.setattr(
            "app.core.redis_client.get_redis", lambda: fake,
        )
        out = await cache_warmer_tasks._warm()
        assert out["status"] == "locked"

    @pytest.mark.asyncio
    async def test_redis_down_returns_redis_down(self, monkeypatch):
        from app.core import config
        from app.workers.tasks import cache_warmer_tasks
        monkeypatch.setattr(config.settings, "AGG_CACHE_ENABLED", True)

        fake = FakeAsyncRedis()
        fake.down = True
        monkeypatch.setattr(
            "app.core.redis_client.get_redis", lambda: fake,
        )
        out = await cache_warmer_tasks._warm()
        assert out["status"] == "redis_down"


# ══════════════════════════════════════════════════════════════════════════════
# 3. _run_warm orchestration + dirty drain
# ══════════════════════════════════════════════════════════════════════════════

class TestRunWarmOrchestration:

    @pytest.mark.asyncio
    async def test_all_success_drains_dirty_tenants(self, monkeypatch):
        from app.workers.tasks import cache_warmer_tasks

        fake = FakeAsyncRedis()
        fake.sets["agg:dirty:tenant"] = {"7"}
        fake.sets["agg:dirty:device"] = {"1", "2"}

        # Every warm succeeds
        async def stub_warm(kind, tid, sem, settings):
            return True
        monkeypatch.setattr(cache_warmer_tasks, "_warm_target", stub_warm)

        settings = MagicMock()
        out = await cache_warmer_tasks._run_warm(fake, settings)

        assert out["status"] == "ok"
        assert out["warmed"] == 4   # no-filter sla+risk + tenant7 sla+risk
        assert out["errors"] == 0
        # Tenant 7 fully warmed → SREM'd
        srem_keys = [c[0] for c in fake.srem_calls]
        assert "agg:dirty:tenant" in srem_keys
        assert "agg:dirty:device" in srem_keys
        # Drain used SREM, never DELETE on the dirty sets
        assert "agg:dirty:tenant" not in fake.delete_calls
        assert "agg:dirty:device" not in fake.delete_calls

    @pytest.mark.asyncio
    async def test_failed_tenant_marker_survives(self, monkeypatch):
        """If tenant 9's risk warm fails, its dirty marker must NOT be removed."""
        from app.workers.tasks import cache_warmer_tasks

        fake = FakeAsyncRedis()
        fake.sets["agg:dirty:tenant"] = {"9"}

        async def stub_warm(kind, tid, sem, settings):
            # tenant 9 risk fails; everything else ok
            if kind == "risk" and tid == 9:
                return False
            return True
        monkeypatch.setattr(cache_warmer_tasks, "_warm_target", stub_warm)

        out = await cache_warmer_tasks._run_warm(fake, MagicMock())
        assert out["errors"] == 1
        # tenant 9 NOT fully warmed → not in any SREM for the tenant set
        tenant_srems = [c[1] for c in fake.srem_calls if c[0] == "agg:dirty:tenant"]
        for members in tenant_srems:
            assert "9" not in members

    @pytest.mark.asyncio
    async def test_no_filter_failure_keeps_device_markers(self, monkeypatch):
        """If a no-filter warm fails, agg:dirty:device must not be drained."""
        from app.workers.tasks import cache_warmer_tasks

        fake = FakeAsyncRedis()
        fake.sets["agg:dirty:device"] = {"1", "2", "3"}

        async def stub_warm(kind, tid, sem, settings):
            if kind == "sla" and tid is None:
                return False   # no-filter sla fails
            return True
        monkeypatch.setattr(cache_warmer_tasks, "_warm_target", stub_warm)

        await cache_warmer_tasks._run_warm(fake, MagicMock())
        device_srems = [c for c in fake.srem_calls if c[0] == "agg:dirty:device"]
        assert device_srems == [], "device markers must survive a no-filter failure"

    @pytest.mark.asyncio
    async def test_per_target_exception_isolated(self, monkeypatch):
        """One target raising must not abort the others (gather return_exceptions)."""
        from app.workers.tasks import cache_warmer_tasks

        fake = FakeAsyncRedis()

        async def stub_warm(kind, tid, sem, settings):
            if kind == "risk":
                raise RuntimeError("boom")
            return True
        monkeypatch.setattr(cache_warmer_tasks, "_warm_target", stub_warm)

        out = await cache_warmer_tasks._run_warm(fake, MagicMock())
        # sla succeeded, risk raised → counted as error, no crash
        assert out["status"] == "ok"
        assert out["warmed"] == 1
        assert out["errors"] == 1


# ══════════════════════════════════════════════════════════════════════════════
# 4. Cache key builder drift guard
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

    def test_sla_key_tenant_segment(self):
        from app.api.v1.endpoints.sla import fleet_summary_cache_key
        k = fleet_summary_cache_key(1, 42, None, 30, None)
        assert ":t=42:" in k

    def test_risk_key_tenant_segment(self):
        from app.api.v1.endpoints.intelligence import fleet_risk_cache_key
        k = fleet_risk_cache_key(1, 42, None, 20)
        assert ":t=42:" in k

    def test_version_bump_changes_key(self):
        from app.api.v1.endpoints.sla import fleet_summary_cache_key
        assert (fleet_summary_cache_key(1, None, None, 30, None)
                != fleet_summary_cache_key(2, None, None, 30, None))


# ══════════════════════════════════════════════════════════════════════════════
# 5. Task entry point never raises
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
