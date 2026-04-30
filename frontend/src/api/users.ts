import client from './client'
import type { User } from '@/types'

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
}
