import client from './client'

export interface SlaPolicy {
  id: number
  name: string
  target_uptime_pct: number
  measurement_window_days: number
  device_ids: number[]
  group_ids: number[]
  notify_on_breach: boolean
  created_at: string
}

export interface SlaPolicyCreate {
  name: string
  target_uptime_pct: number
  measurement_window_days: number
  device_ids: number[]
  group_ids: number[]
  notify_on_breach: boolean
}

export interface UptimeDevice {
  device_id: number
  hostname: string
  ip: string
  vendor: string | null
  location: string | null
  uptime_pct: number
  downtime_minutes: number
}

export interface UptimeReport {
  window_days: number
  generated_at: string
  devices: UptimeDevice[]
}

export interface SlaBreachEntry {
  device_id: number
  hostname: string
  uptime_pct: number
  target_pct: number
  breach: boolean
}

export interface SlaComplianceResult {
  policy_id: number
  policy_name: string
  target_uptime_pct: number
  window_days: number
  total_devices: number
  compliant_count: number
  breach_count: number
  compliance_pct: number
  breaches: SlaBreachEntry[]
}

export interface FleetSummary {
  window_days: number
  total: number
  above_99: number
  above_95: number
  below_95: number
  avg_uptime_pct: number
  worst_devices: { hostname: string; device_id: number; uptime_pct: number }[]
}

export interface DeviceUptimeDetail {
  device_id: number
  hostname: string
  window_days: number
  overall_uptime_pct: number
  downtime_minutes: number
  daily: { date: string; uptime_pct: number }[]
}

export const slaApi = {
  listPolicies: () =>
    client.get<SlaPolicy[]>('/sla/policies').then((r) => r.data),

  createPolicy: (data: SlaPolicyCreate) =>
    client.post<SlaPolicy>('/sla/policies', data).then((r) => r.data),

  updatePolicy: (id: number, data: SlaPolicyCreate) =>
    client.put<SlaPolicy>(`/sla/policies/${id}`, data).then((r) => r.data),

  deletePolicy: (id: number) =>
    client.delete(`/sla/policies/${id}`).then((r) => r.data),

  getReport: (windowDays = 30, deviceIds?: number[], site?: string) =>
    client
      .get<UptimeReport>('/sla/report', {
        params: {
          window_days: windowDays,
          ...(deviceIds?.length ? { device_ids: deviceIds.join(',') } : {}),
          ...(site ? { site } : {}),
        },
      })
      .then((r) => r.data),

  getCompliance: () =>
    client.get<SlaComplianceResult[]>('/sla/compliance').then((r) => r.data),

  getFleetSummary: (windowDays = 30, site?: string) =>
    client
      .get<FleetSummary>('/sla/fleet-summary', { params: { window_days: windowDays, ...(site ? { site } : {}) } })
      .then((r) => r.data),

  getDeviceUptime: (deviceId: number, windowDays = 30) =>
    client
      .get<DeviceUptimeDetail>(`/sla/device/${deviceId}`, { params: { window_days: windowDays } })
      .then((r) => r.data),
}
