import client from './client'

export interface TopologyGraph {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  stats: {
    total_nodes: number
    known_nodes: number
    ghost_nodes: number
    total_edges: number
  }
}

export interface TopologyNode {
  id: string
  type: 'deviceNode' | 'ghostNode'
  position: { x: number; y: number }
  data: {
    label: string
    ip?: string
    vendor?: string
    os_type?: string
    status?: string
    model?: string
    group_id?: number
    device_id?: number
    ghost?: boolean
    platform?: string
    layer?: string
    last_discovery?: string
  }
}

export interface TopologyEdge {
  id: string
  source: string
  target: string
  label?: string
  style?: Record<string, unknown>
  data: {
    source_port: string
    target_port: string
    protocol: string
    last_seen?: string
  }
}

export interface DiscoverSingleResult {
  device_id: number
  hostname: string
  neighbor_count: number
  neighbors: {
    local_port: string
    hostname: string
    ip?: string
    port: string
    platform?: string
    device_type: string
    protocol: string
    in_inventory: boolean
    device_id?: number
  }[]
  new_switches: {
    hostname: string
    ip?: string
    platform?: string
    local_port: string
    port: string
    device_type: string
    hop_discoverable?: boolean
  }[]
}

export interface DiscoverGhostResult {
  success: boolean
  needs_credentials?: boolean
  tried_count?: number
  message?: string
  device_id?: number
  hostname?: string
  is_new?: boolean
  neighbor_count?: number
  neighbors?: DiscoverSingleResult['neighbors']
  new_switches?: DiscoverSingleResult['new_switches']
}

export interface LldpInventoryItem {
  hostname: string
  ip?: string
  device_type: string
  platform?: string
  local_port: string
  neighbor_port: string
  protocol: string
  last_seen: string
  connected_device_id: number
  connected_device_hostname?: string
  connected_device_ip?: string
}

export const topologyApi = {
  getGraph: (params?: { group_id?: number; site?: string; refresh?: boolean }) =>
    client.get<TopologyGraph>('/topology/graph', { params }).then((r) => r.data),

  triggerDiscovery: (device_ids?: number[]) =>
    client.post<{ task_id: number; device_count: number; status: string }>(
      '/topology/discover',
      device_ids ? device_ids : undefined
    ).then((r) => r.data),

  discoverSingle: (device_id: number) =>
    client.post<DiscoverSingleResult>(`/topology/discover-single/${device_id}`).then((r) => r.data),

  hopDiscover: (source_device_id: number, target_ips: string[], max_depth = 5) =>
    client.post<{ task_id: number; target_count: number; status: string }>(
      '/topology/hop-discover',
      { source_device_id, target_ips, max_depth }
    ).then((r) => r.data),

  discoverGhost: (params: {
    hostname: string
    ip: string
    source_device_id?: number
    username?: string
    password?: string
    os_type?: string
  }) =>
    client.post<DiscoverGhostResult>('/topology/discover-ghost', params).then((r) => r.data),

  getGhostSwitches: () =>
    client.get<{ count: number; switches: { hostname: string; ip?: string; platform?: string; source_device_id: number }[] }>(
      '/topology/ghost-switches'
    ).then((r) => r.data),

  getStats: () =>
    client.get<{
      total_links: number
      matched_links: number
      unmatched_links: number
      devices_with_neighbors: number
    }>('/topology/stats').then((r) => r.data),

  getLinks: (params?: { device_id?: number; skip?: number; limit?: number }) =>
    client.get('/topology/links', { params }).then((r) => r.data),

  getLldpInventory: (device_type?: string, site?: string) =>
    client.get<{ total: number; type_counts: Record<string, number>; items: LldpInventoryItem[] }>(
      '/topology/lldp-inventory',
      { params: { ...(device_type ? { device_type } : {}), ...(site ? { site } : {}) } }
    ).then((r) => r.data),

  getAnomalies: () =>
    client.get<{
      count: number
      warning_count: number
      info_count: number
      anomalies: {
        type: string
        severity: 'warning' | 'info'
        message: string
        hostname?: string
        device_id?: number
        neighbor_device_id?: number
        details: Record<string, unknown>
      }[]
    }>('/topology/anomalies').then((r) => r.data),

  getBlastRadius: (device_id: number) =>
    client.get<{
      device_id: number
      direct_neighbors: number
      affected_count: number
      affected_devices: { id: number; hostname: string; ip_address: string; vendor: string; status: string; layer?: string }[]
      is_critical: boolean
      total_nodes_in_topology: number
    }>(`/topology/blast-radius/${device_id}`).then((r) => r.data),
}
