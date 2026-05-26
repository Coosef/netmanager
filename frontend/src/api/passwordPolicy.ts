import client from './client'

export interface PasswordPolicy {
  organization_id: number | null
  min_length: number
  require_uppercase: boolean
  require_lowercase: boolean
  require_digit: boolean
  require_special: boolean
  history_count: number
  expiry_days: number
  force_change_on_first_login: boolean
  source: string  // "org-X" | "global" | "code-default"
}

export interface ValidateResponse {
  ok: boolean
  errors: string[]
  policy_source: string
}

export const passwordPolicyApi = {
  get: () => client.get<PasswordPolicy>('/password-policy').then((r) => r.data),

  upsert: (policy: Omit<PasswordPolicy, 'organization_id' | 'source'>) =>
    client.put<PasswordPolicy>('/password-policy', policy).then((r) => r.data),

  resetToGlobal: () =>
    client.delete<{ removed: boolean; note?: string }>('/password-policy').then((r) => r.data),

  validate: (password: string) =>
    client.post<ValidateResponse>('/password-policy/validate', { password }).then((r) => r.data),
}
