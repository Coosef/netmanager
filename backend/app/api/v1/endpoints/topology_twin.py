"""
Sprint 14B — Network Digital Twin

  POST   /topology-twin/snapshots               — mevcut topolojiyi kilitle (anlık görüntü)
  GET    /topology-twin/snapshots               — tüm anlık görüntüleri listele
  DELETE /topology-twin/snapshots/{id}          — anlık görüntü sil
  POST   /topology-twin/snapshots/{id}/set-golden — altın baseline olarak işaretle
  GET    /topology-twin/diff                    — aktif topoloji vs altın baseline karşılaştırması
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.device import Device
from app.models.topology import TopologyLink
from app.models.topology_snapshot import TopologySnapshot

router = APIRouter()


# ── helpers ──────────────────────────────────────────────────────────────────

def _link_key(link: dict) -> str:
    return f"{link.get('device_id')}:{link.get('local_port')}:{link.get('neighbor_hostname')}"


def _snap_out(s: TopologySnapshot) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "is_golden": s.is_golden,
        "device_count": s.device_count,
        "link_count": s.link_count,
        "created_at": s.created_at.isoformat(),
    }


async def _current_links(db: AsyncSession) -> list[dict]:
    from sqlalchemy.orm import joinedload
    rows = (await db.execute(
        select(TopologyLink, Device.hostname)
        .join(Device, Device.id == TopologyLink.device_id)
    )).all()
    return [
        {
            "device_id": r.device_id,
            "device_hostname": hostname,
            "local_port": r.local_port,
            "neighbor_hostname": r.neighbor_hostname,
            "neighbor_port": r.neighbor_port,
            "neighbor_device_id": r.neighbor_device_id,
            "neighbor_ip": r.neighbor_ip,
            "protocol": r.protocol,
            "last_seen": r.last_seen.isoformat() if r.last_seen else None,
        }
        for r, hostname in rows
    ]


# ── endpoints ─────────────────────────────────────────────────────────────────

class SnapshotCreate(BaseModel):
    name: str


@router.post("/snapshots", status_code=201)
async def create_snapshot(
    body: SnapshotCreate,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    links = await _current_links(db)
    device_ids = {lnk["device_id"] for lnk in links}
    snap = TopologySnapshot(
        name=body.name,
        is_golden=False,
        device_count=len(device_ids),
        link_count=len(links),
        links=links,
    )
    db.add(snap)
    await db.commit()
    await db.refresh(snap)
    return _snap_out(snap)


@router.get("/snapshots")
async def list_snapshots(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    rows = (await db.execute(
        select(TopologySnapshot).order_by(TopologySnapshot.created_at.desc())
    )).scalars().all()
    return {"snapshots": [_snap_out(s) for s in rows], "total": len(rows)}


@router.get("/snapshots/{snapshot_id}")
async def get_snapshot(
    snapshot_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    snap = (await db.execute(
        select(TopologySnapshot).where(TopologySnapshot.id == snapshot_id)
    )).scalar_one_or_none()
    if not snap:
        raise HTTPException(404, "Snapshot not found")
    return {**_snap_out(snap), "links": snap.links or []}


@router.delete("/snapshots/{snapshot_id}", status_code=204)
async def delete_snapshot(
    snapshot_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    snap = (await db.execute(
        select(TopologySnapshot).where(TopologySnapshot.id == snapshot_id)
    )).scalar_one_or_none()
    if not snap:
        raise HTTPException(404, "Snapshot not found")
    await db.delete(snap)
    await db.commit()


@router.post("/snapshots/{snapshot_id}/set-golden")
async def set_golden(
    snapshot_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    snap = (await db.execute(
        select(TopologySnapshot).where(TopologySnapshot.id == snapshot_id)
    )).scalar_one_or_none()
    if not snap:
        raise HTTPException(404, "Snapshot not found")

    # Clear previous golden
    prev = (await db.execute(
        select(TopologySnapshot).where(
            TopologySnapshot.is_golden == True,
            TopologySnapshot.id != snapshot_id,
        )
    )).scalars().all()
    for p in prev:
        p.is_golden = False

    snap.is_golden = True
    await db.commit()
    return _snap_out(snap)


@router.post("/snapshots/accept-current", status_code=201)
async def accept_current_as_golden(
    body: SnapshotCreate,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Mevcut topolojiyi yeni anlık görüntü olarak kaydedip golden baseline yapar."""
    # Clear old golden
    prev = (await db.execute(
        select(TopologySnapshot).where(TopologySnapshot.is_golden == True)
    )).scalars().all()
    for p in prev:
        p.is_golden = False

    links = await _current_links(db)
    device_ids = {lnk["device_id"] for lnk in links}
    snap = TopologySnapshot(
        name=body.name,
        is_golden=True,
        device_count=len(device_ids),
        link_count=len(links),
        links=links,
    )
    db.add(snap)
    await db.commit()
    await db.refresh(snap)
    return _snap_out(snap)


@router.get("/diff")
async def get_diff(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """
    Altın baseline vs mevcut topoloji karşılaştırması.
    added   — yeni eklenen bağlantılar (beklenmeyen)
    removed — kayıp bağlantılar (beklenen ama yok)
    unchanged — her ikisinde de mevcut
    """
    golden = (await db.execute(
        select(TopologySnapshot).where(TopologySnapshot.is_golden == True)
    )).scalar_one_or_none()

    if not golden:
        return {
            "has_golden": False,
            "drift_detected": False,
            "added": [],
            "removed": [],
            "unchanged": [],
            "golden": None,
        }

    golden_links = {_link_key(lnk): lnk for lnk in (golden.links or [])}
    current_raw = await _current_links(db)
    current_links = {_link_key(lnk): lnk for lnk in current_raw}

    golden_keys = set(golden_links)
    current_keys = set(current_links)

    added = [current_links[k] for k in (current_keys - golden_keys)]
    removed = [golden_links[k] for k in (golden_keys - current_keys)]
    unchanged = [current_links[k] for k in (current_keys & golden_keys)]

    return {
        "has_golden": True,
        "drift_detected": bool(added or removed),
        "added_count": len(added),
        "removed_count": len(removed),
        "unchanged_count": len(unchanged),
        "added": added,
        "removed": removed,
        "unchanged": unchanged,
        "golden": _snap_out(golden),
    }
