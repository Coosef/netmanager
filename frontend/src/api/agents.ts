import client from './client'

export interface Agent {
  id: string
  name: string
  status: 'online' | 'offline'
  last_heartbeat: string | null
  last_ip: string | null
  local_ip: string | null
  platform: string | null
  machine_hostname: string | null
  version: string | null
  is_active: boolean
  created_at: string
  agent_key?: string  // only present on creation

  // Security
  command_mode: 'all' | 'whitelist' | 'blacklist'
  allowed_commands: string[]
  allowed_ips: string
  failed_auth_count: number
  key_last_rotated: string | null

  // Connection stats
  last_connected_at: string | null
  last_disconnected_at: string | null
  total_connections: number
}

export interface AgentMetrics {
  cpu_percent?: number
  memory_percent?: number
  memory_used_mb?: number
  memory_total_mb?: number
  cmd_success?: number
  cmd_fail?: number
  cmd_blocked?: number
  cmd_total_ms?: number
  python_version?: string
  pool_size?: number
  pool_active_hosts?: string[]
  vault_active?: boolean
  vault_credential_count?: number
  queue_size?: number
}

export interface AgentLiveData {
  online: boolean
  connected_at?: string
  last_heartbeat?: string
  metrics: AgentMetrics
  vault_active?: boolean
  vault_credential_count?: number
}

export interface AgentLatencyEntry {
  agent_id: string
  device_id: number
  latency_ms: number | null
  success?: boolean
  measured_at?: string
}

export interface ProbeResult {
  device_id: number
  hostname: string
  latency_ms: number | null
  success: boolean
  error?: string
}

export interface ProbeResponse {
  agent_id: string
  probed: number
  results: ProbeResult[]
}

export interface AgentCommandLog {
  id: number
  agent_id: string
  device_id: number | null
  device_ip: string | null
  command_type: 'ssh_command' | 'ssh_config' | 'ssh_test'
  command: string | null
  success: boolean | null
  duration_ms: number | null
  blocked: boolean
  block_reason: string | null
  executed_at: string
}

export interface AgentCommandLogsResponse {
  items: AgentCommandLog[]
  total: number
  offset: number
  limit: number
}

export interface AgentSecurityConfig {
  command_mode: 'all' | 'whitelist' | 'blacklist'
  allowed_commands: string[]
  allowed_ips: string
}

export interface RotateKeyResponse {
  agent_id: string
  new_key: string
  agent_notified: boolean
  rotated_at: string
}

