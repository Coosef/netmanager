"""
Unit tests for DeviceAvailabilitySnapshot retention — Faz 3A / updated Faz 4B

After Faz 4B, device_availability_snapshots is a TimescaleDB hypertable.
Retention is managed by add_retention_policy (90 days), not a manual DELETE.
"""

from app.workers.tasks.retention_tasks import HYPERTABLE_MANAGED, _RETENTION


def test_snapshot_managed_by_timescaledb():
    """device_availability_snapshots retention is handled by TimescaleDB, not Celery."""
    assert "device_availability_snapshots" in HYPERTABLE_MANAGED


def test_snapshot_not_in_manual_retention():
    """No manual DELETE should target device_availability_snapshots."""
    assert "device_availability_snapshots" not in _RETENTION
