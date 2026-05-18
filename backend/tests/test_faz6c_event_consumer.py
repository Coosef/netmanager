"""
Faz 6C G3 — event_consumer tests.

Coverage:
  * process_batch: empty no-op; success persists + acks; fresh failure leaves
    entries pending (no dead-letter); retry failure → dead-letter + ack.
  * consume_cycle: fresh batch processed; claim_due → claim_stale reclaimed
    entries reprocessed as a retry batch.
  * Bounded persistence — process_batch opens exactly ONE worker session
    per batch regardless of batch size (KI-4 guard).
"""
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.event_bus import StreamEntry


# ── Fake EventBus ─────────────────────────────────────────────────────────────

class FakeBus:
    def __init__(self):
        self.acked: list[list[str]] = []
        self.dead_lettered: list[list[StreamEntry]] = []
        self.claim_result: list[StreamEntry] = []
        self.consume_result: list[StreamEntry] = []

    async def ack(self, stream, group, ids):
        self.acked.append(list(ids))
        return len(ids)

    async def to_dead_letter(self, stream, entries):
        self.dead_lettered.append(list(entries))

    async def claim_stale(self, stream, group, consumer, min_idle_ms, count):
        return self.claim_result

    async def consume_batch(self, stream, group, consumer, count, block_ms):
        return self.consume_result


def _entries(n, base="1"):
    return [StreamEntry(id=f"{base}-{i}", data={"message": f"m{i}"}) for i in range(n)]


def _patch_session(monkeypatch, *, fail=False, capture=None):
    """Patch make_worker_session + persist_and_correlate."""
    sessions_opened = []

    class _Ctx:
        async def __aenter__(self):
            sessions_opened.append(1)
            return MagicMock()
        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(
        "app.core.database.make_worker_session", lambda: (lambda: _Ctx()),
    )

    async def stub_pac(db, payloads, sync_redis):
        if fail:
            raise RuntimeError("DB write failed")
        if capture is not None:
            capture.extend(payloads)
        return len(payloads)

    monkeypatch.setattr(
        "app.services.syslog_ingest.persist_and_correlate", stub_pac,
    )
    return sessions_opened


# ══════════════════════════════════════════════════════════════════════════════
# 1. process_batch
# ══════════════════════════════════════════════════════════════════════════════

class TestProcessBatch:

    @pytest.mark.asyncio
    async def test_empty_batch_noop(self):
        from app.services.event_consumer import process_batch
        bus = FakeBus()
        n = await process_batch(bus, [], MagicMock(), is_retry=False)
        assert n == 0
        assert bus.acked == []

    @pytest.mark.asyncio
    async def test_success_persists_and_acks(self, monkeypatch):
        from app.services.event_consumer import process_batch
        captured = []
        opened = _patch_session(monkeypatch, capture=captured)
        bus = FakeBus()
        entries = _entries(50)

        n = await process_batch(bus, entries, MagicMock(), is_retry=False)
        assert n == 50
        assert len(captured) == 50
        # Exactly ONE session for the whole batch (KI-4 guard)
        assert len(opened) == 1
        # All ids acked
        assert bus.acked == [[e.id for e in entries]]
        assert bus.dead_lettered == []

    @pytest.mark.asyncio
    async def test_fresh_failure_leaves_pending(self, monkeypatch):
        """A fresh batch that fails is NOT acked and NOT dead-lettered —
        it stays pending so claim_stale can retry it."""
        from app.services.event_consumer import process_batch
        _patch_session(monkeypatch, fail=True)
        bus = FakeBus()
        n = await process_batch(bus, _entries(10), MagicMock(), is_retry=False)
        assert n == 0
        assert bus.acked == []          # NOT acked → stays pending
        assert bus.dead_lettered == []  # NOT dead-lettered yet

    @pytest.mark.asyncio
    async def test_retry_failure_dead_letters_and_acks(self, monkeypatch):
        """A retry batch that fails again → dead-letter + ack (two-strike)."""
        from app.services.event_consumer import process_batch
        _patch_session(monkeypatch, fail=True)
        bus = FakeBus()
        entries = _entries(10)
        n = await process_batch(bus, entries, MagicMock(), is_retry=True)
        assert n == 0
        assert len(bus.dead_lettered) == 1
        assert len(bus.dead_lettered[0]) == 10
        # Acked so it stops cycling
        assert bus.acked == [[e.id for e in entries]]


# ══════════════════════════════════════════════════════════════════════════════
# 2. consume_cycle
# ══════════════════════════════════════════════════════════════════════════════

class TestConsumeCycle:

    @pytest.mark.asyncio
    async def test_fresh_batch_processed(self, monkeypatch):
        from app.services.event_consumer import consume_cycle
        _patch_session(monkeypatch)
        bus = FakeBus()
        bus.consume_result = _entries(20)

        n = await consume_cycle(bus, MagicMock(), "c1", claim_due=False)
        assert n == 20
        assert bus.acked == [[e.id for e in bus.consume_result]]

    @pytest.mark.asyncio
    async def test_claim_due_reprocesses_stale_as_retry(self, monkeypatch):
        """claim_due=True → claimed entries processed as a retry batch."""
        from app.services.event_consumer import consume_cycle
        _patch_session(monkeypatch)
        bus = FakeBus()
        bus.claim_result = _entries(5, base="stale")
        bus.consume_result = _entries(8, base="fresh")

        n = await consume_cycle(bus, MagicMock(), "c1", claim_due=True)
        # 5 reclaimed + 8 fresh
        assert n == 13
        # Two ack calls — one for the claimed batch, one for the fresh batch
        assert len(bus.acked) == 2

    @pytest.mark.asyncio
    async def test_claim_skipped_when_not_due(self, monkeypatch):
        from app.services.event_consumer import consume_cycle
        _patch_session(monkeypatch)
        bus = FakeBus()
        bus.claim_result = _entries(99, base="stale")  # would be huge if claimed
        bus.consume_result = _entries(3)

        n = await consume_cycle(bus, MagicMock(), "c1", claim_due=False)
        assert n == 3   # only the fresh batch — claim_stale not called
