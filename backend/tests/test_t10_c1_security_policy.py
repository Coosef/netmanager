"""
T10 Faz C C1 — security policy modelleri: org-scoping, NULL semantic, FK ataması.

SQLite harness (policy tabloları JSONB içermez → create edilebilir). RLS DB-izolasyonu
SQLite'ta test EDİLEMEZ (RLS yok) → canlı Postgres'te doğrulandı:
  org=1 GUC → yalnız org1; org=2 → yalnız org2; cross-org INSERT WITH CHECK reddi.
Bu test model sözleşmesini + _scoping org-stamping'i + device FK atamasını sabitler.
"""
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy import select

from app.core.database import Base, SharedBase
import app.models  # noqa: F401 — register models + scoping hook
from app.core.org_context import set_org_context, clear_org_context


def _create_tables(sync_conn):
    from app.models.shared.organization import Organization
    from app.models.location import Location
    from app.models.device import Device
    from app.models.security_policy import SwitchSecurityPolicy, PortSecurityPolicy
    SharedBase.metadata.create_all(sync_conn, tables=[Organization.__table__])
    Base.metadata.create_all(sync_conn, tables=[
        Location.__table__, Device.__table__,
        SwitchSecurityPolicy.__table__, PortSecurityPolicy.__table__,
    ])


class _adb:
    async def __aenter__(self):
        self._engine = create_async_engine("sqlite+aiosqlite://")
        async with self._engine.begin() as conn:
            await conn.run_sync(_create_tables)
        self._session = async_sessionmaker(self._engine, expire_on_commit=False)()
        return self._session

    async def __aexit__(self, *exc):
        await self._session.close()
        await self._engine.dispose()


@pytest.fixture(autouse=True)
def _ctx():
    set_org_context(1, 1, is_super_admin=True)
    yield
    clear_org_context()


async def _org(db, oid, slug):
    from app.models.shared.organization import Organization
    o = Organization(id=oid, name=slug.title(), slug=slug)
    db.add(o)
    await db.flush()
    return o


# ── model contract + NULL semantic ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_switch_policy_fields_and_null_semantic():
    from app.models.security_policy import SwitchSecurityPolicy
    async with _adb() as db:
        await _org(db, 1, "alpha")
        p = SwitchSecurityPolicy(
            organization_id=1, name="Default", is_default=True,
            cpu_warning=70, cpu_critical=85,
            # NULL semantic: PoE kontrolü kapalı → poe_budget_* set edilmez (None)
        )
        db.add(p)
        await db.commit()
        got = (await db.execute(select(SwitchSecurityPolicy))).scalar_one()
    assert got.organization_id == 1
    assert got.is_default is True
    assert got.cpu_critical == 85
    assert got.poe_budget_warning_pct is None       # NULL = kontrol kapalı
    assert got.config_change_policy is None


@pytest.mark.asyncio
async def test_port_policy_fields_and_null_semantic():
    from app.models.security_policy import PortSecurityPolicy
    async with _adb() as db:
        await _org(db, 1, "alpha")
        p = PortSecurityPolicy(
            organization_id=1, name="pos", is_default=False,
            mac_flood_warning=1, mac_flood_critical=2,
            auto_quarantine_on_nth_flap=3,   # v1: yalnız dry-run öneri eşiği
        )
        db.add(p)
        await db.commit()
        got = (await db.execute(select(PortSecurityPolicy))).scalar_one()
    assert got.mac_flood_critical == 2
    assert got.auto_quarantine_on_nth_flap == 3
    assert got.optic_rx_warning_dbm is None          # copper port → optic NULL
    assert got.bandwidth_alert_pct is None


# ── org stamping (_scoping hook) ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_org_stamping_from_context():
    """organization_id verilmezse _scoping hook context'ten (org 1) damgalar."""
    from app.models.security_policy import SwitchSecurityPolicy
    async with _adb() as db:
        await _org(db, 1, "alpha")
        p = SwitchSecurityPolicy(name="ctx", cpu_critical=90)  # org_id YOK
        db.add(p)
        await db.commit()
        got = (await db.execute(select(SwitchSecurityPolicy))).scalar_one()
    assert got.organization_id == 1                  # context'ten damgalandı


# ── device FK ataması (switch + cihaz-geneli port default) ───────────────────

@pytest.mark.asyncio
async def test_device_policy_fk_assignment():
    from app.models.security_policy import SwitchSecurityPolicy, PortSecurityPolicy
    from app.models.location import Location
    from app.models.device import Device
    async with _adb() as db:
        await _org(db, 1, "alpha")
        db.add(Location(id=1, name="loc1", organization_id=1)); await db.flush()
        sw = SwitchSecurityPolicy(organization_id=1, name="Backbone", cpu_critical=75)
        pp = PortSecurityPolicy(organization_id=1, name="uplink", bandwidth_alert_pct=95)
        db.add_all([sw, pp]); await db.flush()
        dev = Device(
            id=1, hostname="sw-core", ip_address="10.0.0.1",
            ssh_username="a", ssh_password_enc="e",
            organization_id=1, location_id=1,
            security_policy_id=sw.id, port_security_policy_id=pp.id,
        )
        db.add(dev); await db.commit()
        got = await db.get(Device, 1)
    assert got.security_policy_id == sw.id
    assert got.port_security_policy_id == pp.id


# ── org bazlı izolasyon (model seviyesi; RLS canlı Postgres'te) ──────────────

@pytest.mark.asyncio
async def test_two_orgs_policies_coexist():
    from app.models.security_policy import SwitchSecurityPolicy
    async with _adb() as db:
        await _org(db, 1, "alpha"); await _org(db, 2, "bravo")
        db.add_all([
            SwitchSecurityPolicy(organization_id=1, name="Default", is_default=True),
            SwitchSecurityPolicy(organization_id=2, name="Default", is_default=True),
        ])
        await db.commit()
        org1 = (await db.execute(
            select(SwitchSecurityPolicy).where(SwitchSecurityPolicy.organization_id == 1)
        )).scalars().all()
        org2 = (await db.execute(
            select(SwitchSecurityPolicy).where(SwitchSecurityPolicy.organization_id == 2)
        )).scalars().all()
    assert len(org1) == 1 and org1[0].organization_id == 1
    assert len(org2) == 1 and org2[0].organization_id == 2
