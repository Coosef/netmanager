import client from './client'

export interface SnmpHealth {
  sys_descr: string | null
  sys_name: string | null
  sys_location: string | null
  uptime_sec: number | null
  uptime_human: string | null
}

export interface SnmpInterface {
  if_index: number | string
  name: string
  alias: string
  admin_up: boolean
  oper_up: boolean
  speed_mbps: number | null
  in_octets: number | null
  out_octets: number | null
  in_errors: number | null
  out_errors: number | null
}

export interface SnmpInterfacesResponse {
  device_id: number
  hostname: string
  total: number
  interfaces: SnmpInterface[]
}

export interface SnmpCpuRam {
  cpu_pct: number | null
  ram_used_mb: number | null
  ram_total_mb: number | null
  ram_pct: number | null
  source: string | null
}

export interface UtilizationPoint {
  ts: string
  in_pct: number | null
  out_pct: number | null
}

export interface SnmpStatus {
  total_devices: number
  snmp_enabled: number
  poll_results: number
  last_poll_at: string | null
}

export interface BulkSshDeviceResult {
  device_id: number
  hostname: string
  ip: string
  success: boolean
  error?: string
}

export interface BulkSshResult {
  attempted: number
  succeeded: number
  failed: number
  results: BulkSshDeviceResult[]
}

export const snmpApi = {
  getHealth: (deviceId: number) =>
    client.get<SnmpHealth>(`/snmp/${deviceId}/health`).then((r) => r.data),

  getInterfaces: (deviceId: number) =>
    client.get<SnmpInterfacesResponse>(`/snmp/${deviceId}/interfaces`).then((r) => r.data),

  getCpuRam: (deviceId: number) =>
    client.get<SnmpCpuRam & { device_id: number }>(`/snmp/${deviceId}/cpu-ram`).then((r) => r.data),

  getUtilizationHistory: (deviceId: number, ifIndex: number | string, limit = 48) =>
    client
      .get<{ device_id: number; if_index: number; history: UtilizationPoint[] }>(
        `/snmp/${deviceId}/utilization-history`,
        { params: { if_index: ifIndex, limit } },
      )
      .then((r) => r.data),

  getTopInterfaces: (params?: { limit?: number; threshold?: number; site?: string }) =>
    client
      .get<{ items: TopInterface[]; total: number }>('/snmp/top-interfaces', { params })
      .then((r) => r.data),

  getErrorInterfaces: (params?: { limit?: number; min_errors?: number; site?: string }) =>
    client
      .get<{ items: ErrorInterface[]; total: number }>('/snmp/error-interfaces', { params })
      .then((r) => r.data),

  getErrorHistory: (deviceId: number, ifIndex: number | string, limit = 24) =>
    client
      .get<{ device_id: number; if_index: number; history: ErrorHistoryPoint[] }>(
        `/snmp/${deviceId}/error-history`,
        { params: { if_index: ifIndex, limit } },
      )
      .then((r) => r.data),

  getStatus: () =>
    client.get<SnmpStatus>('/snmp/status').then((r) => r.data),

  triggerPoll: () =>
    client.post<{ task_id: string; status: string }>('/snmp/trigger-poll').then((r) => r.data),

  bulkConfigure: (payload: { community: string; version?: string; port?: number; device_ids?: number[] }) =>
    client.post<{ updated: number }>('/snmp/bulk-configure', payload).then((r) => r.data),

  bulkSshConfigure: (payload: { community: string; version?: string; port?: number; device_ids?: number[] }) =>
    client.post<BulkSshResult>('/snmp/bulk-ssh-configure', payload).then((r) => r.data),

  getTrafficRates: (params?: { limit?: number; min_mbps?: number; site?: string }) =>
    client
      .get<{ items: TrafficRate[]; total: number }>('/snmp/traffic-rates', { params })
      .then((r) => r.data),
}

export interface TopInterface {
  device_id: number
  hostname: string
  ip_address: string
  if_index: number
  if_name: string | null
  speed_mbps: number | null
  in_pct: number
  out_pct: number
  max_pct: number
  in_bytes_total: number
  out_bytes_total: number
  monitoring_hours: number
  polled_at: string
}

export interface ErrorInterface {
  device_id: number
  hostname: string
  ip_address: string
  if_index: number
  if_name: string | null
  in_err_delta: number
  out_err_delta: number
  total_err_delta: number
  errors_per_min: number
  in_errors_total: number
  out_errors_total: number
  polled_at: string
}

export interface ErrorHistoryPoint {
  ts: string
  in_errors: number | null
  out_errors: number | null
  in_err_delta: number | null
  out_err_delta: number | null
}

export interface TrafficRate {
  device_id: number
  hostname: string
  ip_address: string
  if_index: number
  if_name: string | null
  speed_mbps: number | null
  in_mbps: number
  out_mbps: number
  peak_mbps: number
  util_pct: number | null
  elapsed_secs: number
  polled_at: string
}
