"""
Celery signal handlers — Faz 5C.

Registers task_prerun / task_postrun / task_failure hooks to:
  - Configure structlog in each worker process
  - Bind celery_task_id to structlog context for log correlation
  - Record task duration and success/failure in Prometheus metrics

This module is imported (side-effect import) at the bottom of celery_app.py
so signals self-register when the worker process starts.
"""
import threading
import time

import structlog
from celery.signals import task_failure, task_postrun, task_prerun, worker_process_init

from app.core.metrics import CELERY_TASK_DURATION_SECONDS, CELERY_TASK_TOTAL

_task_starts: threading.local = threading.local()
log = structlog.get_logger("netmanager.celery")


# ── Worker init ───────────────────────────────────────────────────────────────

@worker_process_init.connect
def _configure_worker_logging(**kwargs):
    """Call configure_logging() in each spawned worker process."""
    from app.core.logging_config import configure_logging
    configure_logging()


# ── Queue resolution helper ───────────────────────────────────────────────────

def _get_queue(task_name: str) -> str:
    """Resolve queue name from celery_app.conf.task_routes (wildcard-aware)."""
    try:
        from app.workers.celery_app import celery_app
        routes = celery_app.conf.task_routes or {}
        if task_name in routes:
            return routes[task_name].get("queue", "default")
        for pattern, route in routes.items():
            if pattern.endswith(".*") and task_name.startswith(pattern[:-2]):
                return route.get("queue", "default")
    except Exception:
        pass
    return "default"


# ── Task lifecycle ────────────────────────────────────────────────────────────

@task_prerun.connect
def on_task_prerun(task_id: str, task, **kwargs):
    _task_starts.__dict__[task_id] = time.monotonic()
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(celery_task_id=task_id, task_name=task.name)
    log.info("task_started", task_name=task.name)


@task_postrun.connect
def on_task_postrun(task_id: str, task, state: str, **kwargs):
    start = _task_starts.__dict__.pop(task_id, time.monotonic())
    duration = time.monotonic() - start
    queue = _get_queue(task.name)
    CELERY_TASK_DURATION_SECONDS.labels(task_name=task.name, queue=queue).observe(duration)
    CELERY_TASK_TOTAL.labels(task_name=task.name, queue=queue, status="success").inc()
    log.info("task_completed", task_name=task.name, duration_s=round(duration, 3), state=state)


@task_failure.connect
def on_task_failure(sender, task_id: str, exception: Exception, **kwargs):
    task_name = getattr(sender, "name", "unknown")
    queue = _get_queue(task_name)
    CELERY_TASK_TOTAL.labels(task_name=task_name, queue=queue, status="failure").inc()
    log.error("task_failed", task_name=task_name, error=str(exception))
