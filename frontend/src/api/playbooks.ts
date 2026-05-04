import client from './client'

export type StepType = 'ssh_command' | 'backup' | 'compliance_check' | 'notify' | 'wait' | 'condition_check'
export type TriggerType = 'manual' | 'scheduled' | 'event'

export interface PlaybookStep {
  type?: StepType
  command?: string
  description?: string
  stop_on_error?: boolean
  // wait step
  seconds?: number
  // notify step
  channel_id?: number
  subject?: string
  message?: string
  // condition_check step
  condition?: string
  on_true?: 'continue'
  on_false?: 'skip' | 'abort'
}

export interface Playbook {
  id: number
  name: string
  description?: string
  steps: PlaybookStep[]
  step_count: number
  target_group_id?: number
  target_device_ids: number[]
  is_scheduled: boolean
  schedule_interval_hours: number
  next_run_at?: string
  trigger_type: TriggerType
  trigger_event_type?: string
  pre_run_backup: boolean
  created_at: string
  updated_at: string
}

export interface PlaybookRun {
  id: number
  playbook_id: number
  status: 'pending' | 'running' | 'success' | 'partial' | 'failed' | 'dry_run'
  is_dry_run: boolean
  triggered_by_username: string
  total_devices: number
  success_devices: number
  failed_devices: number
  started_at?: string
  completed_at?: string
  created_at: string
  device_results?: Record<string, {
    hostname: string
    ip: string
    ok: boolean
    steps: { command: string; description?: string; success: boolean; output: string; error?: string; simulated?: boolean }[]
  }>
}

export interface PlaybookTemplate {
  id: string
  name: string
  description: string
  trigger_type: TriggerType
  trigger_event_type?: string
  pre_run_backup: boolean
  schedule_interval_hours: number
  icon: string
  steps: PlaybookStep[]
}

export const playbooksApi = {
  listTemplates: () =>
    client.get<PlaybookTemplate[]>('/playbooks/templates').then((r) => r.data),

  createFromTemplate: (data: {
    template_id: string
    name?: string
    description?: string
    target_group_id?: number
    target_device_ids?: number[]
    schedule_interval_hours?: number
  }) =>
    client.post<Playbook>('/playbooks/from-template', data).then((r) => r.data),

  list: () =>
    client.get<{ total: number; items: Playbook[] }>('/playbooks').then((r) => r.data),

  get: (id: number) =>
    client.get<Playbook>(`/playbooks/${id}`).then((r) => r.data),

  create: (data: {
    name: string; description?: string; steps: PlaybookStep[]
    target_group_id?: number; target_device_ids?: number[]
    trigger_type?: TriggerType; trigger_event_type?: string
    pre_run_backup?: boolean; schedule_interval_hours?: number
  }) =>
    client.post<Playbook>('/playbooks', data).then((r) => r.data),

  update: (id: number, data: Partial<{
    name: string; description: string; steps: PlaybookStep[]
    target_group_id: number | null; target_device_ids: number[]
    trigger_type: TriggerType; trigger_event_type: string | null
    pre_run_backup: boolean; schedule_interval_hours: number
  }>) =>
    client.patch<Playbook>(`/playbooks/${id}`, data).then((r) => r.data),

  delete: (id: number) =>
    client.delete(`/playbooks/${id}`),

  run: (id: number, dry_run = false) =>
    client.post<{ run_id: number; playbook_id: number; device_count: number; status: string; dry_run: boolean }>(
      `/playbooks/${id}/run`, { dry_run }
    ).then((r) => r.data),

  getRuns: (id: number) =>
    client.get<{ total: number; items: PlaybookRun[] }>(`/playbooks/${id}/runs`).then((r) => r.data),

  getRun: (playbookId: number, runId: number) =>
    client.get<PlaybookRun>(`/playbooks/${playbookId}/runs/${runId}`).then((r) => r.data),
}
