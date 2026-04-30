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

  run: (deviceIds?: number[]) =>
    client
      .post<{ task_id: number; device_count: number }>('/security-audit/run', {
        device_ids: deviceIds ?? null,
      })
      .then((r) => r.data),

  fleetTrend: (days = 30, site?: string) =>
    client
      .get<{ date: string; avg_score: number | null; min_score: number; max_score: number; scan_count: number }[]>(
        '/security-audit/fleet-trend',
        { params: { days, ...(site ? { site } : {}) } },
      )
      .then((r) => r.data),
}
