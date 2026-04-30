import client from './client'

export interface TopProblematic {
  device_id: number
  hostname: string
  event_count: number
  critical_count: number
}

export interface FlappingDevice {
  device_id: number
  hostname: string
  flap_count: number
}

export interface BackupCompliance {
  ok: number
  stale: number
  never: number
  total: number
  never_list: { id: number; hostname: string; ip: string }[]
}

export interface AgentHealth {
  id: string
  name: string
  status: string
  last_heartbeat: string | null
  heartbeat_age_s: number | null
  platform: string | null
  machine_hostname: string | null
  assigned_devices: number
  warning: boolean
}

export interface FirmwareGroup {
  firmware: string
  vendor: string
  count: number
  hostnames: string[]
}

export interface RiskEntry {
  score: number
  total: number
  offline: number
  no_backup: number
}

export interface ConfigDrift {
  total_with_golden: number
  drift_count: number
  clean_count: number
  drift_devices: { device_id: number; hostname: string; latest_backup_at: string }[]
}

export interface DashboardAnalytics {
  generated_at: string
  total_devices: number
  top_problematic: TopProblematic[]
  flapping_devices: FlappingDevice[]
  backup_compliance: BackupCompliance
  never_seen: { id: number; hostname: string; ip: string; last_seen: string | null }[]
  firmware_posture: FirmwareGroup[]
  agent_health: AgentHealth[]
  change_summary: {
    action_counts: Record<string, number>
    recent: { action: string; username: string; resource_name: string | null; created_at: string }[]
  }
  risk: {
    by_vendor: (RiskEntry & { vendor: string })[]
    by_location: (RiskEntry & { location: string })[]
  }
  config_drift: ConfigDrift
}

export interface SnmpTopInterface {
  device_id: number
  hostname: string
  if_index: number
  if_name: string | null
  in_pct: number
  out_pct: number
  max_pct: number
}

export interface SnmpDashboardSummary {
  snmp_enabled: number
  total_devices: number
  last_poll_at: string | null
  critical_interfaces: number
  warning_interfaces: number
  total_interfaces: number
  total_in_bytes_24h: number
  total_out_bytes_24h: number
  top_interfaces: SnmpTopInterface[]
}

export interface SnmpChartPoint {
  hour: string
  avg_in: number
  avg_out: number
  device_count: number
}

export interface SparklinePoint { hour: string; count: number }

export const dashboardApi = {
  getAnalytics: (params?: { site?: string }) =>
    client.get<DashboardAnalytics>('/dashboard/analytics', { params }).then((r) => r.data),

  getSnmpSummary: () =>
    client.get<SnmpDashboardSummary>('/dashboard/snmp-summary').then((r) => r.data),

  getSnmpChart: () =>
    client.get<{ points: SnmpChartPoint[] }>('/dashboard/snmp-chart').then((r) => r.data),

  getSparklines: () =>
    client.get<{ events_24h: SparklinePoint[] }>('/dashboard/sparklines').then((r) => r.data),
}