export const agentsApi = {
  list: () =>
    client.get<Agent[]>('/agents/').then((r) => r.data),

  create: (data: { name: string }) =>
    client.post<Agent & { agent_key: string }>('/agents/', data).then((r) => r.data),

  delete: (id: string) =>
    client.delete(`/agents/${id}`),

  getLiveMetrics: (id: string) =>
    client.get<AgentLiveData>(`/agents/${id}/live-metrics`).then((r) => r.data),

  restart: (id: string) =>
    client.post<{ status: string; agent_id: string }>(`/agents/${id}/restart`).then((r) => r.data),

  getCurrentVersion: () =>
    client.get<{ version: string }>('/agents/current-version').then((r) => r.data),

  triggerUpdate: (id: string) =>
    client.post<{ status: string; current_version: string }>(`/agents/${id}/update`).then((r) => r.data),

  ping: (id: string) =>
    client.post<{
      online: boolean; agent_id: string; name: string;
      heartbeat_age_secs: number | null; last_heartbeat: string | null;
      version: string | null; cpu_pct: number | null; ram_pct: number | null;
      checked_at: string;
    }>(`/agents/${id}/ping`).then((r) => r.data),

  getLatencyMap: () =>
    client.get<AgentLatencyEntry[]>('/agents/latency-map').then((r) => r.data),

  probeDevices: (id: string) =>
    client.post<ProbeResponse>(`/agents/${id}/probe-devices`).then((r) => r.data),

  // Security
  updateSecurity: (id: string, config: AgentSecurityConfig) =>
    client.put<{ status: string }>(`/agents/${id}/security`, config).then((r) => r.data),

  rotateKey: (id: string) =>
    client.post<RotateKeyResponse>(`/agents/${id}/rotate-key`).then((r) => r.data),

  unlock: (id: string) =>
    client.post<{ status: string }>(`/agents/${id}/unlock`).then((r) => r.data),

  // Command audit log
  getCommands: (id: string, params?: { limit?: number; offset?: number; blocked_only?: boolean }) =>
    client.get<AgentCommandLogsResponse>(`/agents/${id}/commands`, { params }).then((r) => r.data),

  downloadUrl: (id: string, agentKey: string, platform: 'linux' | 'windows', serverUrl?: string) => {
    const params = new URLSearchParams({ agent_key: agentKey })
    if (serverUrl) params.set('server_url', serverUrl)
    return `/api/v1/agents/${id}/download/${platform}?${params.toString()}`
  },

  deviceSync: (id: string) =>
    client.post<{sent: boolean; device_count: number}>(`/agents/${id}/device-sync`).then(r => r.data),

  discover: (id: string, body: {subnet: string; ports?: number[]}) =>
    client.post<DiscoverResult>(`/agents/${id}/discover`, body, { timeout: 180_000 }).then(r => r.data),

  getDiscoveryHistory: (id: string) =>
    client.get<DiscoveryHistoryEntry[]>(`/agents/${id}/discover/history`).then(r => r.data),

  configureSyslog: (id: string, body: {enabled: boolean; bind_port?: number}) =>
    client.post<{sent: boolean; enabled: boolean; bind_port: number}>(`/agents/${id}/syslog-config`, body).then(r => r.data),

  getSyslogEvents: (id: string, params?: {limit?: number; offset?: number; severity_max?: number}) =>
    client.get<SyslogEventsResponse>(`/agents/${id}/syslog-events`, {params}).then(r => r.data),

  startStreamCommand: (agentId: string, body: {device_id: number; command: string}) =>
    client.post<StreamCommandResponse>(`/agents/${agentId}/stream-command`, body).then(r => r.data),

  refreshVault: (id: string) =>
    client.post<VaultRefreshResponse>(`/agents/${id}/refresh-vault`).then(r => r.data),

  snmpGet: (id: string, body: { device_id: number; oids: string[] }) =>
    client.post<SnmpGetResult>(`/agents/${id}/snmp-get`, body).then(r => r.data),

  snmpWalk: (id: string, body: { device_id: number; oid_prefix: string }) =>
    client.post<SnmpWalkResult>(`/agents/${id}/snmp-walk`, body).then(r => r.data),
}

export interface DiscoverResult {
  success: boolean
  hosts: Array<{ip: string; open_ports: number[]; banner: string | null; response_time_ms: number}>
  scanned: number
}

export interface DiscoveryHistoryEntry {
  id: number
  subnet: string
  triggered_at: string
  completed_at: string | null
  status: 'running' | 'completed' | 'failed'
  total_discovered: number
  scanned_count: number
  results: DiscoverResult['hosts']
}

export interface SyslogEvent {
  id: number
  source_ip: string
  facility: number
  severity: number
  message: string
  received_at: string
}

export interface SyslogEventsResponse {
  items: SyslogEvent[]
  total: number
  offset: number
  limit: number
}

export interface StreamCommandResponse {
  request_id: string
  stream_url: string
}

export interface VaultRefreshResponse {
  sent: boolean
  credential_count: number
  encrypted: boolean
}

export interface SnmpGetResult {
  success: boolean
  results: Record<string, string | number | null>
  error?: string
}

export interface SnmpWalkResult {
  success: boolean
  results: Array<{ oid: string; value: string | number | null }>
  error?: string
}
