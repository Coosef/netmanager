"""
Incident RCA API — Faz 4D

Read-only. Lifecycle (state transitions) is managed by correlation_engine only.

Endpoints:
  GET /incidents            — paginated list with filters
  GET /incidents/{id}       — full RCA detail (timeline, sources, topology, suppression)
  GET /incidents/{id}/rca   — alias for /{id} (explicit RCA entry point)
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, desc, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.incident import Incident, IncidentState
from app.models.network_event import NetworkEvent
from app.models.device import Device
from app.models.topology import TopologyLink

router = APIRouter()


# ── Response schemas ──────────────────────────────────────────────────────────

class IncidentSummary(BaseModel):
    id: int
    fingerprint: str
    device_id: Optional[int]
    device_hostname: Optional[str]
    device_ip: Optional[str]
    event_type: str
    component: Optional[str]
    severity: str
    state: str
    opened_at: Optional[datetime]
    closed_at: Optional[datetime]
    duration_secs: Optional[int]
    source_count: int
    suppressed_by: Optional[int]

    model_config = {"from_attributes": True}


class IncidentListResponse(BaseModel):
    items: list[IncidentSummary]
    total: int
    offset: int
    limit: int


class SourceEntry(BaseModel):
    source: str
    confidence: float
    ts: str


class TimelineEntry(BaseModel):
    ts: str
    state: str
    reason: str


class RelatedEvent(BaseModel):
    id: int
    event_type: str
    severity: str
    title: str
    message: Optional[str]
    created_at: datetime
    acknowledged: bool


class SyntheticCorrelation(BaseModel):
    probe_id: int
    probe_name: str
    probe_type: str
    success: bool
    latency_ms: Optional[float]
    measured_at: datetime


class TopologyNeighbor(BaseModel):
    device_id: Optional[int]
    hostname: str
    local_port: str
    neighbor_port: str
    neighbor_type: Optional[str]
    active_incident: Optional[dict]   # brief incident info or None


class IncidentRCAResponse(BaseModel):
    id: int
    fingerprint: str
    device_id: Optional[int]
    device_hostname: Optional[str]
    device_ip: Optional[str]
    event_type: str
    component: Optional[str]
    severity: str
    state: str
    opened_at: Optional[datetime]
    degraded_at: Optional[datetime]
    recovering_at: Optional[datetime]
    closed_at: Optional[datetime]
    duration_secs: Optional[int]
    suppressed_by: Optional[int]

    # RCA data
    timeline: list[TimelineEntry]
    sources: list[SourceEntry]
    source_summary: dict              # {"snmp_trap": 2, "synthetic": 1, ...}
    related_events: list[RelatedEvent]
    synthetic_correlations: list[SyntheticCorrelation]
    topology_neighbors: list[TopologyNeighbor]
    suppressed_by_detail: Optional[dict]   # brief info on parent incident
    suppressed_children: list[dict]        # incidents suppressed by this one

    model_config = {"from_attributes": True}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _duration(inc: Incident) -> Optional[int]:
    if not inc.opened_at:
        return None
    end = inc.closed_at or datetime.now(timezone.utc)
    return int((end - inc.opened_at).total_seconds())


def _sources(inc: Incident) -> list[dict]:
    return inc.sources if isinstance(inc.sources, list) else []


def _timeline(inc: Incident) -> list[dict]:
    return inc.timeline if isinstance(inc.timeline, list) else []


def _source_summary(sources: list[dict]) -> dict:
    out: dict[str, int] = {}
    for s in sources:
        src = s.get("source", "unknown")
        out[src] = out.get(src, 0) + 1
    return out


async def _device_info(device_id: Optional[int], db: AsyncSession) -> tuple[Optional[str], Optional[str]]:
    if not device_id:
        return None, None
    dev = await db.get(Device, device_id)
    if not dev:
        return None, None
    return getattr(dev, "hostname", None), getattr(dev, "ip_address", None)


def _incident_to_summary(inc: Incident, hostname: Optional[str], ip: Optional[str]) -> IncidentSummary:
    srcs = _sources(inc)
    return IncidentSummary(
        id=inc.id, fingerprint=inc.fingerprint,
        device_id=inc.device_id, device_hostname=hostname, device_ip=ip,
        event_type=inc.event_type, component=inc.component,
        severity=inc.severity, state=inc.state,
        opened_at=inc.opened_at, closed_at=inc.closed_at,
        duration_secs=_duration(inc),
        source_count=len(srcs),
        suppressed_by=inc.suppressed_by,
    )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=IncidentListResponse)
async def list_incidents(
    state: Optional[str] = Query(default=None),
    severity: Optional[str] = Query(default=None),
    device_id: Optional[int] = Query(default=None),
    hours: int = Query(default=168, ge=1, le=8760),   # default 7 days, max 1 year
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    q = select(Incident).where(Incident.opened_at >= since)

    if state:
        q = q.where(Incident.state == state.upper())
    if severity:
        q = q.where(Incident.severity == severity.lower())
    if device_id:
        q = q.where(Incident.device_id == device_id)

    total_q = select(func.count()).select_from(q.subquery())
    total = (await db.execute(total_q)).scalar_one()

    rows = (await db.execute(
        q.order_by(desc(Incident.opened_at)).offset(offset).limit(limit)
    )).scalars().all()

    # Batch fetch device info
    dev_ids = {r.device_id for r in rows if r.device_id}
    devices: dict[int, Device] = {}
    if dev_ids:
        devs = (await db.execute(
            select(Device).where(Device.id.in_(dev_ids))
        )).scalars().all()
        devices = {d.id: d for d in devs}

    items = []
    for inc in rows:
        dev = devices.get(inc.device_id) if inc.device_id else None
        items.append(_incident_to_summary(
            inc,
            getattr(dev, "hostname", None) if dev else None,
            getattr(dev, "ip_address", None) if dev else None,
        ))

    return IncidentListResponse(items=items, total=total, offset=offset, limit=limit)


async def _build_rca(incident_id: int, db: AsyncSession) -> IncidentRCAResponse:
    inc = await db.get(Incident, incident_id)
    if not inc:
        raise HTTPException(status_code=404, detail="Incident not found")

    hostname, ip = await _device_info(inc.device_id, db)
    srcs = _sources(inc)
    tl = _timeline(inc)
    dur = _duration(inc)

    # ── Related NetworkEvents (device window) ─────────────────────────────────
    related_events: list[RelatedEvent] = []
    if inc.device_id and inc.opened_at:
        window_end = inc.closed_at or datetime.now(timezone.utc)
        evt_rows = (await db.execute(
            select(NetworkEvent)
            .where(
                NetworkEvent.device_id == inc.device_id,
                NetworkEvent.created_at >= inc.opened_at,
                NetworkEvent.created_at <= window_end,
            )
            .order_by(NetworkEvent.created_at.asc())
            .limit(20)
        )).scalars().all()
        for e in evt_rows:
            related_events.append(RelatedEvent(
                id=e.id, event_type=e.event_type, severity=e.severity,
                title=e.title, message=e.message,
                created_at=e.created_at, acknowledged=e.acknowledged,
            ))

    # ── Synthetic probe correlations ──────────────────────────────────────────
    synthetic_correlations: list[SyntheticCorrelation] = []
    if inc.device_id and inc.opened_at:
        from app.models.synthetic_probe import SyntheticProbe, SyntheticProbeResult
        window_end = inc.closed_at or datetime.now(timezone.utc)
        sp_rows = (await db.execute(
            select(
                SyntheticProbeResult.probe_id,
                SyntheticProbeResult.success,
                SyntheticProbeResult.latency_ms,
                SyntheticProbeResult.measured_at,
                SyntheticProbe.name.label("probe_name"),
                SyntheticProbe.probe_type,
            )
            .join(SyntheticProbe, SyntheticProbe.id == SyntheticProbeResult.probe_id)
            .where(
                SyntheticProbe.device_id == inc.device_id,
                SyntheticProbeResult.measured_at >= inc.opened_at,
                SyntheticProbeResult.measured_at <= window_end,
            )
            .order_by(SyntheticProbeResult.measured_at.asc())
            .limit(20)
        )).all()
        for r in sp_rows:
            synthetic_correlations.append(SyntheticCorrelation(
                probe_id=r.probe_id, probe_name=r.probe_name, probe_type=r.probe_type,
                success=r.success, latency_ms=r.latency_ms, measured_at=r.measured_at,
            ))

    # ── Topology neighbors ────────────────────────────────────────────────────
    topology_neighbors: list[TopologyNeighbor] = []
    if inc.device_id:
        link_rows = (await db.execute(
            select(TopologyLink)
            .where(TopologyLink.device_id == inc.device_id)
            .limit(20)
        )).scalars().all()

        neighbor_dev_ids = {r.neighbor_device_id for r in link_rows if r.neighbor_device_id}
        neighbor_devs: dict[int, Device] = {}
        if neighbor_dev_ids:
            ndevs = (await db.execute(
                select(Device).where(Device.id.in_(neighbor_dev_ids))
            )).scalars().all()
            neighbor_devs = {d.id: d for d in ndevs}

        # Active incidents on neighbors
        active_inc_map: dict[int, dict] = {}
        if neighbor_dev_ids:
            active_incs = (await db.execute(
                select(Incident)
                .where(
                    Incident.device_id.in_(neighbor_dev_ids),
                    Incident.state.not_in([IncidentState.CLOSED, IncidentState.SUPPRESSED]),
                )
            )).scalars().all()
            for ai in active_incs:
                if ai.device_id and ai.device_id not in active_inc_map:
                    active_inc_map[ai.device_id] = {
                        "id": ai.id, "state": ai.state,
                        "severity": ai.severity, "event_type": ai.event_type,
                    }

        for link in link_rows:
            dev = neighbor_devs.get(link.neighbor_device_id) if link.neighbor_device_id else None
            topology_neighbors.append(TopologyNeighbor(
                device_id=link.neighbor_device_id,
                hostname=dev.hostname if dev else (link.neighbor_hostname or "?"),
                local_port=link.local_port,
                neighbor_port=link.neighbor_port,
                neighbor_type=link.neighbor_type,
                active_incident=active_inc_map.get(link.neighbor_device_id) if link.neighbor_device_id else None,
            ))

    # ── Suppression relationships ─────────────────────────────────────────────
    suppressed_by_detail: Optional[dict] = None
    if inc.suppressed_by:
        parent = await db.get(Incident, inc.suppressed_by)
        if parent:
            p_host, _ = await _device_info(parent.device_id, db)
            suppressed_by_detail = {
                "id": parent.id, "state": parent.state,
                "severity": parent.severity, "event_type": parent.event_type,
                "device_hostname": p_host,
            }

    suppressed_children_rows = (await db.execute(
        select(Incident).where(Incident.suppressed_by == inc.id)
    )).scalars().all()

    suppressed_children = []
    child_dev_ids = {c.device_id for c in suppressed_children_rows if c.device_id}
    child_devs: dict[int, Device] = {}
    if child_dev_ids:
        cds = (await db.execute(select(Device).where(Device.id.in_(child_dev_ids)))).scalars().all()
        child_devs = {d.id: d for d in cds}
    for c in suppressed_children_rows:
        cdev = child_devs.get(c.device_id) if c.device_id else None
        suppressed_children.append({
            "id": c.id, "state": c.state, "severity": c.severity,
            "event_type": c.event_type,
            "device_hostname": cdev.hostname if cdev else None,
            "opened_at": c.opened_at.isoformat() if c.opened_at else None,
        })

    return IncidentRCAResponse(
        id=inc.id, fingerprint=inc.fingerprint,
        device_id=inc.device_id, device_hostname=hostname, device_ip=ip,
        event_type=inc.event_type, component=inc.component,
        severity=inc.severity, state=inc.state,
        opened_at=inc.opened_at, degraded_at=inc.degraded_at,
        recovering_at=inc.recovering_at, closed_at=inc.closed_at,
        duration_secs=dur, suppressed_by=inc.suppressed_by,
        timeline=[TimelineEntry(**t) for t in tl],
        sources=[SourceEntry(**s) for s in srcs],
        source_summary=_source_summary(srcs),
        related_events=related_events,
        synthetic_correlations=synthetic_correlations,
        topology_neighbors=topology_neighbors,
        suppressed_by_detail=suppressed_by_detail,
        suppressed_children=suppressed_children,
    )


@router.get("/{incident_id}", response_model=IncidentRCAResponse)
async def get_incident_rca(
    incident_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    return await _build_rca(incident_id, db)


@router.get("/{incident_id}/rca", response_model=IncidentRCAResponse)
async def get_incident_rca_alias(
    incident_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Alias for /{id} — explicit RCA entry point."""
    return await _build_rca(incident_id, db)
