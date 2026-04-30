import client from './client'

export type ChannelType = 'email' | 'slack' | 'telegram' | 'teams' | 'webhook' | 'jira'

export type NotifyOn =
  | 'device_offline'
  | 'critical_event'
  | 'warning_event'
  | 'approval_request'
  | 'playbook_failure'
  | 'backup_failure'
  | 'threshold_alert'
  | 'any_event'

export interface EmailConfig {
  smtp_host: string
  smtp_port: number
  smtp_use_tls: boolean
  smtp_username: string
  smtp_password: string
  recipients: string[]
}

export interface SlackConfig {
  webhook_url: string
}

export interface TelegramConfig {
  bot_token: string
  chat_id: string
}

export interface TeamsConfig {
  webhook_url: string
}

export interface WebhookConfig {
  url: string
  headers?: Record<string, string>
}

export interface JiraConfig {
  jira_url: string
  jira_email: string
  jira_api_token: string
  jira_project_key: string
  jira_issue_type?: string
  jira_priority?: string
}

export interface NotificationChannel {
  id: number
  name: string
  type: ChannelType
  config: Partial<EmailConfig & SlackConfig & TelegramConfig & TeamsConfig & WebhookConfig & JiraConfig>
  notify_on: NotifyOn[]
  is_active: boolean
  created_at: string
}

export const notificationsApi = {
  list: () =>
    client.get<{ total: number; items: NotificationChannel[] }>('/notifications').then((r) => r.data),

  create: (data: { name: string; type: ChannelType; config: object; notify_on: NotifyOn[]; is_active?: boolean }) =>
    client.post<NotificationChannel>('/notifications', data).then((r) => r.data),

  update: (id: number, data: Partial<{ name: string; type: ChannelType; config: object; notify_on: NotifyOn[]; is_active: boolean }>) =>
    client.patch<NotificationChannel>(`/notifications/${id}`, data).then((r) => r.data),

  delete: (id: number) =>
    client.delete(`/notifications/${id}`),

  test: (id: number) =>
    client.post<{ success: boolean; error?: string }>(`/notifications/${id}/test`).then((r) => r.data),

  sendWeeklyDigest: () =>
    client.post<{ status: string }>('/notifications/send-weekly-digest').then((r) => r.data),
}

export const NOTIFY_ON_OPTIONS: { label: string; value: NotifyOn }[] = [
  { label: 'Cihaz Çevrimdışı', value: 'device_offline' },
  { label: 'Kritik Olay', value: 'critical_event' },
  { label: 'Uyarı Olayı', value: 'warning_event' },
  { label: 'Onay Talebi', value: 'approval_request' },
  { label: 'Playbook Hatası', value: 'playbook_failure' },
  { label: 'Yedek Hatası', value: 'backup_failure' },
  { label: 'Eşik Uyarısı (SNMP)', value: 'threshold_alert' },
  { label: 'Tüm Olaylar', value: 'any_event' },
]
