import { useEffect, useRef } from 'react'
import { notification } from 'antd'
import { useQueryClient } from '@tanstack/react-query'

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
 * with live progress. Closes and updates notification when task finishes.
 */
export function useTaskProgress(taskId: number | null, options?: {
  title?: string
  onDone?: () => void
  invalidateKeys?: string[][]
}) {
  const qc = useQueryClient()
  const wsRef = useRef<WebSocket | null>(null)
  const notifKey = `task-progress-${taskId}`

  useEffect(() => {
    if (!taskId) return

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const host = window.location.hostname
    const port = import.meta.env.DEV ? '8000' : window.location.port
    const url = `${proto}://${host}:${port}/api/v1/ws/tasks/${taskId}`

    notification.open({
      key: notifKey,
      message: options?.title || `Görev #${taskId} çalışıyor`,
      description: 'Başlatılıyor...',
      duration: 0,
      placement: 'bottomRight',
    })

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onmessage = (e) => {
      try {
        const msg: ProgressMsg = JSON.parse(e.data)
        const isDone = ['success', 'partial', 'failed', 'cancelled'].includes(msg.status)

        const desc = msg.error
          ? `Hata: ${msg.error}`
          : `Tamamlanan: ${msg.completed}  Başarısız: ${msg.failed}${msg.depth !== undefined ? `  Derinlik: ${msg.depth}` : ''}${msg.ip ? `  — ${msg.ip}` : ''}`

        notification.open({
          key: notifKey,
          message: options?.title || `Görev #${taskId}`,
          description: desc,
          duration: isDone ? 5 : 0,
          type: isDone
            ? msg.status === 'success' ? 'success' : msg.status === 'partial' ? 'warning' : 'error'
            : undefined,
          placement: 'bottomRight',
        })

        if (isDone) {
          ws.close()
          options?.invalidateKeys?.forEach((key) => qc.invalidateQueries({ queryKey: key }))
          options?.onDone?.()
        }
      } catch { /* ignore */ }
    }

    ws.onerror = () => {
      notification.open({
        key: notifKey,
        message: options?.title || `Görev #${taskId}`,
        description: 'WebSocket bağlantısı kesildi',
        type: 'warning',
        duration: 4,
        placement: 'bottomRight',
      })
    }

    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [taskId])
}
