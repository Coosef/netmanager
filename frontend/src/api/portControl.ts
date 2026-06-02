import client from './client'

export interface PortChangeRecord {
  id: number
  device_id: number
  interface: string
  change_type: 'admin' | 'poe'
  requested_state: string  // 'up'/'down' (admin) | 'on'/'off' (poe)
  forward_cmds: string[]
  rollback_cmds: string[]
  status: 'pending' | 'committed' | 'rolled_back' | 'failed'
  apply_at: string | null
  rollback_at: string | null
  completed_at: string | null
  forward_output: string
  rollback_output: string
}

export const portControlApi = {
  /** T9 Tur 4 #8 — Port admin status (up/down) toggle.
   *  rollback_after_sec: 0 → kalıcı; >0 → bu saniyeden sonra otomatik geri al. */
  setAdmin: (device_id: number, interface_name: string, enable: boolean,
             rollback_after_sec = 300, reason?: string) =>
    client.post<PortChangeRecord>(
      `/devices/${device_id}/ports/${encodeURIComponent(interface_name)}/admin`,
      { enable, rollback_after_sec, ...(reason ? { reason } : {}) },
    ).then((r) => r.data),

  /** PoE enable/disable. W3.3 hotfix: rollback_after_sec default=0 (kalıcı).
   *  Restart için fail-safe 300 ayrı endpoint (restartPoe). */
  setPoe: (device_id: number, interface_name: string, enable: boolean,
           rollback_after_sec = 0, reason?: string) =>
    client.post<PortChangeRecord>(
      `/devices/${device_id}/ports/${encodeURIComponent(interface_name)}/poe`,
      { enable, rollback_after_sec, ...(reason ? { reason } : {}) },
    ).then((r) => r.data),

  /** Bekleyen değişikliği onayla (rollback iptal) */
  commit: (device_id: number, rollback_id: number) =>
    client.post<PortChangeRecord>(
      `/devices/${device_id}/ports/_rollback/${rollback_id}/commit`,
    ).then((r) => r.data),

  /** Bekleyen değişikliği şimdi geri al */
  cancel: (device_id: number, rollback_id: number) =>
    client.post<PortChangeRecord>(
      `/devices/${device_id}/ports/_rollback/${rollback_id}/cancel`,
    ).then((r) => r.data),

  /** Son 50 port-change kaydı */
  listRollbacks: (device_id: number) =>
    client.get<{ items: PortChangeRecord[] }>(
      `/devices/${device_id}/ports/_rollbacks`,
    ).then((r) => r.data),

  /** W3.3 — Tek port PoE restart: disable → wait → enable */
  restartPoe: (
    device_id: number, interface_name: string,
    restart_wait_sec = 0, rollback_after_sec = 300, reason?: string,
  ) =>
    client.post<PortChangeRecord>(
      `/devices/${device_id}/ports/${encodeURIComponent(interface_name)}/poe/restart`,
      { restart_wait_sec, rollback_after_sec, ...(reason ? { reason } : {}) },
    ).then((r) => r.data),

  /** W3.3 — Toplu PoE: on/off/restart, tek SSH session, skip+failed sayaç */
  bulkPoe: (
    device_id: number,
    interfaces: string[],
    action: 'on' | 'off' | 'restart',
    opts: {
      restart_wait_sec?: number
      rollback_after_sec?: number
      reason?: string
    } = {},
  ) =>
    client.post<BulkPoeResult>(
      `/devices/${device_id}/ports/bulk-poe`,
      {
        interfaces, action,
        restart_wait_sec: opts.restart_wait_sec ?? 0,
        // W3.3 hotfix — explicit verilmezse backend action-aware default uygular
        // (on/off → 0 kalıcı, restart → 300 fail-safe).
        ...(opts.rollback_after_sec !== undefined
          ? { rollback_after_sec: opts.rollback_after_sec }
          : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
    ).then((r) => r.data),
}

export interface BulkPoeItem {
  interface: string
  status: 'success' | 'skipped' | 'failed'
  reason?: string
  error?: string
  rollback_id?: number | null
}

export interface BulkPoeResult {
  batch_id: string
  total: number
  ok: number
  skipped: number
  failed: number
  items: BulkPoeItem[]
}
