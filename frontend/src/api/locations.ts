import client from './client'

export interface Location {
  id: number
  name: string
  description: string | null
  address: string | null
  color: string | null
  city: string | null
  country: string | null
  timezone: string | null
  tenant_id: number | null
  device_count: number
  user_count: number
  created_at: string
}

export interface LocationUser {
  user_id: number
  username: string
  full_name: string | null
  email: string
  user_role: string
  loc_role: string
  assigned_at: string
}

export const locationsApi = {
  list: (params?: { search?: string; tenant_id?: number }) =>
    client.get<{ items: Location[]; total: number }>('/locations/', { params }).then((r) => r.data),

  get: (id: number) =>
    client.get<Location>(`/locations/${id}`).then((r) => r.data),

  create: (data: {
    name: string
    description?: string
    address?: string
    color?: string
    city?: string
    country?: string
    timezone?: string
    tenant_id?: number
  }) => client.post<Location>('/locations/', data).then((r) => r.data),

  update: (id: number, data: {
    name?: string
    description?: string
    address?: string
    color?: string
    city?: string
    country?: string
    timezone?: string
  }) => client.patch<Location>(`/locations/${id}`, data).then((r) => r.data),

  delete: (id: number, unassign = true) =>
    client.delete(`/locations/${id}`, { params: { unassign } }),

  listUsers: (locationId: number) =>
    client.get<LocationUser[]>(`/locations/${locationId}/users`).then((r) => r.data),

  assignUser: (locationId: number, data: { user_id: number; loc_role: string }) =>
    client.post<{ success: boolean }>(`/locations/${locationId}/users`, data).then((r) => r.data),

  removeUser: (locationId: number, userId: number) =>
    client.delete(`/locations/${locationId}/users/${userId}`),
}
