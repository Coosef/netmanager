"""
Faz 6C.1 — SNMP stream migration tests.

Coverage:
  * snmp_ingest.build_snmp_row maps a payload → SnmpPollResult correctly.
  * snmp_ingest.persist_snmp_batch bulk-inserts in ONE commit.
  * snmp_tasks._compute_rows: utilization math, persist_rows + alert_rows
    shapes; no DB write (Faz 6C.1 moved persistence out).
  * snmp_tasks._publish_snmp_rows: all-ok → no failures; Redis down → all
    rows returned as failed (for direct-insert fallback).
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

UTC = timezone.utc
NOW = datetime(2026, 5, 18, 9, 0, 0, tzinfo=UTC)


# ══════════════════════════════════════════════════════════════════════════════
# 1. snmp_ingest
# ══════════════════════════════════════════════════════════════════════════════

class TestSnmpIngest:

    def test_build_snmp_row_maps_fields(self):
        from app.services.snmp_ingest import build_snmp_row
        row = build_snmp_row({
            "device_id": 7, "polled_at": NOW, "if_index": 3, "if_name": "Gi0/3",
            "speed_mbps": 1000, "in_octets": 123, "out_octets": 456,
            "in_errors": 1, "out_errors": 2,
            "in_utilization_pct": 12.5, "out_utilization_pct": 8.0,
        })
        assert row.device_id == 7
        assert row.if_index == 3
        assert row.if_name == "Gi0/3"
        assert row.in_utilization_pct == 12.5
        assert row.polled_at == NOW

    def test_build_snmp_row_parses_iso_polled_at(self):
        from app.services.snmp_ingest import build_snmp_row
        row = build_snmp_row({"device_id": 1, "polled_at": NOW.isoformat()})
        assert row.polled_at == NOW

    @pytest.mark.asyncio
    async def test_persist_snmp_batch_single_commit(self):
        from app.services.snmp_ingest import persist_snmp_batch
        db = MagicMock()
        db.add_all = MagicMock()
        db.commit = AsyncMock()
        payloads = [
            {"device_id": i, "polled_at": NOW, "if_index": 1} for i in range(40)
        ]
        n = await persist_snmp_batch(db, payloads)
        assert n == 40
        assert db.add_all.call_count == 1          # ONE add_all
        assert db.commit.await_count == 1          # ONE commit for 40 rows
        assert len(db.add_all.call_args[0][0]) == 40

    @pytest.mark.asyncio
    async def test_persist_snmp_batch_empty_noop(self):
        from app.services.snmp_ingest import persist_snmp_batch
        db = MagicMock()
        db.add_all = MagicMock()
        db.commit = AsyncMock()
        assert await persist_snmp_batch(db, []) == 0
        db.add_all.assert_not_called()


# ══════════════════════════════════════════════════════════════════════════════
# 2. snmp_tasks._compute_rows
# ══════════════════════════════════════════════════════════════════════════════

def _device(did=1, hostname="sw1"):
    return SimpleNamespace(id=did, hostname=hostname)


class TestComputeRows:

    def test_no_prev_snapshot_utilization_none(self):
        from app.workers.tasks.snmp_tasks import _compute_rows
        ifaces = [{"if_index": 1, "name": "Gi0/1", "speed_mbps": 1000,
                   "in_octets": 1000, "out_octets": 2000,
                   "in_errors": 0, "out_errors": 0}]
        persist, alert = _compute_rows(_device(), ifaces, {}, NOW)
        assert len(persist) == 1
        assert persist[0]["in_utilization_pct"] is None
        assert persist[0]["device_id"] == 1
        assert persist[0]["if_index"] == 1
        assert len(alert) == 1
        assert alert[0]["in_util"] is None

    def test_utilization_computed_from_prev(self):
        from app.workers.tasks.snmp_tasks import _compute_rows
        prev = {1: {
            "polled_at": NOW - timedelta(seconds=300),
            "in_octets": 0, "out_octets": 0,
            "in_errors": 0, "out_errors": 0, "speed_mbps": 1000,
        }}
        # 1000 Mbps link, 300s elapsed. in_octets delta 3.75e9 bytes
        # → 3.75e9*8 / 300 / 1e9 = 0.1 → 10% utilization
        ifaces = [{"if_index": 1, "name": "Gi0/1", "speed_mbps": 1000,
                   "in_octets": 3_750_000_000, "out_octets": 0,
                   "in_errors": 0, "out_errors": 0}]
        persist, _alert = _compute_rows(_device(), ifaces, prev, NOW)
        assert persist[0]["in_utilization_pct"] == pytest.approx(10.0, abs=0.1)

    def test_iface_without_if_index_skipped(self):
        from app.workers.tasks.snmp_tasks import _compute_rows
        ifaces = [
            {"name": "no-index"},                                  # skipped
            {"if_index": 2, "name": "Gi0/2", "in_octets": 1},       # kept
        ]
        persist, alert = _compute_rows(_device(), ifaces, {}, NOW)
        assert len(persist) == 1
        assert persist[0]["if_index"] == 2
        assert len(alert) == 1

    def test_compute_rows_does_not_touch_db(self):
        """Faz 6C.1: _compute_rows is pure — no `db` parameter at all."""
        import inspect
        from app.workers.tasks.snmp_tasks import _compute_rows
        params = list(inspect.signature(_compute_rows).parameters)
        assert "db" not in params
        assert params == ["device", "ifaces", "device_prev", "now"]


# ══════════════════════════════════════════════════════════════════════════════
# 3. snmp_tasks._publish_snmp_rows
# ══════════════════════════════════════════════════════════════════════════════

class TestPublishSnmpRows:

    def test_all_published_no_failures(self, monkeypatch):
        from app.workers.tasks import snmp_tasks
        from app.services import event_bus
        monkeypatch.setattr(event_bus, "publish_sync", lambda stream, row: "1-1")
        rows = [{"device_id": i} for i in range(10)]
        failed = snmp_tasks._publish_snmp_rows(rows)
        assert failed == []

    def test_redis_down_all_rows_failed(self, monkeypatch):
        """publish_sync → None (Redis down) → every row returned for fallback."""
        from app.workers.tasks import snmp_tasks
        from app.services import event_bus
        monkeypatch.setattr(event_bus, "publish_sync", lambda stream, row: None)
        rows = [{"device_id": i} for i in range(10)]
        failed = snmp_tasks._publish_snmp_rows(rows)
        assert len(failed) == 10
        assert failed == rows

    def test_publishes_to_snmp_stream(self, monkeypatch):
        from app.workers.tasks import snmp_tasks
        from app.services import event_bus
        seen = []
        monkeypatch.setattr(
            event_bus, "publish_sync", lambda stream, row: seen.append(stream) or "1-1",
        )
        snmp_tasks._publish_snmp_rows([{"device_id": 1}])
        assert seen == [event_bus.STREAM_SNMP]
