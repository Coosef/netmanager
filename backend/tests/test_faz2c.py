"""
Unit tests for Faz 2C — ping-gated recovery (confirm_recovery).

Coverage:
- Ping reachable → CLOSED
- Ping unreachable → re-opened to OPEN
- Ping mechanism error (None) → fallback CLOSED
- Device not found in inventory → fallback CLOSED
- Incident not found → noop (no exception)
- Incident not in RECOVERING state → noop
- recovering_at cleared on re-open
- Timeline entries contain expected reason strings
- _ping_sync return values: True / False / None per scenario
"""

import subprocess
import sys
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, MagicMock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.incident import Incident, IncidentState
from app.workers.tasks.correlation_tasks import confirm_recovery, _ping_sync
from app.services.correlation_engine import RECOVERY_CONFIRM_SEC

# ── Minimal ORM base for test database ───────────────────────────────────────
from app.core.database import Base


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_session(tmp_path):
    """Create an isolated SQLite session with only the incidents table."""
    engine = create_engine(f"sqlite:///{tmp_path}/faz2c.db")
    Base.metadata.create_all(engine, tables=[Incident.__table__])
    return sessionmaker(bind=engine)


def _recovering_incident(device_id=10, ip_address="10.0.0.1", age_secs=200):
    """Return an Incident fixture in RECOVERING state."""
    now = datetime.now(timezone.utc)
    opened = now - timedelta(seconds=age_secs + RECOVERY_CONFIRM_SEC)
    recovering = now - timedelta(seconds=age_secs)
    return Incident(
        fingerprint="aabbccddeeff0011",
        device_id=device_id,
        event_type="port_down",
        component="GigabitEthernet0/1",
        severity="warning",
        state=IncidentState.RECOVERING,
        opened_at=opened,
        recovering_at=recovering,
        sources=[],
        timeline=[],
    )


def _run_confirm_recovery(incident_id: int, Session, ip_address: str | None, ping_result):
    """
    Drive confirm_recovery() with:
    - _get_db patched to return a test SQLite session
    - Device.ip_address lookup patched to return ip_address (or None)
    - _ping_sync patched to return ping_result
    """
    def _fake_get_db():
        return Session()

    with patch("app.workers.tasks.correlation_tasks._get_db", side_effect=_fake_get_db), \
         patch("app.workers.tasks.correlation_tasks._ping_sync", return_value=ping_result), \
         patch(
             "app.workers.tasks.correlation_tasks.select",
             wraps=__import__("sqlalchemy", fromlist=["select"]).select,
         ):
        # Also patch the Device lookup to return our ip_address
        from unittest.mock import MagicMock
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = ip_address

        orig_execute = None

        def patched_get_db_with_device():
            session = Session()
            orig_execute = session.execute

            def patched_execute(stmt, *a, **kw):
                # If query touches Device.ip_address → return mocked result
                stmt_str = str(stmt)
                if "device" in stmt_str.lower() and "ip_address" in stmt_str.lower():
                    return mock_result
                return orig_execute(stmt, *a, **kw)

            session.execute = patched_execute
            return session

        with patch("app.workers.tasks.correlation_tasks._get_db",
                   side_effect=patched_get_db_with_device), \
             patch("app.workers.tasks.correlation_tasks._ping_sync", return_value=ping_result):
            confirm_recovery(incident_id=incident_id)


# ══════════════════════════════════════════════════════════════════════════════
# 1. Ping reachable → CLOSED
# ══════════════════════════════════════════════════════════════════════════════

def test_ping_reachable_closes_incident(tmp_path):
    Session = _make_session(tmp_path)
    inc = _recovering_incident()

    with Session() as db:
        db.add(inc)
        db.commit()
        inc_id = inc.id

    _run_confirm_recovery(inc_id, Session, "10.0.0.1", True)

    with Session() as db:
        result = db.get(Incident, inc_id)
    assert result.state == IncidentState.CLOSED, "Reachable ping must close the incident"
    assert result.closed_at is not None
    assert any("reachable" in str(e).lower() for e in result.timeline), \
        "Timeline must mention reachable"


# ══════════════════════════════════════════════════════════════════════════════
# 2. Ping unreachable → re-opened to OPEN
# ══════════════════════════════════════════════════════════════════════════════

