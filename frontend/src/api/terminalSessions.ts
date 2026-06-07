import client from './client'

export interface TerminalSessionListItem {
  session_id: string
  user_id: number | null
  username: string | null
  device_id: number | null
  device_hostname: string | null
  device_ip: string | null
  client_ip: string | null
  connection_path: string | null
  started_at: string | null
  ended_at: string | null
  duration_ms: number | null
  exit_reason: string | null
  commands_count: number
  input_bytes: number
  output_bytes: number
  ai_summary_status: string | null
  has_ai_summary: boolean
}

export interface TerminalSessionDetail extends TerminalSessionListItem {
  user_agent: string | null
  agent_id: string | null
  commands_extracted: Array<{ t: number; cmd: string }>
  output_excerpt: string | null
  ai_summary: string | null
}

export interface SessionsListResponse {
  items: TerminalSessionListItem[]
  total: number
  limit: number
  offset: number
}

export interface SessionStats {
  sessions_24h: number
  commands_24h: number
  avg_duration_ms: number
  active_now: number
}

export const terminalSessionsApi = {
  list: (params?: {
    limit?: number; offset?: number;
    user_id?: number; device_id?: number;
    status?: 'active' | 'closed';
    search?: string;
  }) =>
    client.get<SessionsListResponse>('/terminal-sessions', { params }).then((r) => r.data),

  get: (session_id: string) =>
    client.get<TerminalSessionDetail>(`/terminal-sessions/${encodeURIComponent(session_id)}`)
      .then((r) => r.data),

  stats: () =>
    client.get<SessionStats>('/terminal-sessions/_stats').then((r) => r.data),

  /** T9 Tur 3B — AI ile session özetle (manuel trigger).
   *  3-8 saniye sürebilir; ai_summary tamamlanınca response döner. */
  summarize: (session_id: string) =>
    client.post<{
      status: string
      ai_summary?: string
      provider?: string
      model?: string
      tokens_used?: number
    }>(`/terminal-sessions/${encodeURIComponent(session_id)}/summarize`)
      .then((r) => r.data),
}
