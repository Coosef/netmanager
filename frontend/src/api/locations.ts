import client from './client'

export interface Location {
  id: number
  name: string
  description: string | null
  address: string | null
  color: string | null
  device_count: number
  created_at: string
}

export const locationsApi = {
  list: (params?: { search?: string }) =>
    client.get<{ items: Location[]; total: number }>('/locations/', { params }).then((r) => r.data),

  create: (data: { name: string; description?: string; address?: string; color?: string }) =>
    client.post<Location>('/locations/', data).then((r) => r.data),

  update: (id: number, data: { name?: string; description?: string; address?: string; color?: string }) =>
    client.patch<Location>(`/locations/${id}`, data).then((r) => r.data),

  delete: (id: number, unassign = true) =>
    client.delete(`/locations/${id}`, { params: { unassign } }),
}
