"""T10 C7.A — Port policy per-port assignment CRUD.

Endpoint prefix: /devices/{device_id}/port-policy-assignments
- GET    → cihazın port → policy haritası (org içi)
- POST   → toplu upsert `[{port_name, port_security_policy_id}, ...]`
- PATCH  → tek port policy değişikliği
- DELETE → override kaldır (resolver bir alt katmana düşer)

Yetki: viewer okur, org_admin+ yazar (RBAC). Feature gate: `security_policy`
(router.py'de _feat). RLS (ScopedDb): cihaz/policy yalnız org içinde görünür;
cross-org assignment otomatik 404 verir (kayıt RLS'te yok). Cross-org policy
ataması ek explicit kontrolle de bloklanır (organization_id eşleşme).

Audit: port_policy_assigned / port_policy_changed / port_policy_removed.

v1 not: port_name exact-match (vendor formatı aynen) + hard delete. Vendor alias
normalizasyonu ve soft delete v2 (deleted_at kolonu altyapı için ileride).
"""
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select

from app.core.deps import ScopedDb, CurrentUser
from app.models.device import Device
from app.models.port_policy_assignment import PortPolicyAssignment
from app.models.security_policy import PortSecurityPolicy
from app.services.audit_service import log_action

router = APIRouter()


def _require_org_admin(user) -> None:
    if not (getattr(user, "is_super_admin", False) or getattr(user, "is_org_admin", False)):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "Yetersiz yetki — org_admin / super_admin")


def _serialize(ppa: PortPolicyAssignment) -> dict[str, Any]:
    return {
        "id": ppa.id,
        "device_id": ppa.device_id,
        "port_name": ppa.port_name,
        "port_security_policy_id": ppa.port_security_policy_id,
        "organization_id": ppa.organization_id,
        "assigned_by": ppa.assigned_by,
        "created_at": ppa.created_at.isoformat() if ppa.created_at else None,
        "updated_at": ppa.updated_at.isoformat() if ppa.updated_at else None,
    }


async def _get_device_scoped(db, device_id: int) -> Device:
    """Cihazı ScopedDb içinde getir (RLS → cross-org/yok = 404)."""
    dev = await db.get(Device, device_id)
    if dev is None:
        raise HTTPException(404, "Cihaz bulunamadı")
    return dev


async def _validate_policy_in_same_org(db, policy_id: int, device_org_id: int) -> PortSecurityPolicy:
    """Policy RLS içinde görünür mü + cihazın org'una mı ait."""
    pol = await db.get(PortSecurityPolicy, policy_id)
    if pol is None:
        # RLS gizledi ya da gerçekten yok — her iki durumda da 400.
        raise HTTPException(400, f"Geçersiz port_security_policy_id={policy_id}")
    if pol.organization_id != device_org_id:
        # RLS aynı org'a sıkıştırmış olur ama defansif kontrol.
        raise HTTPException(400, "Policy cihazın org'una ait değil (cross-org)")
    return pol


@router.get("/{device_id}/port-policy-assignments", response_model=list)
async def list_assignments(
    device_id: int, db: ScopedDb, _: CurrentUser = None,
):
    """Cihazın aktif (deleted_at IS NULL) port → policy override haritası."""
    await _get_device_scoped(db, device_id)
    rows = (await db.execute(
        select(PortPolicyAssignment)
        .where(PortPolicyAssignment.device_id == device_id,
               PortPolicyAssignment.deleted_at.is_(None))
        .order_by(PortPolicyAssignment.port_name)
    )).scalars().all()
    return [_serialize(r) for r in rows]


