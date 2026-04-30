import client from './client'

export interface ApiToken {
  id: number
  name: string
  prefix: string
  expires_at?: string
  last_used_at?: string
  created_at: string
  is_active: boolean
}

export interface ApiTokenCreated extends ApiToken {
  token: string
}

export const apiTokensApi = {
  list: () => client.get<ApiToken[]>('/api-tokens').then((r) => r.data),
  create: (name: string, expires_in_days?: number) =>
    client.post<ApiTokenCreated>('/api-tokens', { name, expires_in_days }).then((r) => r.data),
  revoke: (id: number) => client.delete(`/api-tokens/${id}`),
}
