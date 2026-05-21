"""Asset Lifecycle / CMDB endpoints."""
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import desc, func, select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.asset_lifecycle import AssetLifecycle
from app.models.device import Device
from app.services.audit_service import log_action
from app.services.eol_lookup import lookup_eol

router = APIRouter()

TODAY = lambda: date.today()  # noqa: E731


# ── Schemas ───────────────────────────────────────────────────────────────────

class AssetUpsertRequest(BaseModel):
    device_id: int
    purchase_date: Optional[date] = None
    warranty_expiry: Optional[date] = None
    eol_date: Optional[date] = None
    eos_date: Optional[date] = None
    purchase_cost: Optional[float] = None
    currency: str = "TRY"
    po_number: Optional[str] = None
    vendor_contract: Optional[str] = None
    support_tier: Optional[str] = None
    maintenance_notes: Optional[str] = None


def _lifecycle_status(asset: AssetLifecycle) -> str:
    today = date.today()
    in_30 = today + timedelta(days=30)
    in_90 = today + timedelta(days=90)

    if asset.eol_date and asset.eol_date <= today:
        return "eol"
    if asset.warranty_expiry and asset.warranty_expiry < today:
        return "expired"
    if asset.warranty_expiry and asset.warranty_expiry <= in_30:
        return "expiring_soon"
    if asset.warranty_expiry and asset.warranty_expiry <= in_90:
        return "expiring_90d"
    return "ok"


def _serialize(asset: AssetLifecycle) -> dict:
    return {
        "id": asset.id,
        "device_id": asset.device_id,
        "device_hostname": asset.device_hostname,
        "purchase_date": asset.purchase_date.isoformat() if asset.purchase_date else None,
        "warranty_expiry": asset.warranty_expiry.isoformat() if asset.warranty_expiry else None,
        "eol_date": asset.eol_date.isoformat() if asset.eol_date else None,
        "eos_date": asset.eos_date.isoformat() if asset.eos_date else None,
        "purchase_cost": asset.purchase_cost,
        "currency": asset.currency,
        "po_number": asset.po_number,
        "vendor_contract": asset.vendor_contract,
        "support_tier": asset.support_tier,
        "maintenance_notes": asset.maintenance_notes,
        "lifecycle_status": _lifecycle_status(asset),
        "created_at": asset.created_at.isoformat() if asset.created_at else None,
        "updated_at": asset.updated_at.isoformat() if asset.updated_at else None,
    }


# ── Stats ─────────────────────────────────────────────────────────────────────

@router.get("/stats")
async def get_asset_stats(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    site: Optional[str] = Query(None),
):
    today = date.today()
    in_30 = today + timedelta(days=30)
    in_90 = today + timedelta(days=90)

    asset_q = select(AssetLifecycle)
    if site:
        site_ids = select(Device.id).where(Device.site == site, Device.is_active == True)
        asset_q = asset_q.where(AssetLifecycle.device_id.in_(site_ids))
    result = await db.execute(asset_q)
    assets = result.scalars().all()

    total = len(assets)
    expired = sum(1 for a in assets if a.warranty_expiry and a.warranty_expiry < today)
    expiring_30 = sum(
        1 for a in assets
        if a.warranty_expiry and today <= a.warranty_expiry <= in_30
    )
    expiring_90 = sum(
        1 for a in assets
        if a.warranty_expiry and today <= a.warranty_expiry <= in_90
    )
    eol_count = sum(1 for a in assets if a.eol_date and a.eol_date <= today)
    total_cost = sum(a.purchase_cost or 0 for a in assets)

    # All upcoming expirations in next 90 days — warranty, EOL, EOS combined
    upcoming_all = []
    for a in assets:
        hostname = a.device_hostname or f"#{a.device_id}"
        for label, field_date in [
            ("Garanti", a.warranty_expiry),
            ("EOL", a.eol_date),
            ("EOS", a.eos_date),
        ]:
            if field_date and today <= field_date <= in_90:
                upcoming_all.append({
                    "device_id": a.device_id,
                    "device_hostname": hostname,
                    "type": label,
                    "date": field_date.isoformat(),
                    "days_left": (field_date - today).days,
                    "lifecycle_status": _lifecycle_status(a),
                })

    upcoming_all.sort(key=lambda x: x["days_left"])

    return {
        "total": total,
        "expired": expired,
        "expiring_30d": expiring_30,
        "expiring_90d": expiring_90,
        "eol_count": eol_count,
        "total_cost": round(total_cost, 2),
        "upcoming_expirations": upcoming_all[:15],
    }


