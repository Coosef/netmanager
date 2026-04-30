import client from './client'

export type DiagType = 'ping' | 'traceroute' | 'dns' | 'port_check' | 'snmp_get'
export type DiagSource = 'server' | 'device'

export interface DiagRequest {
  type: DiagType
  target: string
  source: DiagSource
  device_id?: number
  count?: number
  port?: number
  timeout?: number
  snmp_community?: string
  snmp_version?: 'v1' | 'v2c'
  snmp_oid?: string
  snmp_port?: number
}

export interface DiagResult {
  type: DiagType
  target: string
  source: DiagSource
  source_label: string
  success: boolean
  output: string
  extra: {
    packet_loss_pct?: number
    rtt_avg_ms?: number
    resolved_ips?: string[]
    reverse_hostname?: string | null
    snmp_oid?: string
    snmp_value?: string
    snmp_type?: string
  }
  duration_ms: number
  ran_at: string
}

export const diagnosticsApi = {
  run: (req: DiagRequest) =>
    client.post<DiagResult>('/diagnostics/run', req).then((r) => r.data),
}
