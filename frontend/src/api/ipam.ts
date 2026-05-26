import client from './client'

// T9 Tur 7 — IPAM (sıfırdan rebuild)

export type ZoneType = 'site' | 'environment' | 'vpc' | 'rir_block' | 'custom'

export interface IpamZone {
  id: number
  name: string
  description: string | null
  zone_type: ZoneType
  parent_zone_id: number | null
  location_id: number | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface Utilization {
  used: number
  total: number
  pct: number
  free: number
  warn_pct: number
  is_high: boolean
}

export interface IpamSubnet {
  id: number
  zone_id: number
  cidr: string
  name: string | null
  description: string | null
  vlan_id: number | null
  gateway: string | null
  dhcp_enabled: boolean
  dhcp_server: string | null
  dhcp_range_start: string | null
  dhcp_range_end: string | null
  dns_servers: string[]
  parent_subnet_id: number | null
  utilization_warn_pct: number
  site_hint: string | null
  location_id: number | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  utilization: Utilization | null
}

export type AssignmentType =
  | 'static' | 'dhcp' | 'reserved' | 'gateway' | 'broadcast' | 'network' | 'dynamic'

export type AssignmentSource = 'manual' | 'lldp' | 'arp' | 'dhcp-lease' | 'discovery'

export interface IpamAssignment {
  id: number
  subnet_id: number
  ip_address: string
  hostname: string | null
  mac_address: string | null
  description: string | null
  type: AssignmentType
  source: AssignmentSource
  device_id: number | null
  interface: string | null
  expires_at: string | null
  last_seen_at: string | null
  location_id: number | null
  created_at: string
  updated_at: string
}

export interface IpamSummary {
  zone_count: number
  subnet_count: number
  assignment_count: number
  high_utilization: Array<{
    id: number; cidr: string; name: string | null
    used: number; total: number; pct: number
  }>
}

export const ipamApi = {
  // Zones
  listZones: () => client.get<IpamZone[]>('/ipam/zones').then((r) => r.data),
  createZone: (data: Partial<IpamZone> & { name: string }) =>
    client.post<IpamZone>('/ipam/zones', data).then((r) => r.data),
  updateZone: (id: number, data: Partial<IpamZone>) =>
    client.patch<IpamZone>(`/ipam/zones/${id}`, data).then((r) => r.data),
  deleteZone: (id: number) => client.delete(`/ipam/zones/${id}`),

  // Subnets
  listSubnets: (params?: { zone_id?: number; vlan_id?: number }) =>
    client.get<IpamSubnet[]>('/ipam/subnets', { params }).then((r) => r.data),
  getSubnet: (id: number) => client.get<IpamSubnet>(`/ipam/subnets/${id}`).then((r) => r.data),
  createSubnet: (data: Partial<IpamSubnet> & { zone_id: number; cidr: string }) =>
    client.post<IpamSubnet>('/ipam/subnets', data).then((r) => r.data),
  updateSubnet: (id: number, data: Partial<IpamSubnet>) =>
    client.patch<IpamSubnet>(`/ipam/subnets/${id}`, data).then((r) => r.data),
  deleteSubnet: (id: number) => client.delete(`/ipam/subnets/${id}`),
  checkOverlap: (id: number, cidr: string) =>
    client.get<{ cidr: string; overlaps: { id: number; cidr: string; name: string | null }[] }>(
      `/ipam/subnets/${id}/overlap`, { params: { cidr } }
    ).then((r) => r.data),
  freeIps: (id: number, count = 5) =>
    client.get<{ subnet_id: number; cidr: string; free_ips: string[] }>(
      `/ipam/subnets/${id}/free-ips`, { params: { count } }
    ).then((r) => r.data),

  // Assignments
  listAssignments: (subnetId: number) =>
    client.get<IpamAssignment[]>(`/ipam/subnets/${subnetId}/assignments`).then((r) => r.data),
  createAssignment: (subnetId: number, data: Partial<IpamAssignment> & { ip_address: string }) =>
    client.post<IpamAssignment>(`/ipam/subnets/${subnetId}/assignments`, data).then((r) => r.data),
  updateAssignment: (id: number, data: Partial<IpamAssignment>) =>
    client.patch<IpamAssignment>(`/ipam/assignments/${id}`, data).then((r) => r.data),
  deleteAssignment: (id: number) => client.delete(`/ipam/assignments/${id}`),

  // Lookup / summary
  lookup: (ip: string) =>
    client.get<{
      ip: string; subnet: IpamSubnet | null; assignment: IpamAssignment | null
    }>('/ipam/lookup', { params: { ip } }).then((r) => r.data),
  summary: () => client.get<IpamSummary>('/ipam/summary').then((r) => r.data),
}
