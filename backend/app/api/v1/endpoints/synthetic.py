"""
Synthetic Probe API — Faz 3B

CRUD for probe definitions + result history + on-demand run.
"""

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.synthetic_probe import SyntheticProbe, SyntheticProbeResult

router = APIRouter()


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class ProbeCreate(BaseModel):
    name: str
    device_id: Optional[int] = None
    agent_id: Optional[str] = None
    probe_type: str                        # icmp | tcp | http | dns
    target: str
    port: Optional[int] = None
    http_method: str = "GET"
    expected_status: Optional[int] = None
    dns_record_type: str = "A"
    interval_secs: int = 300
    timeout_secs: int = 5
    enabled: bool = True

    model_config = {"from_attributes": True}


class ProbeUpdate(BaseModel):
    name: Optional[str] = None
    device_id: Optional[int] = None
    agent_id: Optional[str] = None
    probe_type: Optional[str] = None
    target: Optional[str] = None
    port: Optional[int] = None
    http_method: Optional[str] = None
    expected_status: Optional[int] = None
    dns_record_type: Optional[str] = None
    interval_secs: Optional[int] = None
    timeout_secs: Optional[int] = None
    enabled: Optional[bool] = None


class ProbeResponse(BaseModel):
    id: int
    name: str
    device_id: Optional[int]
    agent_id: Optional[str]
    probe_type: str
    target: str
    port: Optional[int]
    http_method: str
    expected_status: Optional[int]
    dns_record_type: str
    interval_secs: int
    timeout_secs: int
    enabled: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class ProbeResultResponse(BaseModel):
    id: int
    probe_id: int
    success: bool
    latency_ms: Optional[float]
    detail: Optional[str]
    measured_at: datetime

    model_config = {"from_attributes": True}


# ── Helpers ───────────────────────────────────────────────────────────────────

_VALID_PROBE_TYPES = {"icmp", "tcp", "http", "dns"}


def _validate_probe_type(probe_type: str):
    if probe_type not in _VALID_PROBE_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"probe_type must be one of: {', '.join(sorted(_VALID_PROBE_TYPES))}",
        )


async def _get_probe_or_404(probe_id: int, db: AsyncSession) -> SyntheticProbe:
    probe = await db.get(SyntheticProbe, probe_id)
    if not probe:
        raise HTTPException(status_code=404, detail="Probe not found")
    return probe


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=list[ProbeResponse])
async def list_probes(
    device_id: Optional[int] = Query(default=None),
    probe_type: Optional[str] = Query(default=None),
    enabled: Optional[bool] = Query(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    q = select(SyntheticProbe).order_by(SyntheticProbe.id)
    if device_id is not None:
        q = q.where(SyntheticProbe.device_id == device_id)
    if probe_type is not None:
        q = q.where(SyntheticProbe.probe_type == probe_type)
    if enabled is not None:
        q = q.where(SyntheticProbe.enabled == enabled)
    return (await db.execute(q)).scalars().all()


@router.post("", response_model=ProbeResponse, status_code=201)
async def create_probe(
    body: ProbeCreate,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    _validate_probe_type(body.probe_type)
    probe = SyntheticProbe(**body.model_dump())
    db.add(probe)
    await db.commit()
    await db.refresh(probe)
    return probe


@router.get("/{probe_id}", response_model=ProbeResponse)
async def get_probe(
    probe_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    return await _get_probe_or_404(probe_id, db)


@router.put("/{probe_id}", response_model=ProbeResponse)
async def update_probe(
    probe_id: int,
    body: ProbeUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    probe = await _get_probe_or_404(probe_id, db)
    updates = body.model_dump(exclude_unset=True)
    if "probe_type" in updates:
        _validate_probe_type(updates["probe_type"])
    for k, v in updates.items():
        setattr(probe, k, v)
    await db.commit()
    await db.refresh(probe)
    return probe


@router.delete("/{probe_id}", status_code=204)
async def delete_probe(
    probe_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    probe = await _get_probe_or_404(probe_id, db)
    await db.delete(probe)
    await db.commit()


@router.get("/{probe_id}/results", response_model=list[ProbeResultResponse])
async def get_probe_results(
    probe_id: int,
    limit: int = Query(default=100, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    await _get_probe_or_404(probe_id, db)
    rows = (await db.execute(
        select(SyntheticProbeResult)
        .where(SyntheticProbeResult.probe_id == probe_id)
        .order_by(desc(SyntheticProbeResult.measured_at))
        .limit(limit)
    )).scalars().all()
    return rows


@router.post("/{probe_id}/run", response_model=ProbeResultResponse)
async def run_probe_now(
    probe_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Execute the probe immediately and persist the result."""
    from app.services.agent_manager import agent_manager
    from app.workers.tasks.synthetic_tasks import _probe_kwargs

    probe = await _get_probe_or_404(probe_id, db)

    if not probe.agent_id:
        raise HTTPException(status_code=422, detail="Probe has no agent assigned")

    result = await agent_manager.execute_synthetic_probe(
        agent_id=probe.agent_id,
        probe_type=probe.probe_type,
        target=probe.target,
        timeout=probe.timeout_secs,
        **_probe_kwargs(probe),
    )

    now = datetime.now(timezone.utc)
    row = SyntheticProbeResult(
        probe_id=probe.id,
        success=result["success"],
        latency_ms=result.get("latency_ms"),
        detail=(result.get("detail") or "")[:512],
        measured_at=now,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row
