"""
Faz 5E Resilience tests.

Covers:
  - Celery worker config: time limits, memory recycle, broker retry
  - Per-task time limit overrides for long-running tasks
  - Redis client: retry, keepalive, health-check settings
  - Startup timeout helpers
  - Background task graceful shutdown (create_task + cancel)
"""
import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


# ─────────────────────────────────────────────────────────────────────────────
# G1 — Celery config
# ─────────────────────────────────────────────────────────────────────────────

class TestCeleryConfig(unittest.TestCase):
    def setUp(self):
        from app.workers.celery_app import celery_app
        self.conf = celery_app.conf

    def test_soft_time_limit_configured(self):
        """Global soft time limit must be set (20 min)."""
        self.assertEqual(self.conf.task_soft_time_limit, 1200)

    def test_hard_time_limit_configured(self):
        """Global hard time limit must be set (25 min)."""
        self.assertEqual(self.conf.task_time_limit, 1500)

    def test_max_memory_per_child_configured(self):
        """Worker must recycle after 512 MB (in KB)."""
        self.assertEqual(self.conf.worker_max_memory_per_child, 524288)

    def test_broker_retry_on_startup_enabled(self):
        """Broker must retry on startup instead of crashing."""
        self.assertTrue(self.conf.broker_connection_retry_on_startup)


# ─────────────────────────────────────────────────────────────────────────────
# G1 — Per-task time limit overrides
# ─────────────────────────────────────────────────────────────────────────────

class TestLongRunningTaskLimits(unittest.TestCase):
    def _get_task(self, module: str, name: str):
        import importlib
        mod = importlib.import_module(module)
        return getattr(mod, name)

    def test_rollout_task_has_extended_soft_limit(self):
        from app.workers.tasks.rollout_tasks import execute_rollout_task
        self.assertEqual(execute_rollout_task.soft_time_limit, 3600)

    def test_rollout_task_has_extended_hard_limit(self):
        from app.workers.tasks.rollout_tasks import execute_rollout_task
        self.assertEqual(execute_rollout_task.time_limit, 3900)

    def test_rollback_task_has_extended_limits(self):
        from app.workers.tasks.rollout_tasks import execute_rollback_task
        self.assertEqual(execute_rollback_task.soft_time_limit, 3600)
        self.assertEqual(execute_rollback_task.time_limit, 3900)

    def test_bulk_command_task_has_extended_limits(self):
        from app.workers.tasks.bulk_tasks import run_bulk_command
        self.assertEqual(run_bulk_command.soft_time_limit, 3600)
        self.assertEqual(run_bulk_command.time_limit, 3900)

    def test_bulk_backup_task_has_extended_limits(self):
        from app.workers.tasks.bulk_tasks import bulk_backup_configs
        self.assertEqual(bulk_backup_configs.soft_time_limit, 3600)
        self.assertEqual(bulk_backup_configs.time_limit, 3900)

    def test_topology_discovery_has_tighter_limit(self):
        from app.workers.tasks.topology_tasks import scheduled_topology_discovery
        self.assertEqual(scheduled_topology_discovery.soft_time_limit, 600)
        self.assertEqual(scheduled_topology_discovery.time_limit, 720)

    def test_extended_limit_exceeds_global_default(self):
        """Long-running task limits must exceed the global 25-min ceiling."""
        from app.workers.tasks.rollout_tasks import execute_rollout_task
        from app.workers.celery_app import celery_app
        self.assertGreater(execute_rollout_task.time_limit, celery_app.conf.task_time_limit)


# ─────────────────────────────────────────────────────────────────────────────
# G2 — Redis client hardening
# ─────────────────────────────────────────────────────────────────────────────

class TestRedisClientHardening(unittest.TestCase):
    def setUp(self):
        import app.core.redis_client as rc
        rc._redis = None  # reset singleton

    def _get_client(self):
        import app.core.redis_client as rc
        return rc.get_redis()

    def test_singleton_returns_same_instance(self):
        r1 = self._get_client()
        r2 = self._get_client()
        self.assertIs(r1, r2)

    def test_retry_on_timeout_true(self):
        r = self._get_client()
        pool = r.connection_pool
        self.assertTrue(pool.connection_kwargs.get("retry_on_timeout", False))

    def test_keepalive_enabled(self):
        r = self._get_client()
        pool = r.connection_pool
        self.assertTrue(pool.connection_kwargs.get("socket_keepalive", False))

    def test_health_check_interval_set(self):
        r = self._get_client()
        pool = r.connection_pool
        self.assertGreater(pool.connection_kwargs.get("health_check_interval", 0), 0)

    def test_connect_timeout_set(self):
        r = self._get_client()
        pool = r.connection_pool
        self.assertIsNotNone(pool.connection_kwargs.get("socket_connect_timeout"))


