import client from './client'

// T9 Tur 6B — PoE / Energy reporting

export interface PoeDeviceRow {
  device_id: number
  hostname: string
  ip_address: string
  vendor: string
  os_type: string
  site: string | null
  location_id: number | null
  total_ports: number
  active_ports: number
  power_mw: number
  power_watts: number
  last_updated_at: string | null
  is_stale: boolean
}

export interface PoeSummary {
  devices: PoeDeviceRow[]
  summary: {
    device_count: number
    total_ports: number
    active_ports: number
    total_power_mw: number
    total_power_watts: number
    stale_devices: number
  }
  stale_threshold_minutes: number
}

export interface PoePort {
  id: number
  port: string
  oper_status: 'on' | 'off' | 'denied' | 'faulty' | 'searching' | string
  admin_status: string | null
  power_mw: number
  power_watts: number
  max_mw: number | null
  device_class: string | null
  source: string
  updated_at: string | null
}

export interface DevicePoe {
  device: {
    id: number
    hostname: string
    ip_address: string
    vendor: string
    os_type: string
    site: string | null
  }
  ports: PoePort[]
  summary: {
    total_ports: number
    active_ports: number
    total_power_mw: number
    total_power_watts: number
  }
}

export const poeApi = {
  summary: (location_id?: number) =>
    client.get<PoeSummary>('/poe/summary', {
      params: location_id ? { location_id } : undefined,
    }).then((r) => r.data),
  device: (deviceId: number) =>
    client.get<DevicePoe>(`/poe/devices/${deviceId}`).then((r) => r.data),
  // T9 Tur 6B follow-up — operatör tarafından tetiklenen anlık snapshot.
  snapshotNow: () =>
    client.post<{ queued: boolean; message: string }>('/poe/snapshot-now').then((r) => r.data),
  // T9 follow-up — Anlık SSH (gerçek mW). Vendor SNMP'i raporlamayanlar
  // için 'show power inline' parse edilir.
  deviceRealtime: (deviceId: number) =>
    client.get<DevicePoe & { source: string }>(`/poe/devices/${deviceId}/realtime`).then((r) => r.data),
}
