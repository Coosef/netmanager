import client from './client'

export type ProbeType = 'icmp' | 'tcp' | 'http' | 'dns'

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
}

export interface ProbeResult {
  id: number
  probe_id: number
  success: boolean
  latency_ms: number | null
  detail: string | null
  measured_at: string
}

export type ProbeCreatePayload = Omit<SyntheticProbe, 'id' | 'created_at'>
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

  runNow: (id: number) =>
    client.post<ProbeResult>(`/synthetic-probes/${id}/run`).then((r) => r.data),
}