def test_ping_unreachable_reopens_incident(tmp_path):
    Session = _make_session(tmp_path)
    inc = _recovering_incident()

    with Session() as db:
        db.add(inc)
        db.commit()
        inc_id = inc.id

    _run_confirm_recovery(inc_id, Session, "10.0.0.1", False)

    with Session() as db:
        result = db.get(Incident, inc_id)
    assert result.state == IncidentState.OPEN, "Unreachable ping must re-open incident"
    assert result.closed_at is None, "closed_at must not be set on re-open"


def test_ping_unreachable_clears_recovering_at(tmp_path):
    Session = _make_session(tmp_path)
    inc = _recovering_incident()

    with Session() as db:
        db.add(inc)
        db.commit()
        inc_id = inc.id

    _run_confirm_recovery(inc_id, Session, "10.0.0.1", False)

    with Session() as db:
        result = db.get(Incident, inc_id)
    assert result.recovering_at is None, "recovering_at must be cleared when re-opening"


def test_ping_unreachable_timeline_mentions_false_recovery(tmp_path):
    Session = _make_session(tmp_path)
    inc = _recovering_incident()

    with Session() as db:
        db.add(inc)
        db.commit()
        inc_id = inc.id

    _run_confirm_recovery(inc_id, Session, "10.0.0.1", False)

    with Session() as db:
        result = db.get(Incident, inc_id)
    timeline_str = str(result.timeline).lower()
    assert "false" in timeline_str or "unreachable" in timeline_str or "failed" in timeline_str, \
        "Timeline must record why incident was re-opened"


# ══════════════════════════════════════════════════════════════════════════════
# 3. Ping mechanism error (None) → fallback CLOSED
# ══════════════════════════════════════════════════════════════════════════════

def test_ping_mechanism_error_fallback_closes(tmp_path):
    Session = _make_session(tmp_path)
    inc = _recovering_incident()

    with Session() as db:
        db.add(inc)
        db.commit()
        inc_id = inc.id

    _run_confirm_recovery(inc_id, Session, "10.0.0.1", None)

    with Session() as db:
        result = db.get(Incident, inc_id)
    assert result.state == IncidentState.CLOSED, \
        "Ping mechanism error (None) must fall back to CLOSED, not OPEN"
    assert result.closed_at is not None


def test_ping_mechanism_error_timeline_mentions_fallback(tmp_path):
    Session = _make_session(tmp_path)
    inc = _recovering_incident()

    with Session() as db:
        db.add(inc)
        db.commit()
        inc_id = inc.id

    _run_confirm_recovery(inc_id, Session, "10.0.0.1", None)

    with Session() as db:
        result = db.get(Incident, inc_id)
    timeline_str = str(result.timeline).lower()
    assert "fallback" in timeline_str or "unavailable" in timeline_str, \
        "Timeline must note fallback path"


# ══════════════════════════════════════════════════════════════════════════════
# 4. Device not found → fallback CLOSED
# ══════════════════════════════════════════════════════════════════════════════

def test_device_not_found_fallback_closes(tmp_path):
    Session = _make_session(tmp_path)
    inc = _recovering_incident(device_id=999)  # device_id not in devices table

    with Session() as db:
        db.add(inc)
        db.commit()
        inc_id = inc.id

    # ip_address=None simulates device not found
    _run_confirm_recovery(inc_id, Session, None, True)

    with Session() as db:
        result = db.get(Incident, inc_id)
    assert result.state == IncidentState.CLOSED, \
        "Missing device must trigger fallback CLOSED"


def test_device_not_found_does_not_ping(tmp_path):
    """If device is not found, _ping_sync must never be called."""
    Session = _make_session(tmp_path)
    inc = _recovering_incident(device_id=999)

    with Session() as db:
        db.add(inc)
        db.commit()
        inc_id = inc.id

    mock_ping = MagicMock(return_value=True)

    def patched_get_db():
        session = Session()
        orig_exec = session.execute
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None

        def patched_execute(stmt, *a, **kw):
            stmt_str = str(stmt)
            if "device" in stmt_str.lower() and "ip_address" in stmt_str.lower():
                return mock_result
            return orig_exec(stmt, *a, **kw)

        session.execute = patched_execute
        return session

    with patch("app.workers.tasks.correlation_tasks._get_db", side_effect=patched_get_db), \
         patch("app.workers.tasks.correlation_tasks._ping_sync", mock_ping):
        confirm_recovery(incident_id=inc_id)

    mock_ping.assert_not_called()


