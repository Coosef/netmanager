"""
Synthetic Probe API — Faz 3B / Faz 4C

CRUD for probe definitions + result history + on-demand run + SLA status.

SLA design:
  - Threshold fields (sla_success_rate_pct, sla_latency_ms, etc.) stored on probe.
  - SLA compliance computed on read from the last sla_window_hours of results.
  - A single failure never constitutes a breach — evaluation is window-based.
  - sla_enabled=False → sla_status=null in response (opt-out per probe).
"""

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.synthetic_probe import SyntheticProbe, SyntheticProbeResult
from app.services.sla_evaluator import compute_sla_status

router = APIRouter()


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class ProbeCreate(BaseModel):
    name: str
    device_id: Optional[int] = None
    agent_id: Optional[str] = None
    probe_type: str                         # icmp | tcp | http | dns
    target: str
    port: Optional[int] = None
    http_method: str = "GET"
    expected_status: Optional[int] = None
    dns_record_type: str = "A"
    interval_secs: int = 300
    timeout_secs: int = 5
    enabled: bool = True
    # SLA thresholds
    sla_enabled: bool = True
    sla_success_rate_pct: float = Field(default=99.0, ge=0.0, le=100.0)
    sla_latency_ms: Optional[float] = Field(default=None, ge=1.0)
    sla_window_hours: int = Field(default=24, ge=1, le=168)

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
    # SLA thresholds
    sla_enabled: Optional[bool] = None
    sla_success_rate_pct: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    sla_latency_ms: Optional[float] = Field(default=None, ge=1.0)
    sla_window_hours: Optional[int] = Field(default=None, ge=1, le=168)


class SLAStatusResponse(BaseModel):
    compliant: bool
    success_rate_pct: Optional[float]
    avg_latency_ms: Optional[float]
    breach_reason: Optional[str]        # "success_rate" | "latency" | None
    window_hours: int
    sample_count: int
    insufficient_data: bool

    model_config = {"from_attributes": True}


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
    # SLA thresholds
    sla_enabled: bool
    sla_success_rate_pct: float
    sla_latency_ms: Optional[float]
    sla_window_hours: int
    # Computed SLA status (None when sla_enabled=False)
    sla_status: Optional[SLAStatusResponse] = None

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


async def _batch_sla_statuses(
    probes: list[SyntheticProbe],
    db: AsyncSession,
) -> dict[int, Optional[SLAStatusResponse]]:
    """
    Compute SLA status for all probes in a single batched DB query.
    TimescaleDB chunk pruning makes the time-range filter very fast.
    """
    if not probes:
        return {}

    now = datetime.now(timezone.utc)
    max_window = max(p.sla_window_hours for p in probes)
    cutoff = now - timedelta(hours=max_window)

    rows = (await db.execute(
        select(
            SyntheticProbeResult.probe_id,
            SyntheticProbeResult.success,
            SyntheticProbeResult.latency_ms,
            SyntheticProbeResult.measured_at,
        )
        .where(
            SyntheticProbeResult.probe_id.in_([p.id for p in probes]),
            SyntheticProbeResult.measured_at >= cutoff,
        )
    )).all()

    # Group by probe_id
    by_probe: dict[int, list] = defaultdict(list)
    for row in rows:
        by_probe[row.probe_id].append(row)

    result: dict[int, Optional[SLAStatusResponse]] = {}
    for probe in probes:
        if not probe.sla_enabled:
            result[probe.id] = None
            continue
        # Filter to this probe's specific window
        probe_cutoff = now - timedelta(hours=probe.sla_window_hours)
        window_rows = [r for r in by_probe[probe.id] if r.measured_at >= probe_cutoff]
        status = compute_sla_status(
            window_rows,
            probe.sla_success_rate_pct,
            probe.sla_latency_ms,
            probe.sla_window_hours,
        )
        result[probe.id] = SLAStatusResponse(
            compliant=status.compliant,
            success_rate_pct=status.success_rate_pct,
            avg_latency_ms=status.avg_latency_ms,
            breach_reason=status.breach_reason,
            window_hours=status.window_hours,
            sample_count=status.sample_count,
            insufficient_data=status.insufficient_data,
        )
    return result


def _probe_to_response(probe: SyntheticProbe, sla: Optional[SLAStatusResponse]) -> ProbeResponse:
    return ProbeResponse(
        id=probe.id, name=probe.name, device_id=probe.device_id,
        agent_id=probe.agent_id, probe_type=probe.probe_type, target=probe.target,
        port=probe.port, http_method=probe.http_method, expected_status=probe.expected_status,
        dns_record_type=probe.dns_record_type, interval_secs=probe.interval_secs,
        timeout_secs=probe.timeout_secs, enabled=probe.enabled, created_at=probe.created_at,
        sla_enabled=probe.sla_enabled, sla_success_rate_pct=probe.sla_success_rate_pct,
        sla_latency_ms=probe.sla_latency_ms, sla_window_hours=probe.sla_window_hours,
        sla_status=sla,
    )


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
    probes = (await db.execute(q)).scalars().all()
    sla_map = await _batch_sla_statuses(list(probes), db)
    return [_probe_to_response(p, sla_map.get(p.id)) for p in probes]


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
    # No results yet — sla_status will be insufficient_data
    sla_map = await _batch_sla_statuses([probe], db)
    return _probe_to_response(probe, sla_map.get(probe.id))


@router.get("/{probe_id}", response_model=ProbeResponse)
async def get_probe(
    probe_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    probe = await _get_probe_or_404(probe_id, db)
    sla_map = await _batch_sla_statuses([probe], db)
    return _probe_to_response(probe, sla_map.get(probe.id))


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
    sla_map = await _batch_sla_statuses([probe], db)
    return _probe_to_response(probe, sla_map.get(probe.id))


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


@router.get("/{probe_id}/sla", response_model=SLAStatusResponse)
async def get_probe_sla(
    probe_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Detailed SLA compliance status for a single probe."""
    probe = await _get_probe_or_404(probe_id, db)
    if not probe.sla_enabled:
        raise HTTPException(status_code=409, detail="SLA tracking is disabled for this probe")
    sla_map = await _batch_sla_statuses([probe], db)
    status = sla_map.get(probe.id)
    if status is None:
        raise HTTPException(status_code=409, detail="SLA tracking is disabled for this probe")
    return status


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
