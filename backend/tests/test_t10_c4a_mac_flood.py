"""
T10 Faz C C4a — MAC flood (port başına MAC sayısı; read-only).

evaluate_port_flood: saf eşik eval (NULL→None/skip, critical>warning, [policy=] etiketi).
resolve_port_policy_sync: device port FK → org default → hardcoded fallback (sync).
poll_mac_anomalies task'ı bunları kullanır; shutdown YOK (sadece alarm). flap C4b.
"""
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.database import Base, SharedBase
import app.models  # noqa: F401
from app.core.org_context import set_org_context, clear_org_context
from app.models.security_policy import PortSecurityPolicy
from app.services import security_policy_service as svc
from app.services.security_policy_service import (
    FALLBACK_NAME, evaluate_port_flood, is_uplink_port,
)


# ── uplink heuristic skip (C4a false-positive azaltma) ───────────────────────

def test_uplink_ports_skipped():
    for p in ["TenGigabitEthernet 0/16", "Te0/1", "Port-channel1", "Po1",
              "uplink-to-core", "AggregationLink", "ae0", "bond0", "lag1",
              "FortyGigE1/0/1", "HundredGigE1/0/1", "trunk-2"]:
        assert is_uplink_port(p) is True, p


def test_access_ports_not_skipped():
    for p in ["GigabitEthernet0/1", "Gi0/1", "FastEthernet0/2", "Fa0/2",
              "Ethernet1", "Eth1/0/3", "1/0/5", None, ""]:
        assert is_uplink_port(p) is False, p


def _pol(**kw):
    return PortSecurityPolicy(name=kw.pop("name", "default"), **kw)


# ── evaluate_port_flood (saf) ────────────────────────────────────────────────

def test_flood_critical():
    spec = evaluate_port_flood("sw1", "Gi0/1", 12, _pol(mac_flood_warning=5, mac_flood_critical=10))
    assert spec["event_type"] == "mac_flood" and spec["severity"] == "critical"
    assert spec["details"]["mac_count"] == 12 and spec["details"]["threshold"] == 10
    assert "[policy=default]" in spec["message"] and "Gi0/1" in spec["message"]


def test_flood_warning_band():
    spec = evaluate_port_flood("sw1", "Gi0/1", 7, _pol(mac_flood_warning=5, mac_flood_critical=10))
    assert spec["severity"] == "warning" and spec["details"]["threshold"] == 5


def test_flood_below_warning_none():
    assert evaluate_port_flood("sw1", "Gi0/1", 3, _pol(mac_flood_warning=5, mac_flood_critical=10)) is None


def test_flood_null_threshold_skips():
    # uplink: mac_flood NULL → yüzlerce MAC normal → alarm yok
    assert evaluate_port_flood("sw1", "Te1/1", 250, _pol(name="uplink", mac_flood_warning=None,
                                                         mac_flood_critical=None)) is None


def test_flood_label_uses_fallback_name():
    spec = evaluate_port_flood("sw1", "Gi0/1", 99, PortSecurityPolicy(name=None, mac_flood_critical=10))
    assert f"[policy={FALLBACK_NAME}]" in spec["message"]


# ── resolve_port_policy_sync zinciri (SQLite) ────────────────────────────────

def _create(sync_conn):
    from app.models.shared.organization import Organization
    SharedBase.metadata.create_all(sync_conn, tables=[Organization.__table__])
    Base.metadata.create_all(sync_conn, tables=[PortSecurityPolicy.__table__])


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
    base = {"port_security_policy_id": None, "organization_id": 1}
    base.update(kw)
    return type("D", (), base)()


@pytest.mark.asyncio
async def test_resolve_port_sync_chain():
    # NOTE: resolve_port_policy_sync senkron; async session'ın sync_session'ını kullan
    async with _adb() as db:
        await db.run_sync(lambda s: s.add_all([
            PortSecurityPolicy(organization_id=1, name="default", is_default=True, mac_flood_warning=5),
            PortSecurityPolicy(organization_id=1, name="uplink", mac_flood_warning=None),
        ]))
        await db.commit()

        def _checks(sync_sess):
            from app.models.security_policy import PortSecurityPolicy as P
            uplink = sync_sess.execute(
                __import__("sqlalchemy").select(P).where(P.name == "uplink")
            ).scalar_one()
            # 1) atanmış
            g1 = svc.resolve_port_policy_sync(sync_sess, _dev(port_security_policy_id=uplink.id))
            assert g1.name == "uplink" and g1.mac_flood_warning is None
            # 2) atanmamış → org default
            g2 = svc.resolve_port_policy_sync(sync_sess, _dev())
            assert g2.name == "default"
        await db.run_sync(_checks)


@pytest.mark.asyncio
async def test_resolve_port_sync_fallback():
    async with _adb() as db:
        def _check(sync_sess):
            g = svc.resolve_port_policy_sync(sync_sess, _dev())  # ne atama ne default
            assert g.name == FALLBACK_NAME and g.mac_flood_warning == 5
        await db.run_sync(_check)
