import client from './client'

export type Recurrence = 'daily' | 'weekly' | 'monthly' | null

export interface MaintenanceWindow {
  id: number
  name: string
  description: string | null
  start_time: string
  end_time: string
  applies_to_all: boolean
  device_ids: number[]
  created_by: number | null
  created_at: string
  is_active: boolean
  // T9 Tur 6A — cyclic fields
  recurrence: Recurrence
  recur_days_of_week: number[]
  recur_day_of_month: number | null
  recur_count_max: number | null
  recur_until: string | null
  recur_instances_spawned: number
  parent_window_id: number | null
  is_recurrence_template: boolean
}

export interface MaintenanceWindowPayload {
  name: string
  description?: string | null
  start_time: string
  end_time: string
  applies_to_all: boolean
  device_ids: number[]
  // T9 Tur 6A
  recurrence?: Recurrence
  recur_days_of_week?: number[] | null
  recur_day_of_month?: number | null
  recur_count_max?: number | null
  recur_until?: string | null
}

export const maintenanceWindowsApi = {
  /** Default hides spawned child instances; pass includeInstances=true to see them. */
  list: (includeInstances = false) =>
    client.get<MaintenanceWindow[]>('/maintenance-windows', {
      params: { include_instances: includeInstances },
    }).then((r) => r.data),
  listActive: () => client.get<MaintenanceWindow[]>('/maintenance-windows/active').then((r) => r.data),
  /** T9 Tur 6A — list materialized child instances of a recurrence template. */
  listUpcoming: (parentId: number, limit = 20) =>
    client.get<MaintenanceWindow[]>(`/maintenance-windows/${parentId}/upcoming`, {
      params: { limit },
    }).then((r) => r.data),
  create: (data: MaintenanceWindowPayload) =>
    client.post<MaintenanceWindow>('/maintenance-windows', data).then((r) => r.data),
  update: (id: number, data: Partial<MaintenanceWindowPayload>) =>
    client.patch<MaintenanceWindow>(`/maintenance-windows/${id}`, data).then((r) => r.data),
  delete: (id: number) => client.delete(`/maintenance-windows/${id}`),
}
