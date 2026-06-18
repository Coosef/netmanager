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

  // T8.4 — kullanıcı kendi profil sayfasında lokasyon assignment'larını
  // görebilsin. /users/{id}/locations admin-only; bu self-only versiyonu.
  getMyLocations: () =>
    client.get<UserLocationItem[]>('/users/me/locations').then((r) => r.data),

  setLocations: (id: number, assignments: { location_id: number; loc_role: string }[]) =>
    client.put<{ success: boolean; count: number }>(`/users/${id}/locations`, assignments).then((r) => r.data),

  // T9 Tur 2 #4 — kullanıcı kendi login IP'sini sorgulasın.
  getMyLoginIp: () =>
    client.get<{
      client_ip: string | null
      allowed_ips: string | null
      matches_current_allowlist: boolean
    }>('/users/me/login-ip').then((r) => r.data),

  // T9 Tur 2 #4 follow-up — self-edit allowed_ips. CSV "10.0.0.0/8,10.1.1.5"
  // — boş veya "" gönderince kısıt kalkar; mevcut IP listede yoksa 409.
  updateMyAllowedIps: (allowed_ips: string | null) =>
    client.patch<{ allowed_ips: string | null }>(
      '/users/me/login-ip', { allowed_ips }
    ).then((r) => r.data),

  // User preferences (location-agent-permissions work). The backend
  // endpoint is mass-assignment-safe — only `preferred_language` is
  // accepted; any other key is rejected with a 422. NULL clears the
  // preference and engages the runtime fallback chain (organization
  // default → browser Accept-Language → app default 'tr').
  getMyPreferences: () =>
    client.get<{ preferred_language: string | null }>(
      '/users/me/preferences'
    ).then((r) => r.data),

  updateMyPreferences: (preferred_language: string | null) =>
    client.patch<{ preferred_language: string | null }>(
      '/users/me/preferences', { preferred_language }
    ).then((r) => r.data),
}
