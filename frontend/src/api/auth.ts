import client from './client'
import type { TokenResponse, User, Permissions } from '@/types'

export const authApi = {
  login: (username: string, password: string) =>
    client.post<TokenResponse>('/auth/login', { username, password }).then((r) => r.data),

  me: () => client.get<User>('/auth/me').then((r) => r.data),

  myPermissions: () =>
    client.get<{ permissions: Permissions; system_role: string }>('/auth/me/permissions').then((r) => r.data),

  acceptInvite: (payload: {
    token: string
    username: string
    password: string
    full_name?: string
  }) =>
    client.post<TokenResponse>('/auth/invite/accept', payload).then((r) => r.data),
}
