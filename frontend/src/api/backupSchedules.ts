import client from './client'

export interface BackupSchedule {
  id: number
  name: string
  enabled: boolean
  schedule_type: 'daily' | 'weekly' | 'interval'
  run_hour: number
  run_minute: number
  days_of_week: number[] | null  // 0=Mon..6=Sun
  interval_hours: number
  device_filter: 'all' | 'stale' | 'never' | 'site'
  site: string | null
  last_run_at: string | null
  next_run_at: string | null
  last_task_id: number | null
  is_default: boolean
  created_by: number | null
  created_at: string
  updated_at: string
}

export interface BackupSchedulePayload {
  name: string
  enabled?: boolean
  schedule_type: 'daily' | 'weekly' | 'interval'
  run_hour?: number
  run_minute?: number
  days_of_week?: number[] | null
  interval_hours?: number
  device_filter?: 'all' | 'stale' | 'never' | 'site'
  site?: string | null
}

export interface DriftItem {
  device_id: number
  hostname: string
  ip: string | null
  vendor: string | null
  site: string | null
  device_status: string | null
  drift: boolean
  reason: 'hash_mismatch' | 'no_backup'
  latest_backup_at: string | null
  backup_id: number | null
}

export interface DriftReport {
  total_with_golden: number
  drift_count: number
  clean_count: number
  no_backup_count: number
  items: DriftItem[]
  total: number
}

export const backupSchedulesApi = {
  list: () =>
    client.get<BackupSchedule[]>('/backup-schedules/').then((r) => r.data),

  create: (data: BackupSchedulePayload) =>
    client.post<BackupSchedule>('/backup-schedules/', data).then((r) => r.data),

  update: (id: number, data: Partial<BackupSchedulePayload>) =>
    client.put<BackupSchedule>(`/backup-schedules/${id}`, data).then((r) => r.data),

  delete: (id: number) =>
    client.delete(`/backup-schedules/${id}`),

  runNow: (id: number) =>
    client.post<{ status: string; task_id?: number }>(`/backup-schedules/${id}/run-now`).then((r) => r.data),

  driftReport: (params?: { skip?: number; limit?: number }) =>
    client.get<DriftReport>('/backup-schedules/drift-report', { params }).then((r) => r.data),
}
