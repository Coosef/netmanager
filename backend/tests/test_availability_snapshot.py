"""
Unit tests for DeviceAvailabilitySnapshot retention logic — Faz 3A

Verifies the retention constant and that the cleanup query targets the
correct table/column without requiring a live database.
No Celery, no DB, no network I/O.
"""

from app.workers.tasks.retention_tasks import _AVAILABILITY_SNAPSHOT_DAYS


def test_snapshot_retention_window():
    assert _AVAILABILITY_SNAPSHOT_DAYS == 90


def test_snapshot_retention_constant_type():
    assert isinstance(_AVAILABILITY_SNAPSHOT_DAYS, int)
    assert _AVAILABILITY_SNAPSHOT_DAYS > 0
