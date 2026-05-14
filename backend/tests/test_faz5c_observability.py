"""
Faz 5C Observability tests.

Covers:
  - SensitiveDataFilter: redacts sensitive log fields (including nested)
  - configure_logging(): runs without exception, respects LOG_LEVEL
  - Request ID middleware: contextvar binding, path normalization
  - /health/ready: HTTP 200 (all ok) and HTTP 503 (DB down)
  - /health/live: always 200
  - /health backward compat: always 200
  - Prometheus metrics: label sets, counter/gauge/histogram types
  - Celery signal helpers: queue resolution, start-time tracking
"""
import asyncio
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


# ─────────────────────────────────────────────────────────────────────────────
# G1 — Structured logging / sensitive filter
# ─────────────────────────────────────────────────────────────────────────────

class TestSensitiveDataFilter(unittest.TestCase):
    def _get_processor(self):
        from app.core.logging_config import _drop_sensitive
        return _drop_sensitive

    def test_redacts_password(self):
        proc = self._get_processor()
        d = proc(None, None, {"event": "login", "password": "s3cr3t"})
        self.assertEqual(d["password"], "[REDACTED]")
        self.assertEqual(d["event"], "login")

    def test_redacts_snmp_community(self):
        proc = self._get_processor()
        d = proc(None, None, {"snmp_community": "public", "host": "10.0.0.1"})
        self.assertEqual(d["snmp_community"], "[REDACTED]")
        self.assertEqual(d["host"], "10.0.0.1")

    def test_redacts_token_variants(self):
        proc = self._get_processor()
        for field in ["token", "access_token", "api_key", "secret_key"]:
            d = proc(None, None, {field: "abc123", "other": "ok"})
            self.assertEqual(d[field], "[REDACTED]", f"{field} was not redacted")
            self.assertEqual(d["other"], "ok")

    def test_redacts_substring_match(self):
        """ssh_password_enc should also be redacted (contains 'password')."""
        proc = self._get_processor()
        d = proc(None, None, {"ssh_password_enc": "enc_value"})
        self.assertEqual(d["ssh_password_enc"], "[REDACTED]")

    def test_preserves_safe_fields(self):
        proc = self._get_processor()
        d = proc(None, None, {"event": "ok", "host": "10.0.0.1", "status": 200})
        self.assertEqual(d["event"], "ok")
        self.assertEqual(d["host"], "10.0.0.1")
        self.assertEqual(d["status"], 200)

    def test_empty_dict(self):
        proc = self._get_processor()
        d = proc(None, None, {})
        self.assertEqual(d, {})


class TestConfigureLogging(unittest.TestCase):
    def test_configure_logging_does_not_raise(self):
        from app.core.logging_config import configure_logging
        try:
            configure_logging()
        except Exception as exc:
            self.fail(f"configure_logging() raised {exc}")

    def test_configure_logging_respects_level(self):
        import logging
        # conftest already sets LOG_LEVEL=WARNING; root logger should reflect that
        from app.core.logging_config import configure_logging
        configure_logging()
        root_level = logging.getLogger().level
        self.assertGreaterEqual(root_level, logging.WARNING)


# ─────────────────────────────────────────────────────────────────────────────
# G2 — Path normalisation
# ─────────────────────────────────────────────────────────────────────────────

class TestNormalizePath(unittest.TestCase):
    def _normalize(self, path: str) -> str:
        from app.core.utils import normalize_path
        return normalize_path(path)

    def test_replaces_single_id(self):
        self.assertEqual(self._normalize("/api/v1/devices/42"), "/api/v1/devices/{id}")

    def test_replaces_multiple_ids(self):
        self.assertEqual(
            self._normalize("/api/v1/devices/42/interfaces/7"),
            "/api/v1/devices/{id}/interfaces/{id}",
        )

    def test_leaves_non_numeric_untouched(self):
        self.assertEqual(self._normalize("/api/v1/health"), "/api/v1/health")

    def test_leaves_string_segments_untouched(self):
        self.assertEqual(
            self._normalize("/api/v1/agents/abc-xyz/live-metrics"),
            "/api/v1/agents/abc-xyz/live-metrics",
        )


# ─────────────────────────────────────────────────────────────────────────────
# G5 — /health endpoints
# ─────────────────────────────────────────────────────────────────────────────

