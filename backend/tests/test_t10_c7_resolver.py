"""T10 C7.A — resolve_port_policy per-port override zinciri.

Yeni resolver adımı: PortPolicyAssignment (device_id+port_name, deleted_at IS NULL).
Mevcut zincir (cihaz default → org default → fallback) C2 testlerinde kapsanmıştı —
burada YALNIZ yeni adımı ve geri uyumluluğu test ediyoruz.

SQLite + sahte device. C2'deki _adb pattern'ini takip eder + port_policy_assignments.
"""
from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.database import Base, SharedBase
import app.models  # noqa: F401 — model registry
from app.core.org_context import set_org_context, clear_org_context
from app.services import security_policy_service as svc
from app.services.security_policy_service import FALLBACK_NAME


def _create_all(sync_conn):
    from app.models.shared.organization import Organization
    from app.models.device import Device
    from app.models.user import User
    from app.models.security_policy import SwitchSecurityPolicy, PortSecurityPolicy
    from app.models.port_policy_assignment import PortPolicyAssignment
    SharedBase.metadata.create_all(sync_conn, tables=[Organization.__table__])
    Base.metadata.create_all(sync_conn, tables=[
        User.__table__, Device.__table__,
        SwitchSecurityPolicy.__table__, PortSecurityPolicy.__table__,
        PortPolicyAssignment.__table__,
    ])


class _adb:
    async def __aenter__(self):
        self._e = create_async_engine("sqlite+aiosqlite://")
        async with self._e.begin() as c:
            await c.run_sync(_create_all)
        self._s = async_sessionmaker(self._e, expire_on_commit=False)()
        return self._s

    async def __aexit__(self, *exc):
        await self._s.close()
        await self._e.dispose()


@pytest.fixture(autouse=True)
def _ctx():
    set_org_context(1, 1, is_super_admin=True)
    yield
    clear_org_context()


def _dev(dev_id=10, **kw):
    base = {"id": dev_id, "security_policy_id": None,
            "port_security_policy_id": None, "organization_id": 1}
    base.update(kw)
    return type("D", (), base)()


# ── Per-port override zinciri (C7.A YENİ adım) ───────────────────────────────

@pytest.mark.asyncio
async def test_per_port_override_wins_over_device_default():
    from app.models.security_policy import PortSecurityPolicy
    from app.models.port_policy_assignment import PortPolicyAssignment
    async with _adb() as db:
        override = PortSecurityPolicy(organization_id=1, name="kamera", mac_flood_warning=1)
        device_def = PortSecurityPolicy(organization_id=1, name="default-port",
                                        is_default=True, mac_flood_warning=5)
        db.add_all([override, device_def])
        await db.commit()
        now = datetime.now(timezone.utc)
        db.add(PortPolicyAssignment(
            device_id=10, port_name="Gi1/0/3",
            port_security_policy_id=override.id, organization_id=1,
            created_at=now, updated_at=now,
        ))
        await db.commit()
        dev = _dev(port_security_policy_id=device_def.id)
        got = await svc.resolve_port_policy(db, dev, port_name="Gi1/0/3")
    assert got.name == "kamera" and got.mac_flood_warning == 1


@pytest.mark.asyncio
async def test_per_port_override_skipped_when_port_name_none():
    """port_name verilmezse override adımı atlanır (geri uyumluluk)."""
    from app.models.security_policy import PortSecurityPolicy
    from app.models.port_policy_assignment import PortPolicyAssignment
    async with _adb() as db:
        override = PortSecurityPolicy(organization_id=1, name="kamera", mac_flood_warning=1)
        device_def = PortSecurityPolicy(organization_id=1, name="default-port",
                                        is_default=True, mac_flood_warning=5)
        db.add_all([override, device_def])
        await db.commit()
        now = datetime.now(timezone.utc)
        db.add(PortPolicyAssignment(
            device_id=10, port_name="Gi1/0/3",
            port_security_policy_id=override.id, organization_id=1,
            created_at=now, updated_at=now,
        ))
        await db.commit()
        dev = _dev(port_security_policy_id=device_def.id)
        got = await svc.resolve_port_policy(db, dev, port_name=None)  # override pas geçilir
    assert got.name == "default-port"


