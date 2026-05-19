/**
 * Realtime topology stream — subscribes to the per-organization
 * `/ws/events` channel and surfaces `topology_*` frames.
 *
 * Isolation: the socket carries only the bearer token; the backend
 * derives the organization from it and (T0/6d) only ever pushes that
 * org's channel. `?location=` narrows the stream to the active location.
 * The client never sends an org id.
 *
 * On reconnect the client cannot know which events it missed, so it
 * fires `onReconnect` — the caller refetches and resyncs by graph_version.
 */
import { useEffect, useRef, useState } from 'react'
import { buildWsUrl } from '@/utils/ws'
import type { TopologyEvent } from './patch'

export type RealtimeStatus = 'connecting' | 'open' | 'closed'

interface Options {
  enabled: boolean
  locationId: number | null
  onEvent: (event: TopologyEvent) => void
  /** Fired when the socket re-opens after a drop — caller should resync. */
  onReconnect: () => void
}

const BACKOFF_MS = [2000, 4000, 8000, 15000]

export function useTopologyRealtime({ enabled, locationId, onEvent, onReconnect }: Options) {
  const [status, setStatus] = useState<RealtimeStatus>('closed')
  const onEventRef = useRef(onEvent)
  const onReconnectRef = useRef(onReconnect)
  onEventRef.current = onEvent
  onReconnectRef.current = onReconnect

  useEffect(() => {
    if (!enabled) {
      setStatus('closed')
      return
    }
    let destroyed = false
    let ws: WebSocket | null = null
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let everOpened = false

    const path = locationId != null
      ? `/api/v1/ws/events?location=${locationId}`
      : '/api/v1/ws/events'

    const connect = () => {
      if (destroyed) return
      setStatus('connecting')
      ws = new WebSocket(buildWsUrl(path))

      ws.onopen = () => {
        if (destroyed) return
        setStatus('open')
        retry = 0
        if (everOpened) onReconnectRef.current() // missed events ⇒ resync
        everOpened = true
      }
      ws.onmessage = (e) => {
        let frame: TopologyEvent
        try {
          frame = JSON.parse(e.data as string)
        } catch {
          return
        }
        if (typeof frame.event_type === 'string' && frame.event_type.startsWith('topology_')) {
          onEventRef.current(frame)
        }
      }
      ws.onerror = () => ws?.close()
      ws.onclose = () => {
        if (destroyed) return
        setStatus('closed')
        const delay = BACKOFF_MS[Math.min(retry, BACKOFF_MS.length - 1)]
        retry++
        timer = setTimeout(connect, delay)
      }
    }
    connect()

    return () => {
      destroyed = true
      if (timer) clearTimeout(timer)
      if (ws) {
        ws.onclose = null // suppress the reconnect on intentional teardown
        ws.close()
      }
      setStatus('closed')
    }
  }, [enabled, locationId])

  return { status }
}
