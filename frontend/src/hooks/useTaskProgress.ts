import { useRef } from 'react'
import { notification } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { buildWsUrl } from '@/utils/ws'
import { useReconnectingWebSocket } from '@/utils/useReconnectingWebSocket'

interface ProgressMsg {
  task_id: number
  completed: number
  failed: number
  status: string
  depth?: number
  ip?: string
  found?: number
  error?: string
}

/**
 * Opens a WebSocket to /api/v1/ws/tasks/{taskId} and shows an antd notification
 * with live progress. Automatically reconnects with exponential backoff + jitter
 * if the connection drops mid-task (e.g. backend restart).
 */
export function useTaskProgress(taskId: number | null, options?: {
  title?: string
  onDone?: () => void
  invalidateKeys?: string[][]
}) {
  const qc = useQueryClient()
  const notifKey = `task-progress-${taskId}`
  const doneRef = useRef(false)

  const url = taskId ? buildWsUrl(`/api/v1/ws/tasks/${taskId}`) : null

  useReconnectingWebSocket(url, {
    maxAttempts: 10,
    baseDelayMs: 1000,
    maxDelayMs: 20_000,

    onOpen() {
      if (doneRef.current) return
      notification.open({
        key: notifKey,
        message: options?.title || `Görev #${taskId} çalışıyor`,
        description: 'Başlatılıyor...',
        duration: 0,
        placement: 'bottomRight',
      })
    },

    onMessage(e) {
      try {
        const msg: ProgressMsg = JSON.parse(e.data)
        const isDone = ['success', 'partial', 'failed', 'cancelled'].includes(msg.status)

        const desc = msg.error
          ? `Hata: ${msg.error}`
          : `Tamamlanan: ${msg.completed}  Başarısız: ${msg.failed}${
              msg.depth !== undefined ? `  Derinlik: ${msg.depth}` : ''
            }${msg.ip ? `  — ${msg.ip}` : ''}`

        notification.open({
          key: notifKey,
          message: options?.title || `Görev #${taskId}`,
          description: desc,
          duration: isDone ? 5 : 0,
          type: isDone
            ? msg.status === 'success' ? 'success'
              : msg.status === 'partial' ? 'warning'
              : 'error'
            : undefined,
          placement: 'bottomRight',
        })

        if (isDone) {
          doneRef.current = true
          options?.invalidateKeys?.forEach((key) => qc.invalidateQueries({ queryKey: key }))
          options?.onDone?.()
        }
      } catch { /* ignore malformed frames */ }
    },

    onReconnecting(attempt, delayMs) {
      if (doneRef.current) return
      notification.open({
        key: notifKey,
        message: options?.title || `Görev #${taskId}`,
        description: `Bağlantı kesildi — yeniden bağlanıyor (${attempt}/10, ${Math.round(delayMs / 1000)}s)`,
        type: 'warning',
        duration: 0,
        placement: 'bottomRight',
      })
    },

    onFailed() {
      notification.open({
        key: notifKey,
        message: options?.title || `Görev #${taskId}`,
        description: 'Bağlantı kesildi — görevi API üzerinden kontrol edin',
        type: 'error',
        duration: 8,
        placement: 'bottomRight',
      })
    },
  })
}
