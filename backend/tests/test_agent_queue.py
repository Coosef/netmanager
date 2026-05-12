"""
Tests for AgentEventQueue (SQLite WAL offline buffer).

These tests are self-contained — no external dependencies required.
Run with: cd backend && python -m pytest tests/test_agent_queue.py -v
"""
import os
import sys
import tempfile
import threading

import pytest

# Allow importing from agent_script without an installed package
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "agent_script"))
from agent_queue import AgentEventQueue


@pytest.fixture
def queue(tmp_path):
    """Fresh queue backed by a temp file — removed after each test."""
    db_path = str(tmp_path / "test_queue.db")
    return AgentEventQueue(path=db_path)


# ── Basic push / pop / ack ────────────────────────────────────────────────────

def test_push_and_pop(queue):
    queue.push({"type": "device_status_report", "device_id": 1})
    batch = queue.pop_batch()
    assert len(batch) == 1
    row_id, payload = batch[0]
    assert payload["type"] == "device_status_report"
    assert payload["device_id"] == 1


def test_ack_marks_sent(queue):
    queue.push({"type": "device_status_report", "device_id": 2})
    batch = queue.pop_batch()
    ids = [b[0] for b in batch]
    queue.ack(ids)

    # After ack, pop_batch returns nothing (all sent)
    assert queue.pop_batch() == []
    assert queue.pending_count() == 0


def test_pending_count(queue):
    assert queue.pending_count() == 0
    queue.push({"x": 1})
    queue.push({"x": 2})
    assert queue.pending_count() == 2

    batch = queue.pop_batch()
    queue.ack([b[0] for b in batch])
    assert queue.pending_count() == 0


# ── Batch size ────────────────────────────────────────────────────────────────

def test_pop_batch_respects_batch_size(queue):
    from agent_queue import BATCH_SIZE
    for i in range(BATCH_SIZE + 50):
        queue.push({"seq": i})

    batch = queue.pop_batch()
    assert len(batch) == BATCH_SIZE


# ── Ordering ──────────────────────────────────────────────────────────────────

def test_fifo_order(queue):
    for i in range(5):
        queue.push({"seq": i})

    batch = queue.pop_batch()
    seqs = [p["seq"] for _, p in batch]
    assert seqs == sorted(seqs), "Events must be returned oldest-first (FIFO)"


# ── Overflow / capacity cap ───────────────────────────────────────────────────

def test_overflow_drops_oldest(tmp_path):
    """When capacity is exceeded, oldest unsent event is dropped."""
    from agent_queue import AgentEventQueue, MAX_UNSENT

    # Use a tiny cap to test without writing 500k rows
    class TinyQueue(AgentEventQueue):
        pass

    import agent_queue as aq_module
    original_max = aq_module.MAX_UNSENT
    aq_module.MAX_UNSENT = 3  # override for this test

    q = AgentEventQueue(path=str(tmp_path / "tiny.db"))
    for i in range(5):
        q.push({"seq": i})

    aq_module.MAX_UNSENT = original_max  # restore

    # Should have dropped seq=0 and seq=1; kept seq=2,3,4
    batch = q.pop_batch()
    seqs = [p["seq"] for _, p in batch]
    assert len(seqs) == 3
    assert seqs[-1] == 4, "Newest event must be retained"


# ── Idempotent ack ────────────────────────────────────────────────────────────

def test_ack_idempotent(queue):
    queue.push({"type": "test"})
    batch = queue.pop_batch()
    ids = [b[0] for b in batch]
    queue.ack(ids)
    queue.ack(ids)  # second ack must not raise
    assert queue.pending_count() == 0


# ── Thread safety ─────────────────────────────────────────────────────────────

def test_concurrent_push(queue):
    N = 200

    def writer(start):
        for i in range(start, start + N):
            queue.push({"seq": i})

    threads = [threading.Thread(target=writer, args=(i * N,)) for i in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # All 1000 events pushed; pop several batches to count total
    total = 0
    while True:
        batch = queue.pop_batch()
        if not batch:
            break
        queue.ack([b[0] for b in batch])
        total += len(batch)

    assert total == 5 * N


# ── Prune ─────────────────────────────────────────────────────────────────────

def test_prune_removes_old_sent(tmp_path):
    import time
    from agent_queue import AgentEventQueue, PRUNE_AFTER_DAYS

    q = AgentEventQueue(path=str(tmp_path / "prune.db"))
    q.push({"type": "old"})
    batch = q.pop_batch()
    ids = [b[0] for b in batch]
    q.ack(ids)

    # Manually backdate sent_at beyond pruning threshold
    cutoff_ts = time.time() - (PRUNE_AFTER_DAYS * 86400) - 1
    q._conn.execute("UPDATE q SET sent_at=? WHERE sent=1", (cutoff_ts,))
    q._conn.commit()

    deleted = q.prune()
    assert deleted == 1

    # Unsent events are never pruned
    q.push({"type": "new"})
    deleted2 = q.prune()
    assert deleted2 == 0
    assert q.pending_count() == 1
