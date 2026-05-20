import { useMemo, useRef, useState } from 'react'
import { useSite } from '@/contexts/SiteContext'
import { buildWsUrl } from '@/utils/ws'
import { useReconnectingWebSocket } from '@/utils/useReconnectingWebSocket'

/**
 * Faz 8 Phase F — the `/ws/events` path for a given active location.
 *
 * Pure (no React) so it can be unit-tested. When a location is active
 * the path carries `?location=<id>`; the backend (Phase E) validates it
 * against user_locations and only delivers that location's frames. A
 * null active location (org-wide "all locations") sends no param.
 */
export function eventStreamPath(activeLocationId: number | null): string {
  return activeLocationId != null
    ? `/api/v1/ws/events?location=${activeLocationId}`
    : '/api/v1/ws/events'
}

interface EventStreamOptions {
  onEvent?: (data: any) => void
  /** Set false to suspend the stream (default: enabled). */
  enabled?: boolean
}

/**
 * Faz 8 Phase F — subscribe to the live `/ws/events` stream, bound to the
 * active location.
 *
 * The socket URL embeds the active location id. When the user switches
 * location the URL changes, so the underlying reconnecting socket tears
 * the old connection down and rebinds to the new location — old-location
 * frames stop arriving immediately and cannot be displayed under the new
 * location. The backend additionally re-validates scope and filters
 * every frame, so a stale/forged client never receives foreign events.
 */
export function useEventStream(opts: EventStreamOptions = {}) {
  const { activeLocationId } = useSite()
  const [connected, setConnected] = useState(false)
  // Keep the latest handler without forcing the socket to reconnect.
  const onEventRef = useRef(opts.onEvent)
  onEventRef.current = opts.onEvent

  const path = eventStreamPath(activeLocationId)
  const url = useMemo(
    () => (opts.enabled === false ? null : buildWsUrl(path)),
    [path, opts.enabled],
  )

  useReconnectingWebSocket(url, {
    onOpen: () => setConnected(true),
    onReconnecting: () => setConnected(false),
    onFailed: () => setConnected(false),
    onClose: () => setConnected(false),
    onMessage: (e) => {
      try {
        onEventRef.current?.(JSON.parse(e.data))
      } catch {
        /* ignore malformed frame */
      }
    },
  })

  return { connected }
}
