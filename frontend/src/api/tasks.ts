import client from './client'
import type { Task, AuditLog, PaginatedResponse } from '@/types'

export const tasksApi = {
  list: (params?: { skip?: number; limit?: number; status?: string; type?: string }) =>
    client.get<PaginatedResponse<Task>>('/tasks/', { params }).then((r) => r.data),

  get: (id: number) =>
    client.get<Task>(`/tasks/${id}`).then((r) => r.data),

  create: (data: { name: string; type: string; device_ids: number[]; parameters?: Record<string, unknown> }) =>
    client.post<Task>('/tasks/', data).then((r) => r.data),

  cancel: (id: number) =>
    client.post<{ task_id: number; status: string }>(`/tasks/${id}/cancel`).then((r) => r.data),

  getAuditLog: (params?: {
    skip?: number
    limit?: number
    action?: string
    resource_type?: string
    username?: string
    status?: string
    date_from?: string
    date_to?: string
    request_id?: string
  }) =>
    client.get<PaginatedResponse<AuditLog>>('/tasks/audit-log', { params }).then((r) => r.data),
}