@pytest.mark.asyncio
async def test_per_port_override_for_other_port_does_not_leak():
    """Port A için override var ama Port B sorgulanıyor → cihaz default."""
    from app.models.security_policy import PortSecurityPolicy
    from app.models.port_policy_assignment import PortPolicyAssignment
    async with _adb() as db:
        override = PortSecurityPolicy(organization_id=1, name="kamera", mac_flood_warning=1)
        device_def = PortSecurityPolicy(organization_id=1, name="default-port",
                                        is_default=True, mac_flood_warning=5)
        db.add_all([override, device_def])
        await db.commit()
        now = datetime.now(timezone.utc)
        db.add(PortPolicyAssignment(
            device_id=10, port_name="Gi1/0/3",
            port_security_policy_id=override.id, organization_id=1,
            created_at=now, updated_at=now,
        ))
        await db.commit()
        dev = _dev(port_security_policy_id=device_def.id)
        got = await svc.resolve_port_policy(db, dev, port_name="Gi1/0/99")
    assert got.name == "default-port"


@pytest.mark.asyncio
async def test_per_port_soft_deleted_ignored():
    """deleted_at IS NOT NULL → override yokmuş gibi, cihaz default kullanılır."""
    from app.models.security_policy import PortSecurityPolicy
    from app.models.port_policy_assignment import PortPolicyAssignment
    async with _adb() as db:
        override = PortSecurityPolicy(organization_id=1, name="kamera", mac_flood_warning=1)
        device_def = PortSecurityPolicy(organization_id=1, name="default-port",
                                        is_default=True, mac_flood_warning=5)
        db.add_all([override, device_def])
        await db.commit()
        now = datetime.now(timezone.utc)
        db.add(PortPolicyAssignment(
            device_id=10, port_name="Gi1/0/3",
            port_security_policy_id=override.id, organization_id=1,
            created_at=now, updated_at=now, deleted_at=now,  # soft-deleted
        ))
        await db.commit()
        dev = _dev(port_security_policy_id=device_def.id)
        got = await svc.resolve_port_policy(db, dev, port_name="Gi1/0/3")
    assert got.name == "default-port"


@pytest.mark.asyncio
async def test_per_port_override_no_device_default_falls_to_org():
    """Override yok, cihaz default yok → org default."""
    from app.models.security_policy import PortSecurityPolicy
    async with _adb() as db:
        org_def = PortSecurityPolicy(organization_id=1, name="org-default",
                                     is_default=True, mac_flood_warning=5)
        db.add(org_def)
        await db.commit()
        got = await svc.resolve_port_policy(db, _dev(), port_name="Gi1/0/1")
    assert got.name == "org-default"


@pytest.mark.asyncio
async def test_per_port_no_override_no_default_falls_to_hardcoded():
    async with _adb() as db:
        got = await svc.resolve_port_policy(db, _dev(), port_name="Gi1/0/1")
    assert got.name == FALLBACK_NAME


# ── Senkron eş (resolve_port_policy_sync) — aynı zincir ──────────────────────

def test_sync_per_port_override_wins_over_device_default():
    """Sync resolver de aynı zinciri kullanır."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.models.security_policy import PortSecurityPolicy
    from app.models.port_policy_assignment import PortPolicyAssignment

    e = create_engine("sqlite://")
    with e.begin() as c:
        _create_all(c)
    S = sessionmaker(e, expire_on_commit=False)
    s = S()
    override = PortSecurityPolicy(organization_id=1, name="kamera-sync", mac_flood_warning=1)
    device_def = PortSecurityPolicy(organization_id=1, name="default-sync",
                                    is_default=True, mac_flood_warning=5)
    s.add_all([override, device_def]); s.commit()
    now = datetime.now(timezone.utc)
    s.add(PortPolicyAssignment(
        device_id=10, port_name="Gi1/0/3",
        port_security_policy_id=override.id, organization_id=1,
        created_at=now, updated_at=now,
    ))
    s.commit()
    dev = _dev(port_security_policy_id=device_def.id)
    got = svc.resolve_port_policy_sync(s, dev, port_name="Gi1/0/3")
    assert got.name == "kamera-sync"
    s.close(); e.dispose()
