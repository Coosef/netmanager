import client from './client'

export interface MacEntry {
  id: number
  device_id: number
  device_hostname: string
  mac_address: string
  vlan_id?: number
  port?: string
  entry_type: string
  last_seen: string
}

export interface ArpEntry {
  id: number
  device_id: number
  device_hostname: string
  ip_address: string
  mac_address: string
  interface?: string
  last_seen: string
}

export interface PortSummaryItem {
  device_id: number
  device_hostname: string
  port?: string
  vlan_id?: number
  mac_count: number
}

export interface MacArpStats {
  mac_entries: number
  arp_entries: number
  devices_with_mac_data: number
}

export interface DeviceInventoryItem {
  id: number
  device_id: number
  device_hostname: string
  port?: string
  vlan_id?: number
  mac_address: string
  ip_address?: string
  entry_type: string
  oui_vendor?: string
  device_type: string
  last_seen: string
}

export interface CollectResult {
  device_id: number
  hostname: string
  mac_collected: number
  arp_collected: number
  mac_error: boolean
  arp_error: boolean
}

export const macArpApi = {
  getStats: () =>
    client.get<MacArpStats>('/mac-arp/stats').then((r) => r.data),

  getMacTable: (params?: {
    skip?: number
    limit?: number
    device_id?: number
    mac_address?: string
    vlan_id?: number
    port?: string
    entry_type?: string
    site?: string
  }) =>
    client.get<{ total: number; items: MacEntry[] }>('/mac-arp/mac-table', { params }).then((r) => r.data),

  getArpTable: (params?: {
    skip?: number
    limit?: number
    device_id?: number
    ip_address?: string
    mac_address?: string
    site?: string
  }) =>
    client.get<{ total: number; items: ArpEntry[] }>('/mac-arp/arp-table', { params }).then((r) => r.data),

  getPortSummary: (device_id?: number, site?: string) =>
    client.get<{ total: number; items: PortSummaryItem[] }>('/mac-arp/port-summary', {
      params: { ...(device_id ? { device_id } : {}), ...(site ? { site } : {}) },
    }).then((r) => r.data),

  search: (q: string) =>
    client.get<{
      query: string
      mac_hits: Omit<MacEntry, 'id' | 'device_id'>[]
      arp_hits: Omit<ArpEntry, 'id' | 'device_id'>[]
    }>('/mac-arp/search', { params: { q } }).then((r) => r.data),

  collect: (device_ids?: number[]) =>
    client.post<{
      collected: number
      total_mac: number
      total_arp: number
      results: CollectResult[]
    }>('/mac-arp/collect', { device_ids: device_ids ?? [] }).then((r) => r.data),

  getDeviceInventory: (params?: {
    skip?: number
    limit?: number
    device_id?: number
    search?: string
    device_type?: string
    vlan_id?: number
    site?: string
  }) =>
    client.get<{ total: number; items: DeviceInventoryItem[]; type_counts: Record<string, number> }>(
      '/mac-arp/device-inventory',
      { params },
    ).then((r) => r.data),
}
