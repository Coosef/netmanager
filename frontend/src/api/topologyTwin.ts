import client from './client'

export interface TopologySnapshotMeta {
  id: number
  name: string
  is_golden: boolean
  device_count: number
  link_count: number
  created_at: string
}

export interface SnapshotLink {
  device_id: number | null
  local_port: string
  neighbor_hostname: string
  neighbor_port: string
  neighbor_device_id: number | null
  neighbor_ip: string | null
  protocol: string
  last_seen: string | null
}

export interface TopologyDiff {
  has_golden: boolean
  drift_detected: boolean
  added_count: number
  removed_count: number
  unchanged_count: number
  added: SnapshotLink[]
  removed: SnapshotLink[]
  unchanged: SnapshotLink[]
  golden: TopologySnapshotMeta | null
}

export const topologyTwinApi = {
  listSnapshots: () =>
    client.get<{ snapshots: TopologySnapshotMeta[]; total: number }>('/topology-twin/snapshots').then(r => r.data),

  createSnapshot: (name: string) =>
    client.post<TopologySnapshotMeta>('/topology-twin/snapshots', { name }).then(r => r.data),

  deleteSnapshot: (id: number) =>
    client.delete(`/topology-twin/snapshots/${id}`),

  setGolden: (id: number) =>
    client.post<TopologySnapshotMeta>(`/topology-twin/snapshots/${id}/set-golden`).then(r => r.data),

  getDiff: () =>
    client.get<TopologyDiff>('/topology-twin/diff').then(r => r.data),
}
