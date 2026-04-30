import client from './client'
import type { TokenResponse, User } from '@/types'

export const authApi = {
  login: (username: string, password: string) =>
    client.post<TokenResponse>('/auth/login', { username, password }).then((r) => r.data),

  me: () => client.get<User>('/auth/me').then((r) => r.data),
}
