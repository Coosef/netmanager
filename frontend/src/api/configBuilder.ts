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

  // T9 follow-up — sepet (multi-operation) batch
  previewBatch: (items: Array<{ operation: string; params: Record<string, unknown> }>,
                 device_ids: number[], with_save = true) =>
    client.post<{
      items: Array<{
        device_id: number; hostname: string; os_type: string;
        supported: boolean; commands: string[]; error: string | null;
        per_op_commands: Array<{ operation: string; commands: string[] }>;
      }>;
      operation_count: number; supported_count: number; error_count: number;
    }>('/config-builder/preview-batch', { items, device_ids, with_save }).then((r) => r.data),

  pushBatch: (items: Array<{ operation: string; params: Record<string, unknown> }>,
              device_ids: number[], opts?: { with_save?: boolean; reason?: string }) =>
    client.post<{
      items: Array<{ operation: string; params: Record<string, unknown> }>;
      results: Array<{
        device_id: number; hostname: string; success: boolean;
        error?: string | null; skipped?: boolean; output?: string;
      }>;
      success_count: number; total: number;
    }>('/config-builder/push-batch', {
      items, device_ids,
      with_save: opts?.with_save ?? true,
      reason: opts?.reason || null,
      confirm: true,
    }).then((r) => r.data),

  // T9 follow-up — Cihaz seçmeden OS-type ile preview (canlı/dry-run)
  previewByOs: (operation: string, params: Record<string, unknown>,
                os_types: string[], with_save = true) =>
    client.post<{
      operation: string; params: Record<string, unknown>;
      items: Array<{
        os_type: string; supported: boolean;
        commands: string[]; error: string | null;
      }>;
      supported_count: number; error_count: number;
    }>('/config-builder/preview-by-os', { operation, params, os_types, with_save })
      .then((r) => r.data),

  previewBatchByOs: (items: Array<{ operation: string; params: Record<string, unknown> }>,
                     os_types: string[], with_save = true) =>
    client.post<{
      items: Array<{
        os_type: string; supported: boolean;
        commands: string[]; error: string | null;
        per_op_commands: Array<{ operation: string; commands: string[] }>;
      }>;
      operation_count: number; supported_count: number; error_count: number;
    }>('/config-builder/preview-batch-by-os', { items, os_types, with_save })
      .then((r) => r.data),
}
