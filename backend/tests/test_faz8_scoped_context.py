"""
Faz 8 Phase B — explicit organization/location ownership, fail closed.

The `_scoping` before_insert hook used to silently stamp an unresolved
scoped row into the lowest-id organization + its "Unassigned" location —
a cross-org misattribution vector. Phase B removed that fallback: a
NOT NULL scoping column that cannot be resolved from a device parent, a
parent FK, or the request/task context is now REJECTED with a
`ScopedContextError`.

These tests pin the fail-closed behavior. SQLite is enough — the hook is
pure Python; no RLS needed.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
import app.models  # noqa: F401 — registers every model + the scoping hook
from app.core.org_context import set_org_context, clear_org_context
from app.models._scoping import ScopedContextError


@pytest.fixture
def db():
    clear_org_context()  # the autouse default-context fixture sets (1,1)
    from app.models.shared.organization import Organization
    from app.models.location import Location
    from app.models.device import Device
    from app.models.config_backup import ConfigBackup

    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=[
        Organization.__table__, Location.__table__,
        Device.__table__, ConfigBackup.__table__,
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


def _device(db, org, loc, ip="10.0.0.1"):
    from app.models.device import Device
    d = Device(
        hostname=f"sw-{org.slug}", ip_address=ip,
        ssh_username="admin", ssh_password_enc="enc",
        organization_id=org.id, location_id=loc.id,
    )
    db.add(d)
    db.flush()
    return d


# ── fail closed ─────────────────────────────────────────────────────────────

def test_device_without_any_context_is_rejected(db):
    """No device parent, no parent FK, no context ⇒ the write is rejected."""
    from app.models.device import Device
    _org(db)  # an organization exists — but must NOT be used as a default
    clear_org_context()
    db.add(Device(hostname="x", ip_address="10.9.9.9",
                   ssh_username="a", ssh_password_enc="e"))
    with pytest.raises(ScopedContextError):
        db.flush()


def test_org_resolved_but_location_missing_is_rejected(db):
    """A device with an org context but no location context is rejected —
    location_id is NOT NULL and must be explicit."""
    from app.models.device import Device
    org = _org(db)
    set_org_context(org.id, None, False)  # org set, location absent
    db.add(Device(hostname="x", ip_address="10.9.9.8",
                   ssh_username="a", ssh_password_enc="e"))
    with pytest.raises(ScopedContextError) as exc:
        db.flush()
    assert "location_id" in str(exc.value)


def test_no_silent_default_org_fallback(db):
    """With two organizations and no context, an unresolved device must
    RAISE — never silently land in the lowest-id organization."""
    from app.models.device import Device
    org_a = _org(db, "alpha")   # lowest id
    _org(db, "bravo")
    clear_org_context()
    db.add(Device(hostname="x", ip_address="10.9.9.7",
                   ssh_username="a", ssh_password_enc="e"))
    with pytest.raises(ScopedContextError):
        db.flush()
    db.rollback()
    # the lowest-id org gained no device from the rejected write
    assert db.query(Device).filter_by(organization_id=org_a.id).count() == 0


def test_rejection_names_the_model_and_missing_column(db):
    from app.models.device import Device
    _org(db)
    clear_org_context()
    db.add(Device(hostname="x", ip_address="10.9.9.6",
                   ssh_username="a", ssh_password_enc="e"))
    with pytest.raises(ScopedContextError) as exc:
        db.flush()
    msg = str(exc.value)
    assert "devices" in msg and "organization_id" in msg


# ── explicit / resolved paths still work ────────────────────────────────────

def test_explicit_scope_is_accepted_and_never_overridden(db):
    """Explicit org/location on the row is kept verbatim, even when the
    request context points elsewhere."""
    from app.models.device import Device
    org_a, org_b = _org(db, "alpha"), _org(db, "bravo")
    loc_b = _location(db, org_b)
    set_org_context(org_a.id, None, False)  # context = A
    d = Device(hostname="x", ip_address="10.0.0.5",
               ssh_username="a", ssh_password_enc="e",
               organization_id=org_b.id, location_id=loc_b.id)  # explicit = B
    db.add(d)
    db.flush()
    assert d.organization_id == org_b.id and d.location_id == loc_b.id


def test_full_context_resolves_the_write(db):
    from app.models.device import Device
    org = _org(db)
    loc = _location(db, org)
    set_org_context(org.id, loc.id, False)
    d = Device(hostname="x", ip_address="10.0.0.6",
               ssh_username="a", ssh_password_enc="e")
    db.add(d)
    db.flush()
    assert d.organization_id == org.id and d.location_id == loc.id


def test_device_bound_child_inherits_without_context(db):
    """A row with a device_id still inherits org+location from its parent
    device — no context needed, no rejection."""
    from app.models.config_backup import ConfigBackup
    org = _org(db)
    loc = _location(db, org)
    dev = _device(db, org, loc)
    clear_org_context()
    backup = ConfigBackup(device_id=dev.id, config_text="!", config_hash="h")
    db.add(backup)
    db.flush()
    assert backup.organization_id == org.id
    assert backup.location_id == loc.id


def test_user_org_uses_organization_id_attribute(db):
    """create_org binds the org-admin via `organization_id` (the Phase B
    fix for the `org_id=` bug). The attribute must exist and be mapped."""
    from app.models.user import User
    assert hasattr(User, "organization_id")
    u = User(username="oa", email="oa@x.io", hashed_password="h",
             organization_id=42)
    assert u.organization_id == 42