# ══════════════════════════════════════════════════════════════════════════════
# 5. Edge cases — noop scenarios
# ══════════════════════════════════════════════════════════════════════════════

def test_incident_not_found_is_noop(tmp_path):
    """Non-existent incident_id must not raise."""
    Session = _make_session(tmp_path)

    def patched_get_db():
        return Session()

    with patch("app.workers.tasks.correlation_tasks._get_db", side_effect=patched_get_db):
        confirm_recovery(incident_id=99999)  # must not raise


def test_incident_already_closed_is_noop(tmp_path):
    Session = _make_session(tmp_path)
    now = datetime.now(timezone.utc)
    inc = Incident(
        fingerprint="closedinc00000001", device_id=10,
        event_type="port_down", component="device", severity="warning",
        state=IncidentState.CLOSED,
        opened_at=now - timedelta(seconds=300),
        closed_at=now - timedelta(seconds=60),
        sources=[], timeline=[],
    )

    with Session() as db:
        db.add(inc)
        db.commit()
        inc_id = inc.id

    mock_ping = MagicMock()

    def patched_get_db():
        return Session()

    with patch("app.workers.tasks.correlation_tasks._get_db", side_effect=patched_get_db), \
         patch("app.workers.tasks.correlation_tasks._ping_sync", mock_ping):
        confirm_recovery(incident_id=inc_id)

    mock_ping.assert_not_called()

    with Session() as db:
        result = db.get(Incident, inc_id)
    assert result.state == IncidentState.CLOSED  # unchanged


def test_incident_open_state_is_noop(tmp_path):
    """OPEN incident should not be touched by confirm_recovery."""
    Session = _make_session(tmp_path)
    now = datetime.now(timezone.utc)
    inc = Incident(
        fingerprint="openincident00001", device_id=10,
        event_type="port_down", component="device", severity="warning",
        state=IncidentState.OPEN,
        opened_at=now - timedelta(seconds=200),
        sources=[], timeline=[],
    )

    with Session() as db:
        db.add(inc)
        db.commit()
        inc_id = inc.id

    def patched_get_db():
        return Session()

    with patch("app.workers.tasks.correlation_tasks._get_db", side_effect=patched_get_db):
        confirm_recovery(incident_id=inc_id)

    with Session() as db:
        result = db.get(Incident, inc_id)
    assert result.state == IncidentState.OPEN  # unchanged


# ══════════════════════════════════════════════════════════════════════════════
# 6. _ping_sync unit tests (subprocess-level)
# ══════════════════════════════════════════════════════════════════════════════

def test_ping_sync_returns_true_on_zero_returncode():
    mock_result = MagicMock()
    mock_result.returncode = 0
    with patch("subprocess.run", return_value=mock_result):
        assert _ping_sync("127.0.0.1") is True


def test_ping_sync_returns_false_on_nonzero_returncode():
    mock_result = MagicMock()
    mock_result.returncode = 1
    with patch("subprocess.run", return_value=mock_result):
        assert _ping_sync("192.0.2.1") is False


def test_ping_sync_returns_none_on_timeout():
    with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("ping", 3)):
        assert _ping_sync("10.0.0.1") is None


def test_ping_sync_returns_none_on_generic_exception():
    with patch("subprocess.run", side_effect=OSError("ping binary not found")):
        assert _ping_sync("10.0.0.1") is None


def test_ping_sync_passes_correct_flags_linux():
    mock_result = MagicMock()
    mock_result.returncode = 0
    with patch("subprocess.run", return_value=mock_result) as mock_run, \
         patch.object(sys, "platform", "linux"):
        _ping_sync("10.0.0.1", timeout=3)
    call_args = mock_run.call_args[0][0]
    assert "-c" in call_args
    assert "1" in call_args
    assert "10.0.0.1" in call_args
