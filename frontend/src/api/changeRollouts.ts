import client from './client'

export interface DeviceResult {
  hostname: string
  ip: string
  status: 'success' | 'failed' | 'rolled_back'
  backup_id: number | null
  output: string
  error: string | null
  diff: string[]
  rollback_error?: string
}

export interface ChangeRollout {
  id: number
  name: string
  description: string | null
  template_id: number | null
  template_variables: Record<string, string> | null
  raw_commands: string[] | null
  device_ids: number[]
  status: 'draft' | 'pending_approval' | 'approved' | 'running' | 'done' | 'partial' | 'failed' | 'rolled_back'
  submitted_by: string | null
  approved_by: string | null
  approved_at: string | null
  rejection_note: string | null
  started_at: string | null
  completed_at: string | null
  device_results: Record<string, DeviceResult> | null
  total_devices: number
  success_devices: number
  failed_devices: number
  rolled_back_devices: number
  created_by: string
  created_at: string
  updated_at: string
}

export interface RolloutList {
  total: number
  items: ChangeRollout[]
}

export interface RolloutCreate {
  name: string
  description?: string
  template_id?: number
  template_variables?: Record<string, string>
  raw_commands?: string[]
  device_ids: number[]
}

export const changeRolloutsApi = {
  list: (params?: { status?: string; limit?: number; offset?: number }) =>
    client.get<RolloutList>('/change-rollouts', { params }).then((r) => r.data),

  get: (id: number) =>
    client.get<ChangeRollout>(`/change-rollouts/${id}`).then((r) => r.data),

  create: (payload: RolloutCreate) =>
    client.post<ChangeRollout>('/change-rollouts', payload).then((r) => r.data),

  update: (id: number, payload: Partial<RolloutCreate>) =>
    client.patch<ChangeRollout>(`/change-rollouts/${id}`, payload).then((r) => r.data),

  delete: (id: number) =>
    client.delete(`/change-rollouts/${id}`),

  submit: (id: number) =>
    client.post<ChangeRollout>(`/change-rollouts/${id}/submit`).then((r) => r.data),

  approve: (id: number, note?: string) =>
    client.post<ChangeRollout>(`/change-rollouts/${id}/approve`, { note }).then((r) => r.data),

  reject: (id: number, note: string) =>
    client.post<ChangeRollout>(`/change-rollouts/${id}/reject`, { note }).then((r) => r.data),

  start: (id: number) =>
    client.post(`/change-rollouts/${id}/start`).then((r) => r.data),

  rollback: (id: number) =>
    client.post(`/change-rollouts/${id}/rollback`).then((r) => r.data),
}
