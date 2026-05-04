import client from './client'
import type { User } from '@/types'

export interface UserLocationItem {
  location_id: number
  location_name: string
  loc_role: string
  assigned_at?: string
}

export const usersApi = {
  list: () => client.get<User[]>('/users/').then((r) => r.data),

  get: (id: number) => client.get<User>(`/users/${id}`).then((r) => r.data),

  create: (data: Record<string, unknown>) =>
    client.post<User>('/users/', data).then((r) => r.data),

  update: (id: number, data: Record<string, unknown>) =>
    client.patch<User>(`/users/${id}`, data).then((r) => r.data),

  delete: (id: number) => client.delete(`/users/${id}`),

  changePassword: (data: { current_password: string; new_password: string }) =>
    client.post('/users/me/change-password', data),

  resetPassword: (id: number, new_password: string) =>
    client.post(`/users/${id}/reset-password`, { new_password }),

  getLocations: (id: number) =>
    client.get<UserLocationItem[]>(`/users/${id}/locations`).then((r) => r.data),

  setLocations: (id: number, assignments: { location_id: number; loc_role: string }[]) =>
    client.put<{ success: boolean; count: number }>(`/users/${id}/locations`, assignments).then((r) => r.data),
}
