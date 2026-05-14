import { useEffect, useRef, useCallback } from 'react'

export type WsState = 'connecting' | 'open' | 'reconnecting' | 'failed' | 'closed'

interface Options {
  maxAttempts?: number    // default 10; 0 = infinite
  baseDelayMs?: number    // default 1000
  maxDelayMs?: number     // default 30000
  onMessage?: (e: MessageEvent) => void
  onOpen?: () => void
  onClose?: () => void
  onReconnecting?: (attempt: number, delayMs: number) => void
  onFailed?: () => void
}

/**
 * Opens a WebSocket with automatic exponential-backoff reconnect + jitter.
 *
 * Reconnect delay = min(baseDelay * 2^attempt, maxDelay) + rand(0, baseDelay)
 * This prevents thundering-herd storms when many clients reconnect simultaneously.
 *
 * Returns a close() callback. The WebSocket closes permanently only when:
 *   - close() is called explicitly, OR
 *   - maxAttempts is exhausted (onFailed fires, then state → 'failed')
 */
export function useReconnectingWebSocket(url: string | null, options: Options = {}) {
  const {
    maxAttempts = 10,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    onMessage,
    onOpen,
    onClose,
    onReconnecting,
    onFailed,
  } = options

  const wsRef = useRef<WebSocket | null>(null)
  const attemptsRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closedRef = useRef(false)   // true = explicit close requested, no reconnect

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const connect = useCallback(() => {
    if (!url || closedRef.current) return

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      attemptsRef.current = 0
      onOpen?.()
    }

    ws.onmessage = (e) => {
      onMessage?.(e)
    }

    ws.onclose = (_e) => {
      if (closedRef.current) {
        onClose?.()
        return
      }

      const attempt = ++attemptsRef.current
      if (maxAttempts > 0 && attempt > maxAttempts) {
        onFailed?.()
        return
      }

      const expDelay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs)
      const jitter = Math.random() * baseDelayMs
      const delay = Math.round(expDelay + jitter)

      onReconnecting?.(attempt, delay)
      timerRef.current = setTimeout(connect, delay)
    }

    ws.onerror = () => {
      // onclose fires right after onerror; reconnect logic lives there
    }
  }, [url, maxAttempts, baseDelayMs, maxDelayMs, onOpen, onMessage, onClose, onReconnecting, onFailed])

  const close = useCallback(() => {
    closedRef.current = true
    clearTimer()
    wsRef.current?.close()
    wsRef.current = null
  }, [])

  useEffect(() => {
    if (!url) return
    closedRef.current = false
    attemptsRef.current = 0
    connect()
    return () => {
      closedRef.current = true
      clearTimer()
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [url])

  return { close }
}
