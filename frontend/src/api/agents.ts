import client from './client'

export interface Agent {
  id: string
  name: string
  status: 'online' | 'offline'
  last_heartbeat: string | null
  last_ip: string | null
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
}

export interface AgentLiveData {
  online: boolean
  connected_at?: string
  last_heartbeat?: string
  metrics: AgentMetrics
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
}
