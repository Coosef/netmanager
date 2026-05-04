import client from './client'

export interface RiskBreakdown {
  compliance: { score: number | null; risk_contribution: number; weight: string }
  uptime_7d: { uptime_pct: number; risk_contribution: number; weight: string }
  flapping_7d: { flap_count: number; risk_contribution: number; weight: string }
  backup: { last_backup: string | null; risk_contribution: number; weight: string }
}

export interface DeviceRiskScore {
  device_id: number
  hostname: string
  risk_score: number
  level: 'low' | 'medium' | 'high' | 'critical'
  breakdown: RiskBreakdown
}

export interface FleetRiskSummary {
  summary: {
    total_devices: number
    avg_risk_score: number
    critical: number
    high: number
    medium: number
    low: number
  }
  top_risky: DeviceRiskScore[]
}

export interface MttrMtbf {
  device_id: number
  hostname: string
  window_days: number
  failure_count: number
  mttr_seconds: number | null
  mttr_human: string | null
  mtbf_seconds: number | null
  mtbf_human: string | null
  currently_offline: boolean
}

export type TimelineItemType = 'event' | 'backup' | 'audit'
export type TimelineSeverity = 'critical' | 'warning' | 'info' | 'success'

export interface TimelineItem {
  id: string
  type: TimelineItemType
  ts: string
  severity: TimelineSeverity
  event_type: string
  title: string
  message?: string | null
  correlated_backup?: boolean
  correlation_hint?: string
}

export interface DeviceTimeline {
  device_id: number
  hostname: string
  items: TimelineItem[]
  total: number
}

export interface RootCauseIncident {
  id: number
  ts: string
  root_device_id: number
  root_hostname: string
  affected_count: number
  affected_devices: { id: number; hostname: string }[]
  suppressed_alerts: number
  title: string
  message: string | null
  acknowledged: boolean
}

export interface RootCauseReport {
  window_hours: number
  total: number
  incidents: RootCauseIncident[]
}

export const intelligenceApi = {
  getDeviceRisk: (deviceId: number) =>
    client.get<DeviceRiskScore>(`/intelligence/devices/${deviceId}/risk-score`).then(r => r.data),

  getFleetRisk: (limit = 20) =>
    client.get<FleetRiskSummary>('/intelligence/fleet/risk', { params: { limit } }).then(r => r.data),

  getMttrMtbf: (deviceId: number, windowDays = 30) =>
    client.get<MttrMtbf>(`/intelligence/devices/${deviceId}/mttr-mtbf`, {
      params: { window_days: windowDays },
    }).then(r => r.data),

  getTimeline: (deviceId: number, days = 30) =>
    client.get<DeviceTimeline>(`/intelligence/devices/${deviceId}/timeline`, {
      params: { days },
    }).then(r => r.data),

  getRootCauseIncidents: (hours = 24, limit = 20) =>
    client.get<RootCauseReport>('/intelligence/root-cause-incidents', {
      params: { hours, limit },
    }).then(r => r.data),
}
