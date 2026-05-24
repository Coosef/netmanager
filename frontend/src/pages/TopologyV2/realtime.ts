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
 *
 * T8.2 — the framework-free pieces of this contract (`wsPathForLocation`,
 * `isTopologyFrame`, `nextBackoffDelay`) are exported as pure helpers
 * so the WebSocket-bound hook stays thin and the behaviour is unit
 * testable without a DOM / WS mock harness.
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
  /** T4.4 — fired the first frame after the event rate crosses the
   *  threshold (`rateMeter` defaults to 200 ev/s over 2 s). Caller can
   *  flip `enabled=false` to fall back to polling; the hook tears the
   *  socket down on the next render. Fires at most once per crossing —
   *  reset when `enabled` toggles. */
  onBackpressure?: (rate: number) => void
}

const BACKOFF_MS = [2000, 4000, 8000, 15000]

// ── Pure helpers (T8.2 — unit testable) ──────────────────────────────────

/**
 * Resolve the WS path for a given active location.
 *   - `null`            → org-wide  → `/api/v1/ws/events`
 *   - non-null number   → narrowed  → `/api/v1/ws/events?location=<id>`
 *
 * A location change yields a different path; the hook tears down the old
 * socket and connects a fresh one — old-location frames stop arriving.
 */
export function wsPathForLocation(locationId: number | null): string {
  return locationId != null
    ? `/api/v1/ws/events?location=${locationId}`
    : '/api/v1/ws/events'
}

/**
 * Type-guard for an arbitrary WS frame — narrows to `TopologyEvent` if the
 * payload looks like a topology event. Used by the hook to skip non-
 * topology frames the same socket may deliver (alarms, heartbeats, etc.).
 */
export function isTopologyFrame(frame: unknown): frame is TopologyEvent {
  if (typeof frame !== 'object' || frame === null) return false
  const f = frame as Record<string, unknown>
  return typeof f.event_type === 'string' && f.event_type.startsWith('topology_')
}

/**
 * Exponential-with-cap backoff delay for the n-th reconnect attempt
 * (n=0 is the first retry). The schedule is `[2s, 4s, 8s, 15s, 15s, …]` —
 * never longer than 15 s so a transient network blip doesn't lock the
 * UI out of live updates for minutes.
 */
export function nextBackoffDelay(retryCount: number): number {
  const idx = Math.max(0, Math.min(retryCount, BACKOFF_MS.length - 1))
  return BACKOFF_MS[idx]
}

/**
 * T4.4 — rate meter for backpressure detection. Keeps a sliding window
 * of event timestamps; `record(now)` returns the current rate (events
 * per second over the window). Pure helper, no React, easy to unit-test.
 *
 * Defaults match the plan: 2 s window, 200 ev/s threshold = 400 events
 * inside the window triggers backpressure. Once tripped, callers should
 * cancel the WS and fall back to polling; the meter keeps measuring so
 * the caller can detect the recovery window (rate dropping below the
 * threshold) and re-enable the live channel.
 */
export class RateMeter {
  private samples: number[] = []
  constructor(
    public readonly windowMs: number = 2000,
    public readonly thresholdEventsPerSec: number = 200,
  ) {}

  /** Record a new event and return the current rate (events/sec). */
  record(now: number): number {
    this.samples.push(now)
    const cutoff = now - this.windowMs
    // Cheap trim from the front — events are appended in monotonic order.
    while (this.samples.length > 0 && this.samples[0] < cutoff) {
      this.samples.shift()
    }
    return this.rate(now)
  }

  /** Current rate without recording a new event (read-only). */
  rate(now: number): number {
    const cutoff = now - this.windowMs
    let count = 0
    for (let i = this.samples.length - 1; i >= 0; i--) {
      if (this.samples[i] < cutoff) break
      count++
    }
    return count / (this.windowMs / 1000)
  }

  /** True when the current rate is at or above the trip threshold. */
  isOverThreshold(now: number): boolean {
    return this.rate(now) >= this.thresholdEventsPerSec
  }

  /** Reset the meter (e.g. after a teardown / location switch). */
  reset(): void {
    this.samples.length = 0
  }
}

export function useTopologyRealtime({
  enabled, locationId, onEvent, onReconnect, onBackpressure,
}: Options) {
  const [status, setStatus] = useState<RealtimeStatus>('closed')
  const onEventRef = useRef(onEvent)
  const onReconnectRef = useRef(onReconnect)
  const onBackpressureRef = useRef(onBackpressure)
  onEventRef.current = onEvent
  onReconnectRef.current = onReconnect
  onBackpressureRef.current = onBackpressure

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
    // T4.4 — local meter + tripped flag so the callback fires AT MOST
    // ONCE per crossing (caller toggles enabled=false to fully recover).
    const meter = new RateMeter()
    let tripped = false

    const path = wsPathForLocation(locationId)

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
        let frame: unknown
        try {
          frame = JSON.parse(e.data as string)
        } catch {
          return
        }
        if (isTopologyFrame(frame)) {
          // T4.4 backpressure check BEFORE dispatch so the caller can
          // decide to flip enabled→false; the in-flight frame still
          // reaches them (we'd lose state otherwise).
          const rate = meter.record(Date.now())
          if (!tripped && rate >= meter.thresholdEventsPerSec) {
            tripped = true
            onBackpressureRef.current?.(rate)
          }
          onEventRef.current(frame)
        }
      }
      ws.onerror = () => ws?.close()
      ws.onclose = () => {
        if (destroyed) return
        setStatus('closed')
        const delay = nextBackoffDelay(retry)
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
