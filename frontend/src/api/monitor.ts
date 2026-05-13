import client from './client'

export interface NetworkEvent {
  id: number
  device_id: number | null
  device_hostname: string | null
  event_type: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  message: string | null
  details: Record<string, unknown> | null
  acknowledged: boolean
  created_at: string
}

export interface MonitorStats {
  health_score: number
  devices: { total: number; online: number; offline: number; unknown: number }
  events_24h: {
    total: number
    by_severity: Record<string, number>
    by_type: Record<string, number>
    unacknowledged: number
  }
  backups: { never: number; stale_7d: number }
  topology: { nodes: number; links: number }
  fleet_experience_score: number | null
  fleet_availability_24h: number | null
}

export const monitorApi = {
  getStats: (params?: { site?: string }) =>
    client.get<MonitorStats>('/monitor/stats', { params }).then((r) => r.data),

  getEvents: (params?: {
    skip?: number; limit?: number; severity?: string
    event_type?: string; device_id?: number; hours?: number; unacked_only?: boolean; site?: string
  }) =>
    client.get<{ total: number; items: NetworkEvent[] }>('/monitor/events', { params }).then((r) => r.data),

  getTimeline: (hours = 24) =>
    client.get<{ timeline: { time: string; critical: number; warning: number; info: number }[] }>(
      '/monitor/events/timeline', { params: { hours } }
    ).then((r) => r.data),

  acknowledge: (id: number) =>
    client.post(`/monitor/events/${id}/acknowledge`).then((r) => r.data),

  acknowledgeAll: () =>
    client.post('/monitor/events/acknowledge-all').then((r) => r.data),

  triggerScan: () =>
    client.post<{ queued: boolean; device_count: number }>('/monitor/scan').then((r) => r.data),

  purgeNoise: (olderThanHours = 1) =>
    client.post<{ deleted: number; event_types: string[] }>(
      '/monitor/events/purge-noise', null, { params: { older_than_hours: olderThanHours } }
    ).then((r) => r.data),

  exportEvents: async (params?: {
    severity?: string; event_type?: string; device_id?: number
    hours?: number; unacked_only?: boolean; site?: string
  }) => {
    const res = await client.get('/monitor/events/export.csv', {
      params,
      responseType: 'blob',
    })
    const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    const now = new Date()
    a.download = `events_${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  },
}
