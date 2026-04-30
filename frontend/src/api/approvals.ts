import client from './client'

export interface ApprovalRequest {
  id: number
  device_id: number
  device_hostname: string
  command: string
  risk_level: 'medium' | 'high'
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'cancelled' | 'expired'
  requester_username: string
  reviewer_username?: string
  review_note?: string
  result_success?: boolean
  result_output?: string
  result_error?: string
  created_at: string
  expires_at: string
  reviewed_at?: string
  executed_at?: string
}

export const approvalsApi = {
  list: (params?: { status?: string; skip?: number; limit?: number }) =>
    client.get<{ total: number; items: ApprovalRequest[] }>('/approvals', { params }).then((r) => r.data),

  pendingCount: () =>
    client.get<{ count: number }>('/approvals/pending-count').then((r) => r.data),

  get: (id: number) =>
    client.get<ApprovalRequest>(`/approvals/${id}`).then((r) => r.data),

  approve: (id: number, note?: string) =>
    client.post<ApprovalRequest>(`/approvals/${id}/approve`, { note }).then((r) => r.data),

  reject: (id: number, note?: string) =>
    client.post<ApprovalRequest>(`/approvals/${id}/reject`, { note }).then((r) => r.data),

  cancel: (id: number) =>
    client.post<ApprovalRequest>(`/approvals/${id}/cancel`).then((r) => r.data),
}
