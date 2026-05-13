import client from './client'

export type IncidentState = 'OPEN' | 'DEGRADED' | 'RECOVERING' | 'CLOSED' | 'SUPPRESSED'
export type IncidentSeverity = 'critical' | 'warning' | 'info'

export interface IncidentSummary {
  id: number
  fingerprint: string
  device_id: number | null
  device_hostname: string | null
  device_ip: string | null
  event_type: string
  component: string | null
  severity: IncidentSeverity
  state: IncidentState
  opened_at: string | null
  closed_at: string | null
  duration_secs: number | null
  source_count: number
  suppressed_by: number | null
}

export interface IncidentListResponse {
  items: IncidentSummary[]
  total: number
  offset: number
  limit: number
}

export interface SourceEntry {
  source: string
  confidence: number
  ts: string
}

export interface TimelineEntry {
  ts: string
  state: IncidentState
  reason: string
}

export interface RelatedEvent {
  id: number
  event_type: string
  severity: string
  title: string
  message: string | null
  created_at: string
  acknowledged: boolean
}

export interface SyntheticCorrelation {
  probe_id: number
  probe_name: string
  probe_type: string
  success: boolean
  latency_ms: number | null
  measured_at: string
}

export interface TopologyNeighbor {
  device_id: number | null
  hostname: string
  local_port: string
  neighbor_port: string
  neighbor_type: string | null
  active_incident: {
    id: number
    state: string
    severity: string
    event_type: string
  } | null
}

export interface IncidentRCA {
  id: number
  fingerprint: string
  device_id: number | null
  device_hostname: string | null
  device_ip: string | null
  event_type: string
  component: string | null
  severity: IncidentSeverity
  state: IncidentState
  opened_at: string | null
  degraded_at: string | null
  recovering_at: string | null
  closed_at: string | null
  duration_secs: number | null
  suppressed_by: number | null
  // RCA data
  timeline: TimelineEntry[]
  sources: SourceEntry[]
  source_summary: Record<string, number>
  related_events: RelatedEvent[]
  synthetic_correlations: SyntheticCorrelation[]
  topology_neighbors: TopologyNeighbor[]
  suppressed_by_detail: {
    id: number
    state: string
    severity: string
    event_type: string
    device_hostname: string | null
  } | null
  suppressed_children: Array<{
    id: number
    state: string
    severity: string
    event_type: string
    device_hostname: string | null
    opened_at: string | null
  }>
}

export interface IncidentListParams {
  state?: IncidentState
  severity?: IncidentSeverity
  device_id?: number
  hours?: number
  limit?: number
  offset?: number
}

export const incidentsApi = {
  list: (params?: IncidentListParams) =>
    client.get<IncidentListResponse>('/incidents', { params }).then((r) => r.data),

  get: (id: number) =>
    client.get<IncidentRCA>(`/incidents/${id}`).then((r) => r.data),

  getRCA: (id: number) =>
    client.get<IncidentRCA>(`/incidents/${id}/rca`).then((r) => r.data),
}