@router.post("/{device_id}/port-policy-assignments", response_model=list, status_code=200)
async def bulk_assign(
    device_id: int, request: Request, db: ScopedDb, current_user: CurrentUser = None,
):
    """Toplu upsert. Body: `[{port_name, port_security_policy_id}, ...]`.
    Aynı port_name varsa policy güncellenir (changed), yoksa yeni insert (assigned)."""
    _require_org_admin(current_user)
    body = await request.json()
    if not isinstance(body, list) or not body:
        raise HTTPException(400, "Body bir non-empty liste olmalı")
    dev = await _get_device_scoped(db, device_id)

    # Önce tüm policy_id'leri validate et — atomik niyet, hata varsa hiçbiri yazılmasın.
    seen_ports = set()
    items: list[dict] = []
    for raw in body:
        if not isinstance(raw, dict):
            raise HTTPException(400, "Her öğe {port_name, port_security_policy_id} olmalı")
        port_name = (raw.get("port_name") or "").strip()
        policy_id = raw.get("port_security_policy_id")
        if not port_name:
            raise HTTPException(400, "port_name zorunlu")
        if not isinstance(policy_id, int):
            raise HTTPException(400, "port_security_policy_id int olmalı")
        if port_name in seen_ports:
            raise HTTPException(400, f"Aynı port_name yinelendi: {port_name}")
        seen_ports.add(port_name)
        await _validate_policy_in_same_org(db, policy_id, dev.organization_id)
        items.append({"port_name": port_name, "policy_id": policy_id})

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    out: list[dict] = []
    for it in items:
        existing = (await db.execute(
            select(PortPolicyAssignment).where(
                PortPolicyAssignment.device_id == device_id,
                PortPolicyAssignment.port_name == it["port_name"],
            )
        )).scalar_one_or_none()
        if existing is not None:
            old = existing.port_security_policy_id
            existing.port_security_policy_id = it["policy_id"]
            existing.assigned_by = getattr(current_user, "id", None)
            existing.updated_at = now
            existing.deleted_at = None  # eski soft-delete varsa diriltir
            action = "port_policy_changed"
            details = {"port_name": it["port_name"], "old": old, "new": it["policy_id"]}
            obj = existing
        else:
            obj = PortPolicyAssignment(
                device_id=device_id,
                port_name=it["port_name"],
                port_security_policy_id=it["policy_id"],
                organization_id=dev.organization_id,  # _scoping hook fallback
                assigned_by=getattr(current_user, "id", None),
                created_at=now,
                updated_at=now,
            )
            db.add(obj)
            action = "port_policy_assigned"
            details = {"port_name": it["port_name"], "policy_id": it["policy_id"]}
        await db.flush()
        await log_action(db, current_user, action,
                         resource_type="device", resource_id=device_id,
                         resource_name=getattr(dev, "hostname", None),
                         details=details, request=request)
        out.append(_serialize(obj))
    await db.commit()
    for o in out:
        # refresh yok — _serialize zaten doldurdu (commit sonrası id stable).
        pass
    return out


@router.patch("/{device_id}/port-policy-assignments/{port_name}", response_model=dict)
async def patch_assignment(
    device_id: int, port_name: str, request: Request, db: ScopedDb,
    current_user: CurrentUser = None,
):
    """Tek bir portun policy'sini değiştir. Yoksa 404."""
    _require_org_admin(current_user)
    body = await request.json()
    new_policy_id = body.get("port_security_policy_id")
    if not isinstance(new_policy_id, int):
        raise HTTPException(400, "port_security_policy_id int olmalı")
    dev = await _get_device_scoped(db, device_id)
    await _validate_policy_in_same_org(db, new_policy_id, dev.organization_id)
    ppa = (await db.execute(
        select(PortPolicyAssignment).where(
            PortPolicyAssignment.device_id == device_id,
            PortPolicyAssignment.port_name == port_name,
            PortPolicyAssignment.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if ppa is None:
        raise HTTPException(404, "Atama bulunamadı (önce POST ile oluşturun)")
    from datetime import datetime, timezone
    old = ppa.port_security_policy_id
    ppa.port_security_policy_id = new_policy_id
    ppa.assigned_by = getattr(current_user, "id", None)
    ppa.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await log_action(db, current_user, "port_policy_changed",
                     resource_type="device", resource_id=device_id,
                     resource_name=getattr(dev, "hostname", None),
                     details={"port_name": port_name, "old": old, "new": new_policy_id},
                     request=request)
    return _serialize(ppa)


@router.delete("/{device_id}/port-policy-assignments/{port_name}", status_code=204)
async def delete_assignment(
    device_id: int, port_name: str, request: Request, db: ScopedDb,
    current_user: CurrentUser = None,
):
    """Override kaldır (hard delete). Resolver bir alt katmana düşer (cihaz default → org → fallback)."""
    _require_org_admin(current_user)
    dev = await _get_device_scoped(db, device_id)
    ppa = (await db.execute(
        select(PortPolicyAssignment).where(
            PortPolicyAssignment.device_id == device_id,
            PortPolicyAssignment.port_name == port_name,
        )
    )).scalar_one_or_none()
    if ppa is None:
        raise HTTPException(404, "Atama bulunamadı")
    old_policy = ppa.port_security_policy_id
    await db.delete(ppa)
    await db.commit()
    await log_action(db, current_user, "port_policy_removed",
                     resource_type="device", resource_id=device_id,
                     resource_name=getattr(dev, "hostname", None),
                     details={"port_name": port_name, "removed_policy_id": old_policy},
                     request=request)
    return None
