import client from './client'

export interface IpamSubnet {
  id: number
  network: string
  name?: string
  description?: string
  vlan_id?: number
  site?: string
  gateway?: string
  dns_servers?: string
  is_active: boolean
  created_at: string
  total_hosts: number
  used: number
  reserved: number
  free: number
  utilization_pct: number
}

export interface IpamAddress {
  id: number
  ip_address: string
  mac_address?: string
  hostname?: string
  description?: string
  status: 'dynamic' | 'static' | 'reserved'
  device_id?: number
  last_seen?: string
  updated_at: string
}

export interface IpamStats {
  subnets: number
  addresses_dynamic: number
  addresses_static: number
  addresses_reserved: number
  addresses_total: number
}

export const ipamApi = {
  getStats: () =>
    client.get<IpamStats>('/ipam/stats').then((r) => r.data),

  listSubnets: (params?: { search?: string; site?: string; vlan_id?: number }) =>
    client.get<{ total: number; items: IpamSubnet[] }>('/ipam/subnets', { params }).then((r) => r.data),

  createSubnet: (data: {
    network: string
    name?: string
    description?: string
    vlan_id?: number
    site?: string
    gateway?: string
    dns_servers?: string
  }) =>
    client.post<{ id: number; network: string }>('/ipam/subnets', data).then((r) => r.data),

  updateSubnet: (id: number, data: Partial<{
    name: string
    description: string
    vlan_id: number
    site: string
    gateway: string
    dns_servers: string
    is_active: boolean
  }>) =>
    client.patch<{ id: number; network: string }>(`/ipam/subnets/${id}`, data).then((r) => r.data),

  deleteSubnet: (id: number) =>
    client.delete(`/ipam/subnets/${id}`),

  listAddresses: (subnetId: number, params?: { status?: string; search?: string; skip?: number; limit?: number }) =>
    client.get<{
      subnet: { id: number; network: string; name?: string }
      total: number
      items: IpamAddress[]
    }>(`/ipam/subnets/${subnetId}/addresses`, { params }).then((r) => r.data),

  createAddress: (subnetId: number, data: {
    ip_address: string
    mac_address?: string
    hostname?: string
    description?: string
    status?: string
  }) =>
    client.post<{ id: number; ip_address: string }>(`/ipam/subnets/${subnetId}/addresses`, data).then((r) => r.data),

  updateAddress: (addressId: number, data: Partial<{
    mac_address: string
    hostname: string
    description: string
    status: string
  }>) =>
    client.patch<{ id: number; ip_address: string; status: string }>(`/ipam/addresses/${addressId}`, data).then((r) => r.data),

  deleteAddress: (addressId: number) =>
    client.delete(`/ipam/addresses/${addressId}`),

  scanFromArp: (subnetId: number, pingSweep = false) =>
    client.post<{ subnet: string; imported: number; updated: number; ping_discovered: number }>(
      `/ipam/subnets/${subnetId}/scan`,
      null,
      { params: pingSweep ? { ping_sweep: true } : undefined }
    ).then((r) => r.data),
}
