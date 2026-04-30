import client from './client'

export interface TemplateVariable {
  name: string
  label: string
  default?: string
  required?: boolean
}

export interface ConfigTemplate {
  id: number
  name: string
  description: string | null
  os_types: string[] | null
  template: string
  variables: TemplateVariable[]
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface PushResult {
  device_id: number
  hostname: string
  success: boolean
  output: string
  error: string
  dry_run: boolean
}

export interface PushResponse {
  results: PushResult[]
  success_count: number
  total: number
}

export const configTemplatesApi = {
  list: () =>
    client.get<ConfigTemplate[]>('/config-templates').then((r) => r.data),

  create: (payload: Partial<ConfigTemplate>) =>
    client.post<ConfigTemplate>('/config-templates', payload).then((r) => r.data),

  update: (id: number, payload: Partial<ConfigTemplate>) =>
    client.patch<ConfigTemplate>(`/config-templates/${id}`, payload).then((r) => r.data),

  delete: (id: number) =>
    client.delete(`/config-templates/${id}`),

  preview: (id: number, variables: Record<string, string>) =>
    client
      .post<{ success: boolean; preview?: string; error?: string }>(`/config-templates/${id}/preview`, { variables })
      .then((r) => r.data),

  push: (id: number, deviceIds: number[], variables: Record<string, string>, dryRun = false) =>
    client
      .post<PushResponse>(`/config-templates/${id}/push`, {
        device_ids: deviceIds,
        variables,
        dry_run: dryRun,
      })
      .then((r) => r.data),
}
