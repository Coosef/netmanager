import client from './client'

export type WebhookType = 'slack' | 'jira' | 'generic'

export interface EscalationRule {
  id: number
  name: string
  enabled: boolean
  description: string | null
  match_severity: string[] | null
  match_event_types: string[] | null
  match_sources: string[] | null
  min_duration_secs: number | null
  match_states: string[] | null
  webhook_type: WebhookType
  webhook_url: string
  webhook_header_keys: string[]
  cooldown_secs: number
  created_at: string
  created_by: number | null
}

export interface EscalationRulePayload {
  name: string
  enabled?: boolean
  description?: string | null
  match_severity?: string[] | null
  match_event_types?: string[] | null
  match_sources?: string[] | null
  min_duration_secs?: number | null
  match_states?: string[] | null
  webhook_type: WebhookType
  webhook_url: string
  webhook_headers?: Record<string, string> | null
  cooldown_secs?: number
}

export interface NotificationLog {
  id: number
  rule_id: number
  incident_id: number
  channel: string
  status: 'sent' | 'failed' | 'dry_run'
  response_code: number | null
  error_msg: string | null
  sent_at: string
}

export interface LogListResponse {
  items: NotificationLog[]
  total: number
  offset: number
  limit: number
}

export interface TestResult {
  dry_run: boolean
  incident_id: number | null
  matched: boolean
  success: boolean | null
  response_code: number | null
  error_msg: string | null
}

export const escalationApi = {
  list: () =>
    client.get<EscalationRule[]>('/escalation-rules').then(r => r.data),

  get: (id: number) =>
    client.get<EscalationRule>(`/escalation-rules/${id}`).then(r => r.data),

  create: (data: EscalationRulePayload) =>
    client.post<EscalationRule>('/escalation-rules', data).then(r => r.data),

  update: (id: number, data: Partial<EscalationRulePayload>) =>
    client.put<EscalationRule>(`/escalation-rules/${id}`, data).then(r => r.data),

  delete: (id: number) =>
    client.delete(`/escalation-rules/${id}`),

  test: (id: number, dryRun = true) =>
    client.post<TestResult>(`/escalation-rules/${id}/test`, null, { params: { dry_run: dryRun } }).then(r => r.data),

  getLogs: (params?: { rule_id?: number; incident_id?: number; status?: string; limit?: number; offset?: number }) =>
    client.get<LogListResponse>('/escalation-rules/logs', { params }).then(r => r.data),
}
