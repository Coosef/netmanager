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
  // T10 A2 — UI kategori grubu + yazma kapsamı ("global" | "org")
  category?: string
  scope?: 'global' | 'org'
}

export interface UpsertResponse {
  key: string
  value: number | string | boolean
  organization_id: number | null
  scope?: 'global' | 'org'
  updated_at: string
  applied_immediately: boolean
  note?: string
}

// T10 A3 — retention dry-run önizleme
export interface RetentionPreviewOrg {
  organization_id: number
  organization_name: string
  tables: Record<string, number>
  total: number
}
export interface RetentionPreview {
  dry_run: boolean
  total: number
  organizations: RetentionPreviewOrg[]
}

export const systemSettingsApi = {
  list: () =>
    client.get<SettingsBundle>('/system-settings').then((r) => r.data),

  // T10 A3 — dry-run: ne silinecek (hiçbir şey silinmez)
  retentionPreview: (organizationId?: number) =>
    client.get<RetentionPreview>('/system-settings/retention-preview', {
      params: organizationId != null ? { organization_id: organizationId } : undefined,
    }).then((r) => r.data),

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
