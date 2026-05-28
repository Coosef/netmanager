"""
T10 Faz C C2 — Security Policy resolver + set_default.

Zincir: atanmış policy → org default → hardcoded fallback. NULL semantic korunur.
SQLite (policy tabloları JSONB içermez). Sahte device objesi (getattr) ile resolver.
"""
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy import select

from app.core.database import Base, SharedBase
import app.models  # noqa: F401
from app.core.org_context import set_org_context, clear_org_context
from app.services import security_policy_service as svc
from app.services.security_policy_service import FALLBACK_NAME


def _create(sync_conn):
    from app.models.shared.organization import Organization
    from app.models.security_policy import SwitchSecurityPolicy, PortSecurityPolicy
    SharedBase.metadata.create_all(sync_conn, tables=[Organization.__table__])
    Base.metadata.create_all(sync_conn, tables=[
        SwitchSecurityPolicy.__table__, PortSecurityPolicy.__table__,
    ])


class _adb:
    async def __aenter__(self):
        self._e = create_async_engine("sqlite+aiosqlite://")
        async with self._e.begin() as c:
            await c.run_sync(_create)
        self._s = async_sessionmaker(self._e, expire_on_commit=False)()
        return self._s

    async def __aexit__(self, *exc):
        await self._s.close(); await self._e.dispose()


@pytest.fixture(autouse=True)
def _ctx():
    set_org_context(1, 1, is_super_admin=True)
    yield
    clear_org_context()


def _dev(**kw):
    base = {"security_policy_id": None, "port_security_policy_id": None, "organization_id": 1}
    base.update(kw)
    return type("D", (), base)()


# ── switch resolver zinciri ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_switch_assigned_policy_wins():
    from app.models.security_policy import SwitchSecurityPolicy
    async with _adb() as db:
        p = SwitchSecurityPolicy(organization_id=1, name="Backbone", cpu_critical=75)
        db.add(p); await db.commit()
        got = await svc.resolve_switch_policy(db, _dev(security_policy_id=p.id))
    assert got.name == "Backbone" and got.cpu_critical == 75


@pytest.mark.asyncio
async def test_switch_falls_back_to_org_default():
    from app.models.security_policy import SwitchSecurityPolicy
    async with _adb() as db:
        db.add(SwitchSecurityPolicy(organization_id=1, name="Default", is_default=True, cpu_critical=85))
        await db.commit()
        got = await svc.resolve_switch_policy(db, _dev())  # atanmamış → org default
    assert got.name == "Default" and got.is_default is True


@pytest.mark.asyncio
async def test_switch_hardcoded_fallback_when_no_default():
    async with _adb() as db:
        got = await svc.resolve_switch_policy(db, _dev())  # ne atama ne org default
    assert got.name == FALLBACK_NAME and got.cpu_critical == 85   # baseline


# ── port resolver zinciri ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_port_assigned_then_default_then_fallback():
    from app.models.security_policy import PortSecurityPolicy
    async with _adb() as db:
        assigned = PortSecurityPolicy(organization_id=1, name="uplink", mac_flood_warning=None)
        default = PortSecurityPolicy(organization_id=1, name="default", is_default=True, mac_flood_warning=5)
        db.add_all([assigned, default]); await db.commit()
        # 1) atanmış
        g1 = await svc.resolve_port_policy(db, _dev(port_security_policy_id=assigned.id))
        assert g1.name == "uplink" and g1.mac_flood_warning is None  # NULL semantic korunur
        # 2) atanmamış → org default
        g2 = await svc.resolve_port_policy(db, _dev())
        assert g2.name == "default"
    # 3) fallback
    async with _adb() as db:
        g3 = await svc.resolve_port_policy(db, _dev())
        assert g3.name == FALLBACK_NAME


# ── set_default — eski default flag'i kalkar ─────────────────────────────────

@pytest.mark.asyncio
async def test_set_default_clears_previous():
    from app.models.security_policy import SwitchSecurityPolicy
    async with _adb() as db:
        old = SwitchSecurityPolicy(organization_id=1, name="old", is_default=True)
        new = SwitchSecurityPolicy(organization_id=1, name="new", is_default=False)
        db.add_all([old, new]); await db.commit()
        await svc.set_default(db, SwitchSecurityPolicy, 1, new.id)
        await db.commit()
        rows = (await db.execute(select(SwitchSecurityPolicy))).scalars().all()
    by_name = {r.name: r.is_default for r in rows}
    assert by_name["new"] is True and by_name["old"] is False  # org başına tek default


def test_policy_label():
    from app.models.security_policy import SwitchSecurityPolicy
    assert svc.policy_label(SwitchSecurityPolicy(name="X")) == "X"
    assert svc.policy_label(SwitchSecurityPolicy(name=None)) == FALLBACK_NAME
