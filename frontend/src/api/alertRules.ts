import client from './client'

export interface AlertRule {
  id: number
  name: string
  device_id: number | null
  if_name_pattern: string | null
  metric: 'in_util_pct' | 'out_util_pct' | 'max_util_pct' | 'error_rate'
  threshold_value: number
  consecutive_count: number
  severity: 'warning' | 'critical'
  cooldown_minutes: number
  enabled: boolean
  created_by: number | null
  created_at: string
}

export type AlertRulePayload = Omit<AlertRule, 'id' | 'created_by' | 'created_at'>

export const alertRulesApi = {
  list: () => client.get<AlertRule[]>('/alert-rules').then((r) => r.data),
  create: (data: AlertRulePayload) => client.post<AlertRule>('/alert-rules', data).then((r) => r.data),
  update: (id: number, data: Partial<AlertRulePayload>) =>
    client.patch<AlertRule>(`/alert-rules/${id}`, data).then((r) => r.data),
  delete: (id: number) => client.delete(`/alert-rules/${id}`),
}

export const METRIC_OPTIONS = [
  { label: 'Maks. Utilization (In veya Out)', value: 'max_util_pct' },
  { label: 'Giriş Utilization (In)', value: 'in_util_pct' },
  { label: 'Çıkış Utilization (Out)', value: 'out_util_pct' },
  { label: 'Hata Oranı (errors/dk)', value: 'error_rate' },
]

export const SEVERITY_OPTIONS = [
  { label: 'Uyarı', value: 'warning' },
  { label: 'Kritik', value: 'critical' },
]