# ── List ──────────────────────────────────────────────────────────────────────

@router.get("/")
async def list_assets(
    search: Optional[str] = None,
    status: Optional[str] = None,  # ok | expiring_soon | expiring_90d | expired | eol
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    site: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    today = date.today()
    in_30 = today + timedelta(days=30)
    in_90 = today + timedelta(days=90)

    q = select(AssetLifecycle)
    if search:
        q = q.where(AssetLifecycle.device_hostname.ilike(f"%{search}%"))
    if site:
        site_ids = select(Device.id).where(Device.site == site, Device.is_active == True)
        q = q.where(AssetLifecycle.device_id.in_(site_ids))

    if status == "expired":
        q = q.where(AssetLifecycle.warranty_expiry < today)
    elif status == "expiring_soon":
        q = q.where(AssetLifecycle.warranty_expiry >= today, AssetLifecycle.warranty_expiry <= in_30)
    elif status == "expiring_90d":
        q = q.where(AssetLifecycle.warranty_expiry >= today, AssetLifecycle.warranty_expiry <= in_90)
    elif status == "eol":
        q = q.where(AssetLifecycle.eol_date <= today)

    count_result = await db.execute(select(func.count()).select_from(q.subquery()))
    total = count_result.scalar_one()

    q = q.order_by(AssetLifecycle.warranty_expiry.asc().nullslast()).offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(q)
    assets = result.scalars().all()

    return {"total": total, "items": [_serialize(a) for a in assets]}


# ── Detail ────────────────────────────────────────────────────────────────────

@router.get("/device/{device_id}")
async def get_asset_by_device(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    asset = (
        await db.execute(select(AssetLifecycle).where(AssetLifecycle.device_id == device_id))
    ).scalar_one_or_none()
    if not asset:
        raise HTTPException(404, "Asset kaydı bulunamadı")
    return _serialize(asset)


@router.get("/{asset_id}")
async def get_asset(
    asset_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    asset = (
        await db.execute(select(AssetLifecycle).where(AssetLifecycle.id == asset_id))
    ).scalar_one_or_none()
    if not asset:
        raise HTTPException(404, "Asset kaydı bulunamadı")
    return _serialize(asset)


# ── Create / Update (upsert by device_id) ────────────────────────────────────

@router.post("/")
async def upsert_asset(
    body: AssetUpsertRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    device = (
        await db.execute(select(Device).where(Device.id == body.device_id))
    ).scalar_one_or_none()
    if not device:
        raise HTTPException(404, "Cihaz bulunamadı")

    existing = (
        await db.execute(select(AssetLifecycle).where(AssetLifecycle.device_id == body.device_id))
    ).scalar_one_or_none()

    if existing:
        for field, val in body.model_dump(exclude={"device_id"}).items():
            setattr(existing, field, val)
        existing.device_hostname = device.hostname
        existing.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(existing)
        asset = existing
        action = "asset_lifecycle_updated"
    else:
        asset = AssetLifecycle(
            device_id=device.id,
            device_hostname=device.hostname,
            **body.model_dump(exclude={"device_id"}),
        )
        db.add(asset)
        await db.commit()
        await db.refresh(asset)
        action = "asset_lifecycle_created"

    await log_action(
        db, current_user, action, "asset_lifecycle", str(asset.id),
        f"{device.hostname} asset lifecycle kaydı",
        request=request,
    )
    return _serialize(asset)


@router.put("/{asset_id}")
async def update_asset(
    asset_id: int,
    body: AssetUpsertRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    asset = (
        await db.execute(select(AssetLifecycle).where(AssetLifecycle.id == asset_id))
    ).scalar_one_or_none()
    if not asset:
        raise HTTPException(404, "Asset kaydı bulunamadı")

    device = (
        await db.execute(select(Device).where(Device.id == body.device_id))
    ).scalar_one_or_none()

    for field, val in body.model_dump(exclude={"device_id"}).items():
        setattr(asset, field, val)
    if device:
        asset.device_hostname = device.hostname
    asset.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(asset)

    await log_action(
        db, current_user, "asset_lifecycle_updated", "asset_lifecycle", str(asset_id),
        f"{asset.device_hostname} asset lifecycle güncellendi",
        request=request,
    )
    return _serialize(asset)


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/{asset_id}")
async def delete_asset(
    asset_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    asset = (
        await db.execute(select(AssetLifecycle).where(AssetLifecycle.id == asset_id))
    ).scalar_one_or_none()
    if not asset:
        raise HTTPException(404, "Asset kaydı bulunamadı")

    hostname = asset.device_hostname
    await db.delete(asset)
    await db.commit()

    await log_action(
        db, current_user, "asset_lifecycle_deleted", "asset_lifecycle", str(asset_id),
        f"{hostname} asset lifecycle silindi",
        request=request,
    )
    return {"ok": True}


# ── EOL Lookup ────────────────────────────────────────────────────────────────

@router.post("/eol-lookup")
async def eol_lookup(
    payload: dict,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Look up EOL/EOS dates for devices by model/vendor and upsert into asset_lifecycle.

    Body: { "device_ids": [1, 2, ...] }  — empty list or omit to check all devices.
    Returns per-device results: matched, eol_date, eos_date, or not_found.
    """
    device_ids: list[int] = payload.get("device_ids") or []

    if device_ids:
        q = select(Device).where(Device.id.in_(device_ids))
    else:
        q = select(Device).where(Device.is_active == True)

    devices = (await db.execute(q)).scalars().all()

    results = []
    updated = 0
    not_found = 0

    for device in devices:
        match = lookup_eol(device.vendor or "", device.model or "")
        if not match:
            not_found += 1
            results.append({
                "device_id": device.id,
                "hostname": device.hostname,
                "model": device.model,
                "vendor": device.vendor,
                "status": "not_found",
                "eol_date": None,
                "eos_date": None,
                "matched_model": None,
            })
            continue

        # Upsert into asset_lifecycle
        existing = (
            await db.execute(
                select(AssetLifecycle).where(AssetLifecycle.device_id == device.id)
            )
        ).scalar_one_or_none()

        if existing:
            if match["eol_date"] is not None:
                existing.eol_date = match["eol_date"]
            if match["eos_date"] is not None:
                existing.eos_date = match["eos_date"]
        else:
            existing = AssetLifecycle(
                device_id=device.id,
                device_hostname=device.hostname,
                eol_date=match["eol_date"],
                eos_date=match["eos_date"],
            )
            db.add(existing)

        updated += 1
        results.append({
            "device_id": device.id,
            "hostname": device.hostname,
            "model": device.model,
            "vendor": device.vendor,
            "status": "matched",
            "eol_date": match["eol_date"].isoformat() if match["eol_date"] else None,
            "eos_date": match["eos_date"].isoformat() if match["eos_date"] else None,
            "matched_model": match["matched_model"],
            "source": match["source"],
        })

    await db.commit()

    await log_action(
        db, current_user, "eol_lookup_run", "asset_lifecycle", None, None,
        request=request,
        details={"checked": len(devices), "updated": updated, "not_found": not_found},
    )

    return {
        "checked": len(devices),
        "updated": updated,
        "not_found": not_found,
        "results": results,
    }
