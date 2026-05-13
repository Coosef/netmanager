import client from './client'

export type ProbeType = 'icmp' | 'tcp' | 'http' | 'dns'

export interface SLAStatus {
  compliant: boolean
  success_rate_pct: number | null    // null when insufficient_data
  avg_latency_ms: number | null
  breach_reason: 'success_rate' | 'latency' | null
  window_hours: number
  sample_count: number
  insufficient_data: boolean
}

export interface SyntheticProbe {
  id: number
  name: string
  device_id: number | null
  agent_id: string | null
  probe_type: ProbeType
  target: string
  port: number | null
  http_method: string
  expected_status: number | null
  dns_record_type: string
  interval_secs: number
  timeout_secs: number
  enabled: boolean
  created_at: string
  // SLA thresholds
  sla_enabled: boolean
  sla_success_rate_pct: number
  sla_latency_ms: number | null
  sla_window_hours: number
  // Computed (null when sla_enabled=false)
  sla_status: SLAStatus | null
}

export interface ProbeResult {
  id: number
  probe_id: number
  success: boolean
  latency_ms: number | null
  detail: string | null
  measured_at: string
}

export type ProbeCreatePayload = Omit<SyntheticProbe, 'id' | 'created_at' | 'sla_status'>
export type ProbeUpdatePayload = Partial<ProbeCreatePayload>

export const syntheticApi = {
  list: (params?: { device_id?: number; probe_type?: ProbeType; enabled?: boolean }) =>
    client.get<SyntheticProbe[]>('/synthetic-probes', { params }).then((r) => r.data),

  get: (id: number) =>
    client.get<SyntheticProbe>(`/synthetic-probes/${id}`).then((r) => r.data),

  create: (data: ProbeCreatePayload) =>
    client.post<SyntheticProbe>('/synthetic-probes', data).then((r) => r.data),

  update: (id: number, data: ProbeUpdatePayload) =>
    client.put<SyntheticProbe>(`/synthetic-probes/${id}`, data).then((r) => r.data),

  delete: (id: number) => client.delete(`/synthetic-probes/${id}`),

  getResults: (id: number, limit = 20) =>
    client.get<ProbeResult[]>(`/synthetic-probes/${id}/results`, { params: { limit } }).then((r) => r.data),

  getSLA: (id: number) =>
    client.get<SLAStatus>(`/synthetic-probes/${id}/sla`).then((r) => r.data),

  runNow: (id: number) =>
    client.post<ProbeResult>(`/synthetic-probes/${id}/run`).then((r) => r.data),
}
