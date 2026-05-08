import client from './client'

export interface ReportSummary {
  generated_at: string
  devices: {
    total: number; online: number; offline: number; unknown: number
    by_vendor: Record<string, number>
    backup_ok: number; backup_stale: number; backup_never: number
  }
  events_24h: { total: number; critical: number; warning: number; info: number }
  tasks_7d: { success: number; failed: number; partial: number; total: number }
  topology: { links: number; nodes: number }
}

function _blobDownload(url: string, params: Record<string, unknown>, filename: string) {
  return client.get(url, { params, responseType: 'blob' }).then((res) => {
    const href = URL.createObjectURL(new Blob([res.data]))
    const a = document.createElement('a')
    a.href = href
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(href)
  })
}

export const reportsApi = {
  getSummary: (params?: { site?: string }) =>
    client.get<ReportSummary>('/reports/summary', { params }).then((r) => r.data),

  downloadDevicesCsv: (site?: string) =>
    _blobDownload('/reports/devices', { format: 'csv', ...(site ? { site } : {}) }, 'devices.csv'),

  downloadEventsCsv: (hours = 24) =>
    _blobDownload('/reports/events', { format: 'csv', hours }, `events_${hours}h.csv`),

  downloadBackupsCsv: (site?: string) =>
    _blobDownload('/reports/backups', { format: 'csv', ...(site ? { site } : {}) }, 'backups.csv'),

  downloadFirmwareCsv: (site?: string) =>
    _blobDownload('/reports/firmware', { format: 'csv', ...(site ? { site } : {}) }, 'firmware.csv'),

  downloadBackupsZip: () =>
    _blobDownload('/reports/backups/download-zip', {}, 'configs_backup.zip'),

  getDevices: (params?: { site?: string }) =>
    client.get<{ total: number; items: Record<string, string>[] }>('/reports/devices', { params }).then((r) => r.data),
  getEvents: (hours = 24) =>
    client.get<{ total: number; items: Record<string, string>[]; hours: number }>(
      `/reports/events?hours=${hours}`
    ).then((r) => r.data),
  getBackups: (params?: { site?: string }) =>
    client.get<{ total: number; items: Record<string, string>[] }>('/reports/backups', { params }).then((r) => r.data),

  getFirmware: (params?: { site?: string }) =>
    client.get<{
      total_devices: number
      with_firmware_info: number
      without_firmware_info: number
      unknown_devices: { hostname: string; ip: string; vendor: string }[]
      groups: {
        vendor: string
        firmware_version: string
        is_latest: boolean
        device_count: number
        devices: { id: number; hostname: string; ip: string; status: string }[]
      }[]
    }>('/reports/firmware', { params }).then((r) => r.data),

  getUptime: (days = 7, site?: string) =>
    client.get<{
      total_devices: number
      current_online: number
      current_offline: number
      avg_uptime_pct: number
      daily: { date: string; online: number; offline: number; total: number }[]
      days: number
    }>('/reports/uptime', { params: { days, ...(site ? { site } : {}) } }).then((r) => r.data),

  getProblematicDevices: (days = 7, limit = 25, site?: string) =>
    client.get<{
      days: number
      total: number
      items: {
        device_id: number
        hostname: string
        event_count: number
        critical_count: number
        warning_count: number
        last_event: string | null
        ip_address: string | null
        vendor: string | null
        status: string
        layer: string | null
      }[]
    }>('/reports/problematic-devices', { params: { days, limit, ...(site ? { site } : {}) } }).then((r) => r.data),

  getAgentHealth: () =>
    client.get<{
      total: number
      online: number
      offline: number
      items: {
        id: string
        name: string
        status: string
        last_heartbeat: string | null
        heartbeat_age_s: number | null
        last_ip: string | null
        platform: string | null
        machine_hostname: string | null
        version: string | null
        assigned_devices: number
        cpu_pct: number | null
        mem_pct: number | null
        cmd_success: number
        cmd_fail: number
        avg_latency_ms: number | null
      }[]
    }>('/reports/agent-health').then((r) => r.data),
}