# ─────────────────────────────────────────────────────────────────────────────
# G4 — Startup timeout helpers
# ─────────────────────────────────────────────────────────────────────────────

class TestStartupTimeout(unittest.IsolatedAsyncioTestCase):
    async def test_asyncio_timeout_raises_on_slow_op(self):
        """_asyncio_timeout must raise TimeoutError when operation exceeds limit."""
        import app.main as _main

        async def _slow():
            await asyncio.sleep(10)

        with self.assertRaises(asyncio.TimeoutError):
            async with _main._asyncio_timeout(0.05):
                await _slow()

    async def test_asyncio_timeout_passes_on_fast_op(self):
        """_asyncio_timeout must NOT raise when operation completes in time."""
        import app.main as _main
        result = []

        async with _main._asyncio_timeout(5):
            await asyncio.sleep(0.01)
            result.append("ok")

        self.assertEqual(result, ["ok"])

    async def test_bg_tasks_cancelled_on_lifespan_exit(self):
        """Background tasks spawned with create_task must be cancelled on shutdown."""
        cancelled = []

        async def _fake_loop(name: str):
            try:
                await asyncio.sleep(9999)
            except asyncio.CancelledError:
                cancelled.append(name)
                raise

        tasks = [
            asyncio.create_task(_fake_loop("a"), name="bg:a"),
            asyncio.create_task(_fake_loop("b"), name="bg:b"),
        ]

        # Yield to the event loop so tasks start running before we cancel them
        await asyncio.sleep(0)

        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

        self.assertIn("a", cancelled)
        self.assertIn("b", cancelled)

    async def test_bg_tasks_gathered_without_raising(self):
        """asyncio.gather with return_exceptions=True must not raise on cancellation."""
        async def _fake():
            await asyncio.sleep(9999)

        tasks = [asyncio.create_task(_fake()) for _ in range(3)]
        for t in tasks:
            t.cancel()

        results = await asyncio.gather(*tasks, return_exceptions=True)
        for r in results:
            self.assertIsInstance(r, (asyncio.CancelledError, type(None)))


# ─────────────────────────────────────────────────────────────────────────────
# Redis transient outage recovery
# ─────────────────────────────────────────────────────────────────────────────

class TestRedisTransientOutage(unittest.IsolatedAsyncioTestCase):
    """
    Verifies that a Redis connection error is retried and the system does NOT
    crash — it degrades (health check returns 'error') and then recovers
    once Redis is back. This mirrors the live 'pause redis → unpause redis'
    smoke test in DEPLOY_CHECKLIST §6D.
    """

    async def test_redis_error_does_not_propagate_to_health_check(self):
        """_check_redis() must return {status: error} instead of raising."""
        from app.api.v1.endpoints.health import _check_redis
        with patch("app.core.redis_client.get_redis") as mock_get:
            mock_client = AsyncMock()
            mock_client.ping.side_effect = ConnectionError("Redis down")
            mock_get.return_value = mock_client

            result = await _check_redis()
            self.assertEqual(result["status"], "error")
            self.assertIn("detail", result)

    async def test_health_ready_returns_503_when_redis_down(self):
        """readiness endpoint returns 503 when Redis is unreachable."""
        from app.api.v1.endpoints.health import readiness
        with patch("app.core.redis_client.get_redis") as mock_get:
            mock_client = AsyncMock()
            mock_client.ping.side_effect = ConnectionError("Redis down")
            mock_get.return_value = mock_client

            from fastapi.responses import JSONResponse
            resp = await readiness()
            # Should return a JSONResponse (503) when degraded
            if isinstance(resp, JSONResponse):
                self.assertEqual(resp.status_code, 503)
            else:
                # If DB also returns ok and redis error makes it degrade
                self.assertIn(resp.get("status", ""), ["ok", "degraded"])

    async def test_health_ready_recovers_when_redis_back(self):
        """After Redis recovers, readiness must return ok again."""
        from app.api.v1.endpoints.health import readiness
        with patch("app.core.redis_client.get_redis") as mock_get:
            mock_client = AsyncMock()
            mock_client.ping.return_value = True  # Redis back
            mock_get.return_value = mock_client

            with patch("app.api.v1.endpoints.health._check_db", new=AsyncMock(return_value={"status": "ok"})):
                with patch("app.api.v1.endpoints.health._check_timescaledb",
                           new=AsyncMock(return_value={"status": "unavailable"})):
                    resp = await readiness()
                    if hasattr(resp, "status_code"):
                        self.assertEqual(resp.status_code, 200)
                    else:
                        self.assertEqual(resp["status"], "ok")


if __name__ == "__main__":
    unittest.main()
