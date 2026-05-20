"""
Faz 7 — verifies the before_insert org-stamping hook (app/models/_scoping.py).

Every insert into a scoped table must end up with organization_id (and,
for device-bound rows, location_id) — whether it came from a request, a
device-bound parent, another parent row, or the task context. This is
the precondition for the M3 NOT NULL constraints.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
import app.models  # noqa: F401 — registers every model + the stamping hook
from app.core.org_context import org_context, clear_org_context


@pytest.fixture
def db():
    # Only the tables this test touches — a full create_all fails on
    # SQLite (PostgreSQL-only JSONB columns elsewhere in the schema).
    clear_org_context()
    from app.models.shared.organization import Organization
    from app.models.location import Location
    from app.models.device import Device
    from app.models.agent import Agent
    from app.models.config_backup import ConfigBackup
    from app.models.syslog_event import SyslogEvent
    from app.models.notification import NotificationChannel

    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=[
        Organization.__table__, Location.__table__, Device.__table__,
        Agent.__table__, ConfigBackup.__table__, SyslogEvent.__table__,
        NotificationChannel.__table__,
    ])
    Session = sessionmaker(engine)
    with Session() as session:
        yield session
    engine.dispose()
    clear_org_context()


def _org(db, slug="acme"):
    from app.models.shared.organization import Organization
    o = Organization(name=slug.title(), slug=slug)
    db.add(o)
    db.flush()
    return o


def _location(db, org):
    from app.models.location import Location
    loc = Location(name=f"HQ-{org.slug}", organization_id=org.id)
    db.add(loc)
    db.flush()
    return loc


def _device(db, org, loc):
    from app.models.device import Device
    d = Device(
        hostname=f"sw-{org.slug}", ip_address=f"10.0.0.{org.id}",
        ssh_username="admin", ssh_password_enc="enc",
        organization_id=org.id, location_id=loc.id,
    )
    db.add(d)
    db.flush()
    return d


# ── 1. Device-bound row inherits org + location from its device ───────────────

def test_device_bound_row_inherits_org_and_location(db):
    from app.models.config_backup import ConfigBackup
    org = _org(db)
    loc = _location(db, org)
    dev = _device(db, org, loc)

    # No org_context set, organization_id/location_id left unset.
    cb = ConfigBackup(device_id=dev.id, config_text="x", config_hash="h")
    db.add(cb)
    db.flush()

    assert cb.organization_id == org.id
    assert cb.location_id == loc.id


# ── 2. Org inherited from a non-device parent (agent) ─────────────────────────

def test_row_inherits_org_from_agent_parent(db):
    from app.models.agent import Agent
    from app.models.syslog_event import SyslogEvent
    org = _org(db)
    loc = _location(db, org)
    db.add(Agent(
        id="agent0001", name="edge", agent_key_hash="k",
        organization_id=org.id, location_id=loc.id,
    ))
    db.flush()

    # SyslogEvent has agent_id but no device_id — derives via the parent map.
    ev = SyslogEvent(agent_id="agent0001", source_ip="10.0.0.9", message="m")
    db.add(ev)
    db.flush()

    assert ev.organization_id == org.id


# ── 3. Context fallback for a row with no parent FK ───────────────────────────

def test_row_with_no_parent_falls_back_to_context(db):
    from app.models.notification import NotificationChannel
    org = _org(db)

    with org_context(org.id, None):
        ch = NotificationChannel(name="ops", type="slack", config={})
        db.add(ch)
        db.flush()

    assert ch.organization_id == org.id


# ── 4. An explicitly-set organization_id is never overwritten ─────────────────

def test_explicit_org_is_not_overwritten(db):
    from app.models.notification import NotificationChannel
    org_a = _org(db, "alpha")
    org_b = _org(db, "beta")

    with org_context(org_a.id, None):
        ch = NotificationChannel(
            name="x", type="slack", config={}, organization_id=org_b.id,
        )
        db.add(ch)
        db.flush()

    # Caller's explicit value wins over the context.
    assert ch.organization_id == org_b.id
