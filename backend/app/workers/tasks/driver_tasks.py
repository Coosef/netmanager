"""Celery tasks for driver template operations (probe_device)."""
import asyncio
import json

from sqlalchemy import update

from app.models.task import Task, TaskStatus
from app.workers.celery_app import celery_app


def _get_db():
    from app.core.database import SyncSessionLocal
    return SyncSessionLocal()


def _run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _finish_task(db, task_id: int, status: str, result: dict | None = None, error: str | None = None):
    db.execute(
        update(Task).where(Task.id == task_id).values(
            status=status,
            result=result,
            error=error,
        )
    )
    db.commit()


@celery_app.task(bind=True, name="app.workers.tasks.driver_tasks.probe_device_task")
def probe_device_task(self, task_id: int, device_id: int):
    db = _get_db()
    try:
        result = _run_async(_do_probe(device_id))
        _finish_task(db, task_id, TaskStatus.SUCCESS, result=result)
    except Exception as exc:
        _finish_task(db, task_id, TaskStatus.FAILED, error=str(exc))
    finally:
        db.close()


async def _do_probe(device_id: int) -> dict:
    """Run the full probe logic with a fresh async session."""
    from app.core.database import AsyncSessionLocal
    from app.api.v1.endpoints.driver_templates import _run_probe_logic
    async with AsyncSessionLocal() as db:
        return await _run_probe_logic(db, device_id)
