import client from './client'

// T9 Tur 5 #11 — Easy Config Builder

export type FieldType =
  | 'string'
  | 'int'
  | 'vlan_id'
  | 'interface'
  | 'enum'
  | 'cidr'
  | 'ipv4'

export interface OperationField {
  name: string
  label: string
  type: FieldType
  required: boolean
  default?: unknown
  placeholder?: string | null
  help?: string | null
  options?: Array<{ value: string; label: string }> | null
  min?: number | null
  max?: number | null
}

export interface Operation {
  key: string
  label: string
  description: string
  category: 'vlan' | 'interface' | 'global' | 'aaa' | string
  icon: string
  requires_save: boolean
  supported_vendors: string[]
  fields: OperationField[]
}

export interface PreviewItem {
  device_id: number
  hostname: string
  os_type: string
  supported: boolean
  commands: string[]
  error: string | null
}

export interface PreviewResponse {
  operation: string
  params: Record<string, unknown>
  items: PreviewItem[]
  missing_device_ids: number[]
  supported_count: number
  error_count: number
}

export interface PushResultItem extends PreviewItem {
  success: boolean
  output: string
  skipped?: boolean
}

export interface PushResponse {
  operation: string
  params: Record<string, unknown>
  results: PushResultItem[]
  success_count: number
  total: number
}

export const configBuilderApi = {
  listOperations: () =>
    client.get<{ operations: Operation[] }>('/config-builder/operations')
      .then((r) => r.data.operations),

  preview: (operation: string, params: Record<string, unknown>,
            device_ids: number[], with_save = true) =>
    client.post<PreviewResponse>('/config-builder/preview', {
      operation, params, device_ids, with_save,
    }).then((r) => r.data),

  push: (operation: string, params: Record<string, unknown>,
         device_ids: number[], opts?: { with_save?: boolean; reason?: string }) =>
    client.post<PushResponse>('/config-builder/push', {
      operation, params, device_ids,
      with_save: opts?.with_save ?? true,
      reason: opts?.reason || null,
      confirm: true,
    }).then((r) => r.data),
}
