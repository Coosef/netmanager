import client from './client'

export interface SettingValue {
  key: string
  value: number | string | boolean
  is_org_override: boolean
  description?: string | null
  updated_at?: string | null
  updated_by_user_id?: number | null
}

export interface SettingsBundle {
  organization_id: number | null
  settings: SettingValue[]
}

export interface SettingMeta {
  key: string
  default: number | string | boolean
  min_value?: number | null
  max_value?: number | null
}

export interface UpsertResponse {
  key: string
  value: number | string | boolean
  organization_id: number | null
  updated_at: string
  applied_immediately: boolean
  note?: string
}

export const systemSettingsApi = {
  list: () =>
    client.get<SettingsBundle>('/system-settings').then((r) => r.data),

  meta: () =>
    client.get<{ items: SettingMeta[] }>('/system-settings/_meta').then((r) => r.data),

  upsert: (key: string, value: number | string | boolean) =>
    client.put<UpsertResponse>(`/system-settings/${encodeURIComponent(key)}`, { value })
      .then((r) => r.data),

  // Org override'ı sil → global default'a dön
  resetToDefault: (key: string) =>
    client.delete<{ removed: boolean; key?: string; note?: string }>(
      `/system-settings/${encodeURIComponent(key)}`,
    ).then((r) => r.data),
}
