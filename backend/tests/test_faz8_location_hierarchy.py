"""
Faz 8 Phase C — complete the Organization > Location hierarchy for logs
and discovery.

`syslog_events` and `discovery_results` used to be organization-scoped
only. Migration f8a2lochier adds `location_id` to both, backfills it
from the originating agent's location, and rebuilds the `org_isolation`
RLS policy on both to enforce organization AND location scope. It also
fixes the relational contradiction where a NOT NULL `location_id` column
carried an `ON DELETE SET NULL` foreign key.

Two test groups:
  * SQLite unit tests — the `_scoping` before_insert hook (an agent
    parent now also carries a location) and the model column shapes.
  * PostgreSQL tests — the actual RLS location filtering and the FK
    ondelete-action fix. Skipped on the SQLite unit path.
"""
import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.core.database import Base
import app.models  # noqa: F401 — registers every model + the scoping hook
from app.core.org_context import set_org_context, clear_org_context
from app.models._scoping import ScopedContextError

_IS_PG = "postgresql" in (settings.DATABASE_URL or "")


# ── SQLite unit tests — scoping hook + model shapes ──────────────────────────

@pytest.fixture
def db():
    clear_org_context()  # the autouse default-context fixture sets (1,1)
    from app.models.shared.organization import Organization
    from app.models.location import Location
    from app.models.agent import Agent
    from app.models.syslog_event import SyslogEvent
    from app.models.discovery_result import DiscoveryResult

    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=[
        Organization.__table__, Location.__table__, Agent.__table__,
        SyslogEvent.__table__, DiscoveryResult.__table__,
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


def _location(db, org, name=None):
    from app.models.location import Location
    loc = Location(name=name or f"HQ-{org.slug}", organization_id=org.id)
    db.add(loc)
    db.flush()
    return loc


def _agent(db, org, loc, agent_id="agent-001"):
    from app.models.agent import Agent
    a = Agent(
        id=agent_id, name=f"agent-{org.slug}", agent_key_hash="h",
        organization_id=org.id, location_id=loc.id,
    )
    db.add(a)
    db.flush()
    return a


def test_syslog_event_location_id_is_nullable(db):
    """A syslog event whose source agent cannot be located is an explicit
    review bucket (location_id NULL), never a silent default."""
    from app.models.syslog_event import SyslogEvent
    col = SyslogEvent.__table__.columns["location_id"]
    assert col.nullable is True
    # organization_id stays NOT NULL — every event must have an org.
    assert SyslogEvent.__table__.columns["organization_id"].nullable is False


def test_discovery_result_location_id_fk_is_restrict(db):
    """discovery_results.location_id is an FK to locations with ON DELETE
    RESTRICT — a location with discovery history cannot be hard-deleted."""
    from app.models.discovery_result import DiscoveryResult
    fks = list(DiscoveryResult.__table__.columns["location_id"].foreign_keys)
    assert len(fks) == 1
    assert fks[0].column.table.name == "locations"
    assert fks[0].ondelete == "RESTRICT"


def test_syslog_event_inherits_location_from_agent(db):
    """A syslog event carries only agent_id — the scoping hook resolves
    BOTH organization_id and location_id from that agent."""
    from app.models.syslog_event import SyslogEvent
    org = _org(db)
    loc = _location(db, org)
    agent = _agent(db, org, loc)
    clear_org_context()  # no request context — must resolve from the agent
    ev = SyslogEvent(agent_id=agent.id, source_ip="10.0.0.9", message="link down")
    db.add(ev)
    db.flush()
    assert ev.organization_id == org.id
    assert ev.location_id == loc.id


def test_discovery_result_inherits_location_from_agent(db):
    """A discovery result carries only agent_id — the scoping hook resolves
    BOTH organization_id and location_id from that agent."""
    from app.models.discovery_result import DiscoveryResult
    org = _org(db)
    loc = _location(db, org)
    agent = _agent(db, org, loc)
    clear_org_context()
    dr = DiscoveryResult(agent_id=agent.id, subnet="192.168.1.0/24")
    db.add(dr)
    db.flush()
    assert dr.organization_id == org.id
    assert dr.location_id == loc.id


def test_syslog_event_explicit_scope_is_never_overridden(db):
    """An explicitly-stamped org/location (syslog_ingest does this) is kept
    verbatim even when the agent parent points elsewhere."""
    from app.models.syslog_event import SyslogEvent
    org_a, org_b = _org(db, "alpha"), _org(db, "bravo")
    loc_a, loc_b = _location(db, org_a), _location(db, org_b)
    agent = _agent(db, org_a, loc_a)  # agent in A
    clear_org_context()
    ev = SyslogEvent(
        agent_id=agent.id, source_ip="10.0.0.1", message="x",
        organization_id=org_b.id, location_id=loc_b.id,  # explicit = B
    )
    db.add(ev)
    db.flush()
    assert ev.organization_id == org_b.id
    assert ev.location_id == loc_b.id


def test_syslog_event_unscopable_agent_fails_closed(db):
    """An agent_id that resolves to no agent row, with no request context,
    cannot resolve organization_id (NOT NULL) — the write is rejected,
    never misattributed to a default org."""
    from app.models.syslog_event import SyslogEvent
    _org(db, "alpha")
    _org(db, "bravo")
    clear_org_context()
    ev = SyslogEvent(agent_id="ghost-agent", source_ip="10.0.0.2", message="x")
    db.add(ev)
    with pytest.raises(ScopedContextError) as exc:
        db.flush()
    assert "organization_id" in str(exc.value)


def test_discovery_result_unscopable_agent_fails_closed(db):
    from app.models.discovery_result import DiscoveryResult
    _org(db, "alpha")
    clear_org_context()
    dr = DiscoveryResult(agent_id="ghost-agent", subnet="10.0.0.0/24")
    db.add(dr)
    with pytest.raises(ScopedContextError):
        db.flush()


# ── PostgreSQL tests — RLS location filtering + FK ondelete fix ──────────────

pg_only = pytest.mark.skipif(
    not _IS_PG, reason="RLS + FK ondelete are DB-level — require PostgreSQL",
)


class _pg_session:
    """Per-test async session on a fresh NullPool engine — every connection
    is opened and closed within the calling test's event loop, so a pooled
    connection can never leak across pytest-asyncio's per-test loops."""

    def __init__(self):
        from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
        from sqlalchemy.pool import NullPool
        self._engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
        self._factory = async_sessionmaker(self._engine, expire_on_commit=False)

    async def __aenter__(self):
        self._session = self._factory()
        return self._session

    async def __aexit__(self, *exc):
        await self._session.close()
        await self._engine.dispose()


async def _syslog_count(*, org_id, location_id=None, super_admin=False):
    from app.core.org_context import superadmin_context
    from app.core.rls import apply_rls_context
    from app.models.syslog_event import SyslogEvent

    async with _pg_session() as db:
        if super_admin:
            with superadmin_context():
                await apply_rls_context(db)
                return (await db.execute(
                    select(func.count()).select_from(SyslogEvent))).scalar()
        if org_id is None:
            clear_org_context()
        else:
            set_org_context(org_id, location_id, False)
        await apply_rls_context(db)
        try:
            return (await db.execute(
                select(func.count()).select_from(SyslogEvent))).scalar()
        finally:
            clear_org_context()


@pg_only
@pytest.mark.asyncio
async def test_syslog_no_context_is_empty():
    """A session with no org context reads zero syslog rows."""
    assert await _syslog_count(org_id=None) == 0


@pg_only
@pytest.mark.asyncio
async def test_syslog_rls_is_org_isolated():
    """org-1 sees only its own syslog rows; org-2 never sees org-1's."""
    n_super = await _syslog_count(org_id=None, super_admin=True)
    n_org1 = await _syslog_count(org_id=1)
    n_org2 = await _syslog_count(org_id=2)
    assert n_org1 + n_org2 <= n_super, "per-org syslog counts exceed the global total"
    assert n_org1 <= n_super


@pg_only
@pytest.mark.asyncio
async def test_syslog_location_filter_narrows_rows():
    """A location-scoped session sees a subset of the org-wide rows; every
    row it sees actually belongs to that location."""
    
    from app.core.org_context import superadmin_context
    from app.core.rls import apply_rls_context
    from app.models.syslog_event import SyslogEvent

    # Discover an (org, location) pair that actually has syslog rows.
    async with _pg_session() as db:
        with superadmin_context():
            await apply_rls_context(db)
            row = (await db.execute(
                select(SyslogEvent.organization_id, SyslogEvent.location_id,
                       func.count())
                .where(SyslogEvent.location_id.isnot(None))
                .group_by(SyslogEvent.organization_id, SyslogEvent.location_id)
                .limit(1)
            )).first()
    if row is None:
        pytest.skip("no location-stamped syslog rows seeded to assert against")
    org_id, loc_id, loc_count = row

    n_org_all = await _syslog_count(org_id=org_id)
    n_org_loc = await _syslog_count(org_id=org_id, location_id=loc_id)
    assert n_org_loc <= n_org_all, "location filter must not widen the result"
    assert n_org_loc >= loc_count, "location-scoped read missed seeded rows"

    # Every row visible under the location scope belongs to that location.
    async with _pg_session() as db:
        set_org_context(org_id, loc_id, False)
        await apply_rls_context(db)
        try:
            foreign = (await db.execute(
                select(func.count()).select_from(SyslogEvent)
                .where(SyslogEvent.location_id != loc_id)
            )).scalar()
        finally:
            clear_org_context()
    assert foreign == 0, f"location scope leaked {foreign} other-location rows"


@pg_only
@pytest.mark.asyncio
async def test_both_tables_carry_org_location_policy():
    """`syslog_events` and `discovery_results` each have the org_isolation
    policy, and its USING clause references app.current_location_id."""
    

    async with _pg_session() as db:
        rows = (await db.execute(text(
            "SELECT tablename, qual FROM pg_policies "
            "WHERE policyname = 'org_isolation' "
            "AND tablename IN ('syslog_events', 'discovery_results')"
        ))).all()
    by_table = {t: q for t, q in rows}
    for tbl in ("syslog_events", "discovery_results"):
        assert tbl in by_table, f"{tbl} has no org_isolation policy"
        assert "app.current_location_id" in by_table[tbl], (
            f"{tbl} policy does not enforce location scope"
        )


@pg_only
@pytest.mark.asyncio
async def test_no_notnull_location_fk_uses_set_null():
    """The Phase C contradiction fix: no FK on a NOT NULL location_id
    column may carry ON DELETE SET NULL — SET NULL cannot apply to a
    NOT NULL column."""
    

    async with _pg_session() as db:
        rows = (await db.execute(text(
            "SELECT con.conrelid::regclass::text "
            "FROM pg_constraint con "
            "JOIN pg_attribute a ON a.attrelid = con.conrelid "
            "  AND a.attnum = ANY(con.conkey) "
            "WHERE con.contype = 'f' "
            "  AND con.confrelid = 'locations'::regclass "
            "  AND con.confdeltype = 'n' "
            "  AND a.attname = 'location_id' "
            "  AND a.attnotnull"
        ))).all()
    assert rows == [], (
        f"NOT NULL location_id FKs still use ON DELETE SET NULL: "
        f"{[r[0] for r in rows]}"
    )


@pg_only
@pytest.mark.asyncio
async def test_discovery_results_location_fk_is_restrict():
    """discovery_results.location_id FK is ON DELETE RESTRICT (confdeltype 'r')."""
    

    async with _pg_session() as db:
        deltype = (await db.execute(text(
            "SELECT confdeltype::text FROM pg_constraint "
            "WHERE conname = 'discovery_results_location_id_fkey'"
        ))).scalar()
    assert deltype == "r", f"expected RESTRICT ('r'), got {deltype!r}"