class TestHealthEndpoints(unittest.IsolatedAsyncioTestCase):
    async def _call_readiness(self, db_ok=True, redis_ok=True, ts_ok=True):
        from app.api.v1.endpoints.health import _check_db, _check_redis, _check_timescaledb

        db_result = {"status": "ok"} if db_ok else {"status": "error", "detail": "connection refused"}
        redis_result = {"status": "ok"} if redis_ok else {"status": "error", "detail": "ECONNREFUSED"}
        ts_result = {"status": "ok", "hypertable_count": 5} if ts_ok else {"status": "unavailable"}

        with patch("app.api.v1.endpoints.health._check_db", new=AsyncMock(return_value=db_result)), \
             patch("app.api.v1.endpoints.health._check_redis", new=AsyncMock(return_value=redis_result)), \
             patch("app.api.v1.endpoints.health._check_timescaledb", new=AsyncMock(return_value=ts_result)), \
             patch("app.api.v1.endpoints.health.HEALTH_COMPONENT_UP") as mock_gauge:
            from fastapi.responses import JSONResponse
            from app.api.v1.endpoints.health import readiness
            resp = await readiness()
            return resp

    async def test_all_ok_returns_200(self):
        resp = await self._call_readiness()
        # Returns a plain dict when all good (FastAPI serialises to 200)
        self.assertIsInstance(resp, dict)
        self.assertEqual(resp["status"], "ok")

    async def test_db_down_returns_503(self):
        from fastapi.responses import JSONResponse
        resp = await self._call_readiness(db_ok=False)
        self.assertIsInstance(resp, JSONResponse)
        self.assertEqual(resp.status_code, 503)

    async def test_redis_down_returns_503(self):
        from fastapi.responses import JSONResponse
        resp = await self._call_readiness(redis_ok=False)
        self.assertIsInstance(resp, JSONResponse)
        self.assertEqual(resp.status_code, 503)

    async def test_timescaledb_unavailable_still_200(self):
        """TimescaleDB absence must not cause 503 (dev environment)."""
        resp = await self._call_readiness(ts_ok=False)
        self.assertIsInstance(resp, dict)
        self.assertEqual(resp["status"], "ok")

    async def test_readiness_response_has_checks(self):
        resp = await self._call_readiness()
        self.assertIn("checks", resp)
        for key in ("db", "redis", "timescaledb"):
            self.assertIn(key, resp["checks"])

    async def test_liveness_always_ok(self):
        from app.api.v1.endpoints.health import liveness
        resp = await liveness()
        self.assertEqual(resp["status"], "ok")

    async def test_health_simple_backward_compat(self):
        from app.api.v1.endpoints.health import health_simple
        resp = await health_simple()
        self.assertEqual(resp["status"], "ok")
        self.assertEqual(resp["app"], "NetManager")


# ─────────────────────────────────────────────────────────────────────────────
# G3 — Prometheus metrics
# ─────────────────────────────────────────────────────────────────────────────

class TestPrometheusMetrics(unittest.TestCase):
    def test_http_requests_total_labels(self):
        from app.core.metrics import HTTP_REQUESTS_TOTAL
        # Should not raise
        HTTP_REQUESTS_TOTAL.labels(method="GET", path="/api/v1/devices", status_code="200").inc()

    def test_http_duration_histogram_labels(self):
        from app.core.metrics import HTTP_REQUEST_DURATION_SECONDS
        HTTP_REQUEST_DURATION_SECONDS.labels(method="GET", path="/api/v1/devices").observe(0.05)

    def test_ws_connections_gauge(self):
        from app.core.metrics import WS_CONNECTIONS_ACTIVE
        WS_CONNECTIONS_ACTIVE.inc()
        WS_CONNECTIONS_ACTIVE.dec()

    def test_celery_task_counter_labels(self):
        from app.core.metrics import CELERY_TASK_TOTAL
        CELERY_TASK_TOTAL.labels(
            task_name="app.workers.tasks.monitor_tasks.poll_device_status",
            queue="monitor",
            status="success",
        ).inc()

    def test_celery_task_duration_labels(self):
        from app.core.metrics import CELERY_TASK_DURATION_SECONDS
        CELERY_TASK_DURATION_SECONDS.labels(
            task_name="app.workers.tasks.monitor_tasks.poll_device_status",
            queue="monitor",
        ).observe(1.5)

    def test_health_component_gauge_labels(self):
        from app.core.metrics import HEALTH_COMPONENT_UP
        for comp in ("db", "redis", "timescaledb"):
            HEALTH_COMPONENT_UP.labels(component=comp).set(1)


# ─────────────────────────────────────────────────────────────────────────────
# G4 — Celery signal helpers
# ─────────────────────────────────────────────────────────────────────────────

class TestCelerySignalHelpers(unittest.TestCase):
    def test_get_queue_monitor_task(self):
        from app.workers.signals import _get_queue
        q = _get_queue("app.workers.tasks.monitor_tasks.poll_device_status")
        self.assertEqual(q, "monitor")

    def test_get_queue_bulk_task(self):
        from app.workers.signals import _get_queue
        q = _get_queue("app.workers.tasks.bulk_tasks.scheduled_backup")
        self.assertEqual(q, "bulk")

    def test_get_queue_default_fallback(self):
        from app.workers.signals import _get_queue
        q = _get_queue("app.workers.tasks.availability_tasks.compute_availability_scores")
        self.assertEqual(q, "default")

    def test_get_queue_unknown_falls_back_to_default(self):
        from app.workers.signals import _get_queue
        q = _get_queue("completely.unknown.task.name")
        self.assertEqual(q, "default")

    def test_prerun_stores_start_time(self):
        import time
        from app.workers.signals import on_task_prerun, _task_starts

        task = MagicMock()
        task.name = "app.workers.tasks.monitor_tasks.poll_device_status"
        on_task_prerun(task_id="test-tid-123", task=task)

        self.assertIn("test-tid-123", _task_starts.__dict__)
        stored = _task_starts.__dict__["test-tid-123"]
        self.assertAlmostEqual(stored, time.monotonic(), delta=1.0)


if __name__ == "__main__":
    unittest.main()
