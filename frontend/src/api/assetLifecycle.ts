import client from './client'

export type LifecycleStatus = 'ok' | 'expiring_soon' | 'expiring_90d' | 'expired' | 'eol'

export interface AssetItem {
  id: number
  device_id: number
  device_hostname: string
  purchase_date: string | null
  warranty_expiry: string | null
  eol_date: string | null
  eos_date: string | null
  purchase_cost: number | null
  currency: string
  po_number: string | null
  vendor_contract: string | null
  support_tier: string | null
  maintenance_notes: string | null
  lifecycle_status: LifecycleStatus
  created_at: string
  updated_at: string
}

export interface AssetStats {
  total: number
  expired: number
  expiring_30d: number
  expiring_90d: number
  eol_count: number
  total_cost: number
  upcoming_expirations: {
    device_id: number
    device_hostname: string
    warranty_expiry: string
    days_left: number
    lifecycle_status: LifecycleStatus
  }[]
}

export interface AssetUpsertPayload {
  device_id: number
  purchase_date?: string | null
  warranty_expiry?: string | null
  eol_date?: string | null
  eos_date?: string | null
  purchase_cost?: number | null
  currency?: string
  po_number?: string | null
  vendor_contract?: string | null
  support_tier?: string | null
  maintenance_notes?: string | null
}

export interface EolLookupResult {
  device_id: number
  hostname: string
  model: string | null
  vendor: string | null
  status: 'matched' | 'not_found'
  eol_date: string | null
  eos_date: string | null
  matched_model: string | null
  source?: string
}

export interface EolLookupResponse {
  checked: number
  updated: number
  not_found: number
  results: EolLookupResult[]
}

export const assetLifecycleApi = {
  stats: (params?: { site?: string }) =>
    client.get<AssetStats>('/asset-lifecycle/stats', { params }).then((r) => r.data),

  list: (params?: { search?: string; status?: string; page?: number; page_size?: number; site?: string }) =>
    client
      .get<{ total: number; items: AssetItem[] }>('/asset-lifecycle/', { params })
      .then((r) => r.data),

  getByDevice: (deviceId: number) =>
    client.get<AssetItem>(`/asset-lifecycle/device/${deviceId}`).then((r) => r.data),

  get: (id: number) =>
    client.get<AssetItem>(`/asset-lifecycle/${id}`).then((r) => r.data),

  upsert: (payload: AssetUpsertPayload) =>
    client.post<AssetItem>('/asset-lifecycle/', payload).then((r) => r.data),

  update: (id: number, payload: AssetUpsertPayload) =>
    client.put<AssetItem>(`/asset-lifecycle/${id}`, payload).then((r) => r.data),

  delete: (id: number) =>
    client.delete(`/asset-lifecycle/${id}`).then((r) => r.data),

  eolLookup: (deviceIds?: number[]) =>
    client.post<EolLookupResponse>('/asset-lifecycle/eol-lookup', { device_ids: deviceIds ?? [] })
      .then((r) => r.data),
}
