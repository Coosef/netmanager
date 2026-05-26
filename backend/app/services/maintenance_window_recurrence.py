"""T9 Tur 6A — Cyclic maintenance windows.

Pure helpers for computing next occurrences from a MaintenanceWindow template
(no DB access here — easier to unit-test). The Celery beat task in
`app/workers/tasks/maintenance_tasks.py` calls these.

Semantics:
  recurrence='daily'   → repeats every day at template's HH:MM (duration preserved)
  recurrence='weekly'  → repeats on each weekday listed in recur_days_of_week (Mon=0..Sun=6)
  recurrence='monthly' → repeats on recur_day_of_month (1-28) each month

A child instance has parent_window_id=template.id and recurrence=NULL — the
suppression check `start_time<=now<=end_time` keeps working unchanged.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional


@dataclass
class RecurrenceTemplate:
    """The fields needed to compute next occurrences. Read these off the
    MaintenanceWindow row before calling — the helpers stay DB-free."""

    start_time: datetime
    end_time: datetime
    recurrence: str  # 'daily' | 'weekly' | 'monthly'
    recur_days_of_week: list[int] | None = None
    recur_day_of_month: int | None = None
    recur_until: datetime | None = None


def _at_template_time(target_date: datetime, template_time: datetime) -> datetime:
    """Combine a calendar date with the template's HH:MM:SS (UTC)."""
    return target_date.replace(
        hour=template_time.hour,
        minute=template_time.minute,
        second=template_time.second,
        microsecond=0,
    )


def _next_daily(template: RecurrenceTemplate, after: datetime) -> Optional[datetime]:
    """Next daily occurrence strictly after `after`."""
    candidate = _at_template_time(after, template.start_time)
    if candidate <= after:
        candidate += timedelta(days=1)
    return candidate


def _next_weekly(template: RecurrenceTemplate, after: datetime) -> Optional[datetime]:
    """Next weekly occurrence — earliest day in recur_days_of_week > after."""
    days = sorted(set(template.recur_days_of_week or []))
    if not days:
        return None
    # Scan up to 14 days ahead — covers any list of weekdays.
    for delta in range(0, 15):
        d = after + timedelta(days=delta)
        if d.weekday() not in days:
            continue
        candidate = _at_template_time(d, template.start_time)
        if candidate > after:
            return candidate
    return None


def _next_monthly(template: RecurrenceTemplate, after: datetime) -> Optional[datetime]:
    """Next monthly occurrence on recur_day_of_month (1-28)."""
    dom = template.recur_day_of_month
    if dom is None or not 1 <= dom <= 28:
        return None
    # Build candidate in `after`'s month — if it's already past, roll forward.
    year, month = after.year, after.month
    for _ in range(13):  # safety bound
        try:
            candidate = after.replace(year=year, month=month, day=dom)
        except ValueError:
            candidate = None
        if candidate is not None:
            candidate = _at_template_time(candidate, template.start_time)
            if candidate > after:
                return candidate
        # next month
        if month == 12:
            year += 1; month = 1
        else:
            month += 1
    return None


def next_occurrence(template: RecurrenceTemplate, after: datetime) -> Optional[datetime]:
    """Compute the next start_time strictly after `after`.

    Returns None when:
      - recurrence is unknown / unsupported
      - recur_until is set and the next computed occurrence is past it
      - weekly with no days_of_week, monthly with no day_of_month
    """
    if template.recurrence == "daily":
        nxt = _next_daily(template, after)
    elif template.recurrence == "weekly":
        nxt = _next_weekly(template, after)
    elif template.recurrence == "monthly":
        nxt = _next_monthly(template, after)
    else:
        return None
    if nxt is None:
        return None
    if template.recur_until is not None and nxt > template.recur_until:
        return None
    return nxt


def upcoming_occurrences(
    template: RecurrenceTemplate, after: datetime, *, count: int,
) -> Iterable[datetime]:
    """Yield up to `count` future start_times after `after`."""
    cursor = after
    produced = 0
    while produced < count:
        nxt = next_occurrence(template, cursor)
        if nxt is None:
            return
        yield nxt
        cursor = nxt
        produced += 1


def computed_duration(template: RecurrenceTemplate) -> timedelta:
    """End - start of the template — the same duration applies to every spawn."""
    return template.end_time - template.start_time
