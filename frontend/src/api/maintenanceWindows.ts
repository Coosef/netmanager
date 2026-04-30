import client from './client'

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
}

export type MaintenanceWindowPayload = Omit<MaintenanceWindow, 'id' | 'created_by' | 'created_at' | 'is_active'>

export const maintenanceWindowsApi = {
  list: () => client.get<MaintenanceWindow[]>('/maintenance-windows').then((r) => r.data),
  listActive: () => client.get<MaintenanceWindow[]>('/maintenance-windows/active').then((r) => r.data),
  create: (data: MaintenanceWindowPayload) =>
    client.post<MaintenanceWindow>('/maintenance-windows', data).then((r) => r.data),
  update: (id: number, data: Partial<MaintenanceWindowPayload>) =>
    client.patch<MaintenanceWindow>(`/maintenance-windows/${id}`, data).then((r) => r.data),
  delete: (id: number) => client.delete(`/maintenance-windows/${id}`),
}
