import client from './client'

export interface CredentialProfile {
  id: number
  name: string
  description: string | null
  ssh_username: string | null
  ssh_password_set: boolean
  ssh_port: number
  enable_secret_set: boolean
  snmp_enabled: boolean
  snmp_community: string | null
  snmp_version: string
  snmp_port: number
  snmp_v3_username: string | null
  snmp_v3_auth_protocol: string | null
  snmp_v3_priv_protocol: string | null
  snmp_v3_auth_passphrase_set: boolean
  snmp_v3_priv_passphrase_set: boolean
  created_at: string
  updated_at: string
}

// Write-only payload — passwords are separate string fields, never returned
export interface CredentialProfilePayload {
  name: string
  description?: string | null
  ssh_username?: string | null
  ssh_password?: string       // plaintext — encrypted server-side
  ssh_port?: number
  enable_secret?: string      // plaintext — encrypted server-side; "" to clear
  snmp_enabled?: boolean
  snmp_community?: string | null
  snmp_version?: string
  snmp_port?: number
  snmp_v3_username?: string | null
  snmp_v3_auth_protocol?: string | null
  snmp_v3_priv_protocol?: string | null
  snmp_v3_auth_passphrase?: string
  snmp_v3_priv_passphrase?: string
}

export interface RotationPolicy {
  id: number
  credential_profile_id: number
  profile_name?: string
  interval_days: number
  is_active: boolean
  status: 'idle' | 'running' | 'success' | 'failed'
  last_rotated_at: string | null
  next_rotate_at: string | null
  last_result: {
    rotated_at?: string
    all_success?: boolean
    device_count?: number
    message?: string
    device_results?: { device_id: number; hostname: string; success: boolean; message: string }[]
  } | null
  created_at: string
  updated_at: string
}

export const credentialProfilesApi = {
  list: () => client.get<CredentialProfile[]>('/credential-profiles').then((r) => r.data),
  create: (data: CredentialProfilePayload) =>
    client.post<CredentialProfile>('/credential-profiles', data).then((r) => r.data),
  update: (id: number, data: Partial<CredentialProfilePayload>) =>
    client.patch<CredentialProfile>(`/credential-profiles/${id}`, data).then((r) => r.data),
  delete: (id: number) => client.delete(`/credential-profiles/${id}`),

  // Rotation policy
  listRotationPolicies: () =>
    client.get<RotationPolicy[]>('/credential-profiles/rotation-policies/all').then((r) => r.data),
  getRotationPolicy: (profileId: number) =>
    client.get<RotationPolicy>(`/credential-profiles/${profileId}/rotation-policy`).then((r) => r.data),
  createRotationPolicy: (profileId: number, data: { interval_days: number; is_active: boolean }) =>
    client.post<RotationPolicy>(`/credential-profiles/${profileId}/rotation-policy`, data).then((r) => r.data),
  updateRotationPolicy: (profileId: number, data: { interval_days?: number; is_active?: boolean }) =>
    client.patch<RotationPolicy>(`/credential-profiles/${profileId}/rotation-policy`, data).then((r) => r.data),
  deleteRotationPolicy: (profileId: number) =>
    client.delete(`/credential-profiles/${profileId}/rotation-policy`),
  rotateNow: (profileId: number) =>
    client.post<{ message: string; policy_id: number }>(`/credential-profiles/${profileId}/rotate-now`).then((r) => r.data),
}
