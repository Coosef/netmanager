"""
Celery signal handlers — Faz 5C.

Registers task_prerun / task_postrun / task_failure hooks to:
  - Configure structlog in each worker process
  - Bind celery_task_id to structlog context for log correlation
  - Record task duration and success/failure in Prometheus metrics

Plus (T9, 2026-05-21) a `worker_process_shutdown` hook that calls
`prometheus_client.multiprocess.mark_process_dead` so each forked
worker child cleans up its per-PID `.db` files in
`PROMETHEUS_MULTIPROC_DIR` instead of leaving them to accumulate
across child respawns. See
`docs/POSTMORTEM_2026-05-21_PROM_MULTIPROC_TMPFS.md`.

This module is imported (side-effect import) at the bottom of celery_app.py
so signals self-register when the worker process starts.
"""
import os
import threading
import time

import structlog
from celery.signals import (
    task_failure,
    task_postrun,
    task_prerun,
    worker_process_init,
    worker_process_shutdown,
)

from app.core.metrics import CELERY_TASK_DURATION_SECONDS, CELERY_TASK_TOTAL

_task_starts: threading.local = threading.local()
log = structlog.get_logger("netmanager.celery")


# ── Worker init ───────────────────────────────────────────────────────────────

@worker_process_init.connect
def _configure_worker_logging(**kwargs):
    """Call configure_logging() in each spawned worker process."""
    from app.core.logging_config import configure_logging
    configure_logging()


# ── Worker shutdown — prometheus_multiproc cleanup (T9) ───────────────────────

@worker_process_shutdown.connect
def _cleanup_prom_multiproc_on_child_exit(**kwargs):
    """Mark this worker child's per-PID prometheus .db files dead so they
    are unlinked from the multiproc dir before the parent recycles the
    child.

    Without this, every child respawn (e.g. `worker_max_tasks_per_child`,
    crash recovery) leaves stale `.db` files behind. Over thousands of
    respawns the multiproc tmpfs saturates and mmap writes start
    returning SIGBUS — the failure mode that caused the
    2026-05-21 prod outage (see post-mortem). `mark_process_dead` is a
    standard prometheus_client API for exactly this scenario.

    Failure is non-fatal — the child is exiting anyway; logging at debug
    keeps healthy shutdowns silent.
    """
    if not os.environ.get("PROMETHEUS_MULTIPROC_DIR"):
        return  # multiproc disabled (e.g. dev / tests) — nothing to clean
    try:
        from prometheus_client import multiprocess
        multiprocess.mark_process_dead(os.getpid())
    except Exception as exc:
        log.debug("prom_multiproc cleanup failed", pid=os.getpid(), exc=str(exc))


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
    # Faz 8 Phase E — a task enqueued with enqueue_scoped() carries the
    # validated (organization_id, location_id) of the user action that
    # created it; the worker runs under exactly that scope (RLS-enforced).
    # A task with no scope envelope is system-owned — beat jobs and
    # fleet-wide sweeps — and keeps the super-admin context; its row
    # writes are still org-stamped per row by the before_insert hook.
    from app.workers.task_scope import apply_task_scope, scope_from_request
    scope = scope_from_request(getattr(task, "request", None))
    scoped = apply_task_scope(scope)
    log.info("task_started", task_name=task.name, scoped=scoped)


@task_postrun.connect
def on_task_postrun(task_id: str, task, state: str, **kwargs):
    start = _task_starts.__dict__.pop(task_id, time.monotonic())
    duration = time.monotonic() - start
    queue = _get_queue(task.name)
    CELERY_TASK_DURATION_SECONDS.labels(task_name=task.name, queue=queue).observe(duration)
    CELERY_TASK_TOTAL.labels(task_name=task.name, queue=queue, status="success").inc()
    from app.core.org_context import clear_org_context
    clear_org_context()
    log.info("task_completed", task_name=task.name, duration_s=round(duration, 3), state=state)


@task_failure.connect
def on_task_failure(sender, task_id: str, exception: Exception, **kwargs):
    task_name = getattr(sender, "name", "unknown")
    queue = _get_queue(task_name)
    CELERY_TASK_TOTAL.labels(task_name=task_name, queue=queue, status="failure").inc()
    log.error("task_failed", task_name=task_name, error=str(exception))
