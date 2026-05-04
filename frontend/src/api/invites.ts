import client from './client'

export interface Invite {
  id: number
  email: string
  role: string
  expires_at: string
  used_at: string | null
  is_expired: boolean
  is_used: boolean
}

export const invitesApi = {
  list: () =>
    client.get<Invite[]>('/invites/').then((r) => r.data),

  create: (email: string, role: string, expires_hours = 72) =>
    client.post<{ id: number; token: string; email: string; role: string; expires_at: string }>(
      '/invites/',
      { email, role, expires_hours }
    ).then((r) => r.data),

  revoke: (id: number) =>
    client.delete(`/invites/${id}`),

  check: (token: string) =>
    client.get<{ email: string; role: string }>(`/invites/check/${token}`).then((r) => r.data),

  accept: (token: string, username: string, password: string, full_name: string) =>
    client.post('/invites/accept', { token, username, password, full_name }).then((r) => r.data),
}
