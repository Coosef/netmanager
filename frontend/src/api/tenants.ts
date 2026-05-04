import client from './client'

export interface Tenant {
  id: number
  name: string
  slug: string
  description?: string
  is_active: boolean
  plan_tier: string
  max_devices: number
  max_users: number
  contact_email?: string | null
  created_at: string
  device_count: number
  user_count: number
  location_count: number
}

export interface TenantUser {
  id: number
  username: string
  email: string
  full_name?: string
  role: string
  is_active: boolean
}

export const tenantsApi = {
  list: () =>
    client.get<Tenant[]>('/tenants/').then((r) => r.data),

  get: (id: number) =>
    client.get<Tenant>(`/tenants/${id}`).then((r) => r.data),

  create: (data: {
    name: string
    slug: string
    description?: string
    is_active?: boolean
    plan_tier?: string
    max_devices?: number
    max_users?: number
    contact_email?: string
  }) => client.post<Tenant>('/tenants/', data).then((r) => r.data),

  update: (id: number, data: Partial<{
    name: string
    description: string
    is_active: boolean
    plan_tier: string
    max_devices: number
    max_users: number
    contact_email: string
  }>) => client.patch<Tenant>(`/tenants/${id}`, data).then((r) => r.data),

  delete: (id: number) =>
    client.delete(`/tenants/${id}`),

  listUsers: (id: number) =>
    client.get<TenantUser[]>(`/tenants/${id}/users`).then((r) => r.data),

  assignUser: (tenantId: number, userId: number) =>
    client.post(`/tenants/${tenantId}/assign-user/${userId}`).then((r) => r.data),
}
