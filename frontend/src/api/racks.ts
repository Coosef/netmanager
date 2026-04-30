import client from './client'

export interface RackDeviceSummary {
  id: number
  hostname: string
  ip_address: string
  vendor: string
  status: string
  device_type: string
  model?: string
  rack_unit: number
  rack_height: number
}

export interface RackItem {
  id: number
  rack_name: string
  label: string
  item_type: string
  unit_start: number
  unit_height: number
  notes?: string
}

export interface RackSummary {
  rack_name: string
  total_u: number
  used_u: number
  device_count: number
  item_count: number
}

export interface RackDetail {
  rack_name: string
  total_u: number
  devices: RackDeviceSummary[]
  items: RackItem[]
}

export const racksApi = {
  list: (params?: { site?: string }) => client.get<RackSummary[]>('/racks', { params }).then((r) => r.data),
  get: (rackName: string) => client.get<RackDetail>(`/racks/${encodeURIComponent(rackName)}`).then((r) => r.data),
  unassigned: (params?: { site?: string }) => client.get<RackDeviceSummary[]>('/racks/unassigned/devices', { params }).then((r) => r.data),
  create: (payload: { rack_name: string; total_u: number; description?: string }) =>
    client.post<RackSummary>('/racks', payload).then((r) => r.data),
  deleteRack: (rackName: string) => client.delete(`/racks/${encodeURIComponent(rackName)}`),
  setPlacement: (deviceId: number, rack_name: string, rack_unit: number, rack_height: number) =>
    client.put(`/racks/devices/${deviceId}/placement`, { rack_name, rack_unit, rack_height }),
  removePlacement: (deviceId: number) => client.delete(`/racks/devices/${deviceId}/placement`),
  createItem: (rackName: string, payload: Omit<RackItem, 'id' | 'rack_name'>) =>
    client.post<RackItem>(`/racks/${encodeURIComponent(rackName)}/items`, payload).then((r) => r.data),
  updateItem: (rackName: string, itemId: number, payload: Partial<Omit<RackItem, 'id' | 'rack_name'>>) =>
    client.put<RackItem>(`/racks/${encodeURIComponent(rackName)}/items/${itemId}`, payload).then((r) => r.data),
  deleteItem: (rackName: string, itemId: number) =>
    client.delete(`/racks/${encodeURIComponent(rackName)}/items/${itemId}`),
}
