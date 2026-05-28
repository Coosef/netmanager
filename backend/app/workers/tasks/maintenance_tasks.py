"""T9 Tur 6A — Cyclic maintenance window beat task.

Hourly: for each MaintenanceWindow template (recurrence IS NOT NULL,
parent_window_id IS NULL), materialize the next few occurrences as child
instance rows so the existing alert-suppression check (which reads
one-shot start_time/end_time) keeps working unchanged.

Spawn horizon: 14 days. We never spawn more than recur_count_max children
in total, and we stop creating instances past recur_until.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, select

from app.workers.celery_app import celery_app

log = logging.getLogger("netmanager.maintenance")

# How far ahead do we materialize child instances? 14d covers weekly +
# a comfortable lead time; daily templates produce at most 14 instances
# between two beat runs (in practice 1, since we run hourly).
SPAWN_HORIZON_DAYS = 14


@celery_app.task(name="app.workers.tasks.maintenance_tasks.spawn_cyclic_maintenance_windows")
def spawn_cyclic_maintenance_windows():
    """Materialize the next ~14d of cyclic MW instances as one-shot rows."""
    from app.core.database import SyncSessionLocal
    from app.core.org_context import org_context
    from app.models.maintenance_window import MaintenanceWindow
    from app.services.maintenance_window_recurrence import (
        RecurrenceTemplate, computed_duration, upcoming_occurrences,
    )

    now = datetime.now(timezone.utc)

    db = SyncSessionLocal()
    try:
        # T10 A2 — horizon system_settings'ten (global scope); kod sabiti fallback.
        from app.services import system_settings_service as _svc
        horizon_days = int(_svc.get_sync(db, "maintenance.spawn_horizon_days"))
        horizon = now + timedelta(days=horizon_days)
        # Bypass RLS for the scan; we re-stamp organization_id per child
        # from the template, so the child still belongs to the right org.
        from app.core.org_context import superadmin_context
        with superadmin_context():
            templates = db.execute(
                select(MaintenanceWindow).where(
                    and_(
                        MaintenanceWindow.recurrence.isnot(None),
                        MaintenanceWindow.parent_window_id.is_(None),
                    )
                )
            ).scalars().all()
            total_spawned = 0
            for tpl in templates:
                spawned = _spawn_for_template(db, tpl, now=now, horizon=horizon)
                total_spawned += spawned

            if total_spawned:
                db.commit()
                log.info(
                    "cyclic_maintenance: spawned %d new instances across %d templates",
                    total_spawned, len(templates),
                )
    except Exception:
        log.exception("cyclic_maintenance: spawn task failed")
        db.rollback()
    finally:
        db.close()


def _spawn_for_template(db, tpl, *, now: datetime, horizon: datetime) -> int:
    """Spawn missing child instances for one template. Returns the count.

    Uses the template's own org/location via org_context so the child row
    is stamped correctly under the before_insert hook + RLS WITH CHECK.
    """
    from app.core.org_context import org_context
    from app.models.maintenance_window import MaintenanceWindow
    from app.services.maintenance_window_recurrence import (
        RecurrenceTemplate, computed_duration, upcoming_occurrences,
    )

    rt = RecurrenceTemplate(
        start_time=tpl.start_time,
        end_time=tpl.end_time,
        recurrence=tpl.recurrence,
        recur_days_of_week=tpl.recur_days_of_week,
        recur_day_of_month=tpl.recur_day_of_month,
        recur_until=tpl.recur_until,
    )
    duration = computed_duration(rt)

    # Children already spawned (start_time-keyed for dedup).
    existing_starts = set(db.execute(
        select(MaintenanceWindow.start_time).where(
            MaintenanceWindow.parent_window_id == tpl.id,
        )
    ).scalars().all())

    # Respect recur_count_max — total children including the ones we're
    # about to create.
    existing_count = len(existing_starts)
    max_count = tpl.recur_count_max
    remaining_quota = (max_count - existing_count) if max_count is not None else None

    spawned = 0
    # We materialize up to ~30 occurrences but clip by horizon — daily
    # cap of 14 covers 14d, weekly even less.
    with org_context(tpl.organization_id):
        for occ in upcoming_occurrences(rt, after=now, count=30):
            if occ > horizon:
                break
            if remaining_quota is not None and remaining_quota <= 0:
                break
            if occ in existing_starts:
                continue
            child = MaintenanceWindow(
                name=f"{tpl.name} — {occ.strftime('%Y-%m-%d %H:%M')}",
                description=(tpl.description or ""),
                start_time=occ,
                end_time=occ + duration,
                applies_to_all=tpl.applies_to_all,
                device_ids=list(tpl.device_ids or []),
                parent_window_id=tpl.id,
                # NB: children are one-shot. Leave recurrence=NULL.
                created_by=tpl.created_by,
            )
            db.add(child)
            spawned += 1
            if remaining_quota is not None:
                remaining_quota -= 1

        if spawned:
            db.execute(
                MaintenanceWindow.__table__.update()
                .where(MaintenanceWindow.id == tpl.id)
                .values(recur_instances_spawned=existing_count + spawned)
            )

    return spawned
