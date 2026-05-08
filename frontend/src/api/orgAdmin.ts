import client from './client'
import type { PermissionSet } from '@/types'

export interface OrgUser {
  id: number
  username: string
  email: string
  full_name?: string
  is_active: boolean
  system_role: string
  org_id?: number | null
  last_login?: string
  created_at: string
  perm_assignments?: PermAssignment[]
}

export interface PermAssignment {
  id: number
  location_id: number | null
  permission_set_id: number
  assigned_at: string
}

export const orgAdminApi = {
  getOrg: () =>
    client.get<{
      id: number; name: string; slug: string; description?: string;
      contact_email?: string; is_active: boolean;
      trial_ends_at?: string; subscription_ends_at?: string;
      plan?: { name: string; max_users: number; max_devices: number; max_locations: number; features: Record<string, boolean> };
      usage: { users: number };
    }>('/org-admin/org').then((r) => r.data),

  listUsers: (page = 1, perPage = 50) =>
    client.get<{ total: number; users: OrgUser[] }>('/org-admin/users', { params: { page, per_page: perPage } }).then((r) => r.data),

  getUser: (id: number) =>
    client.get<OrgUser & { perm_assignments: PermAssignment[] }>(`/org-admin/users/${id}`).then((r) => r.data),

  updateUser: (id: number, data: Partial<OrgUser>) =>
    client.patch(`/org-admin/users/${id}`, data).then((r) => r.data),

  removeUser: (id: number) =>
    client.delete(`/org-admin/users/${id}`),

  invite: (data: { email: string; full_name?: string; system_role?: string; permission_set_id?: number; expires_hours?: number }) =>
    client.post<{ invite_token: string; email: string; expires_hours: number }>('/org-admin/invite', data).then((r) => r.data),

  listPermSets: () =>
    client.get<{ permission_sets: PermissionSet[] }>('/org-admin/permission-sets').then((r) => r.data),

  createPermSet: (data: { name: string; description?: string; permissions?: any; cloned_from_id?: number }) =>
    client.post<PermissionSet>('/org-admin/permission-sets', data).then((r) => r.data),

  updatePermSet: (id: number, data: Partial<PermissionSet & { is_default?: boolean }>) =>
    client.patch(`/org-admin/permission-sets/${id}`, data).then((r) => r.data),

  deletePermSet: (id: number) =>
    client.delete(`/org-admin/permission-sets/${id}`),

  getUserPermissions: (userId: number) =>
    client.get<{ user_id: number; assignments: PermAssignment[] }>(`/org-admin/users/${userId}/permissions`).then((r) => r.data),

  assignPermission: (userId: number, data: { user_id: number; location_id: number | null; permission_set_id: number }) =>
    client.put(`/org-admin/users/${userId}/permissions`, data).then((r) => r.data),

  removePermission: (userId: number, ulpId: number) =>
    client.delete(`/org-admin/users/${userId}/permissions/${ulpId}`),
}
