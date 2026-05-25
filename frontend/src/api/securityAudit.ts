import client from './client'

export interface AuditFinding {
  id: string
  name: string
  category: string
  status: 'pass' | 'fail' | 'warning' | 'na'
  detail: string
  weight: number
  earned: number
  remediation?: string
}

export interface AuditListItem {
  id: number
  device_id: number
  device_hostname: string
  score: number
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  status: string
  error?: string
  findings_count: number
  failed_count: number
  warning_count: number
  created_at: string
}

export interface AuditDetail extends AuditListItem {
  findings: AuditFinding[]
}

// T8.4 — built-in rule registry tipi (backend services/security_audit_service.py
// BUILTIN_RULES dict shape'i).
export interface BuiltinRule {
  id: string
  name: string
  category: string
  weight: number
  platforms: string[]
  desc: string
}

export interface ComplianceProfile {
  id: number
  name: string
  description?: string | null
  enabled_rule_ids: string[]
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface ProfilePayload {
  name: string
  description?: string | null
  enabled_rule_ids: string[]
  is_default: boolean
}

export interface AuditStats {
  total: number
  avg_score: number
  grades: Record<string, number>
  critical_count: number
}

export const securityAuditApi = {
  stats: (params?: { site?: string }) =>
    client.get<AuditStats>('/security-audit/stats', { params }).then((r) => r.data),

  list: (params?: { search?: string; grade?: string; page?: number; page_size?: number; site?: string }) =>
    client
      .get<{ total: number; items: AuditListItem[] }>('/security-audit/', { params })
      .then((r) => r.data),

  detail: (id: number) =>
    client.get<AuditDetail>(`/security-audit/${id}`).then((r) => r.data),

  deviceHistory: (deviceId: number) =>
    client
      .get<{ id: number; score: number; grade: string; status: string; created_at: string }[]>(
        `/security-audit/device/${deviceId}/history`,
      )
      .then((r) => r.data),

  run: (deviceIds?: number[], profileId?: number | null) =>
    client
      .post<{
        task_id: number
        device_count: number
        profile_id?: number | null
        profile_name?: string | null
        rule_count?: number | null
      }>('/security-audit/run', {
        device_ids: deviceIds ?? null,
        profile_id: profileId ?? null,
      })
      .then((r) => r.data),

  // T8.4 — Parametrik uyumluluk
  listRules: () =>
    client.get<{ rules: BuiltinRule[]; total: number }>('/security-audit/rules').then((r) => r.data),

  listProfiles: () =>
    client.get<ComplianceProfile[]>('/security-audit/profiles').then((r) => r.data),

  createProfile: (data: ProfilePayload) =>
    client.post<{ id: number; name: string; is_default: boolean }>('/security-audit/profiles', data).then((r) => r.data),

  updateProfile: (id: number, data: ProfilePayload) =>
    client.put<{ id: number; name: string }>(`/security-audit/profiles/${id}`, data).then((r) => r.data),

  deleteProfile: (id: number) =>
    client.delete(`/security-audit/profiles/${id}`),

  fleetTrend: (days = 30, site?: string) =>
    client
      .get<{ date: string; avg_score: number | null; min_score: number; max_score: number; scan_count: number }[]>(
        '/security-audit/fleet-trend',
        { params: { days, ...(site ? { site } : {}) } },
      )
      .then((r) => r.data),

  downloadCsv: (site?: string) =>
    client.get('/security-audit/export.csv', { params: site ? { site } : {}, responseType: 'blob' })
      .then((res) => {
        const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }))
        const a = document.createElement('a')
        a.href = url
        a.download = `security_audit_${new Date().toISOString().slice(0, 10)}.csv`
        document.body.appendChild(a); a.click(); document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }),
}
