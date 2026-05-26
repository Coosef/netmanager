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

  /** PoE enable/disable + safety rollback */
  setPoe: (device_id: number, interface_name: string, enable: boolean,
           rollback_after_sec = 300, reason?: string) =>
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
}
