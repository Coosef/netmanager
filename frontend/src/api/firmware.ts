import client from './client'

// T9 Tur 8 — Firmware management

export type FirmwareSeverity = 'maintenance' | 'major' | 'critical_cve'
export type FirmwareSource = 'uploaded' | 'url'
export type InstallStatus =
  | 'pending' | 'transferring' | 'transferred' | 'awaiting_reload'
  | 'reloading' | 'verifying' | 'success' | 'failed' | 'cancelled'
export type TransferMethod = 'scp' | 'tftp' | 'agent'

export interface FirmwareArtifact {
  id: number
  name: string
  version: string
  vendor: string
  os_type: string
  model: string | null
  source_type: FirmwareSource
  file_path: string | null
  source_url: string | null
  file_size_bytes: number | null
  sha256: string | null
  checksum_verified: boolean
  release_notes_url: string | null
  release_date: string | null
  severity: FirmwareSeverity
  install_commands: Record<string, unknown> | null
  notes: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface FirmwareJobLog {
  ts: string
  stage: string
  message: string
  level?: string
}

export interface FirmwareInstallJob {
  id: number
  artifact_id: number
  device_id: number
  status: InstallStatus
  transfer_method: TransferMethod
  pre_version: string | null
  post_version: string | null
  reload_required: boolean
  reload_approved: boolean
  reload_approved_by: number | null
  reload_approved_at: string | null
  error: string | null
  log: FirmwareJobLog[]
  celery_task_id: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export const firmwareApi = {
  listArtifacts: (params?: { vendor?: string; os_type?: string }) =>
    client.get<FirmwareArtifact[]>('/firmware/artifacts', { params }).then((r) => r.data),
  createUrlArtifact: (data: {
    name: string; version: string; vendor: string; os_type: string
    model?: string | null; source_url: string; release_notes_url?: string | null
    release_date?: string | null; severity: FirmwareSeverity
    install_commands?: Record<string, unknown> | null
    sha256?: string | null; notes?: string | null
  }) =>
    client.post<FirmwareArtifact>('/firmware/artifacts', data).then((r) => r.data),
  uploadArtifact: (form: FormData) =>
    client.post<FirmwareArtifact>('/firmware/artifacts/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data),
  updateArtifact: (id: number, data: Partial<FirmwareArtifact>) =>
    client.patch<FirmwareArtifact>(`/firmware/artifacts/${id}`, data).then((r) => r.data),
  deleteArtifact: (id: number) => client.delete(`/firmware/artifacts/${id}`),

  startInstall: (artifact_id: number, device_id: number,
                 transfer_method: TransferMethod = 'scp', reload_required = true) =>
    client.post<FirmwareInstallJob>('/firmware/install', {
      artifact_id, device_id, transfer_method, reload_required,
    }).then((r) => r.data),
  listJobs: (params?: { status?: InstallStatus; device_id?: number; limit?: number }) =>
    client.get<FirmwareInstallJob[]>('/firmware/jobs', { params }).then((r) => r.data),
  getJob: (id: number) =>
    client.get<FirmwareInstallJob>(`/firmware/jobs/${id}`).then((r) => r.data),
  approveReload: (id: number) =>
    client.post<FirmwareInstallJob>(`/firmware/jobs/${id}/approve-reload`, { confirm: true })
      .then((r) => r.data),
  cancelJob: (id: number) =>
    client.post<FirmwareInstallJob>(`/firmware/jobs/${id}/cancel`).then((r) => r.data),
}
