import { useEffect, useRef } from 'react'
import { App } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useLocation } from 'react-router-dom'
import { monitorApi } from '@/api/monitor'

const SEV_ICON: Record<string, string> = {
  critical: '🔴',
  warning:  '🟡',
  info:     '🔵',
}

// Runs globally (inside AppLayout) — shows corner toasts for new alarms
// on any page, not just /monitor.
export function useAlarmWatcher() {
  const { notification } = App.useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const seenRef = useRef<Set<number>>(new Set())
  const seededRef = useRef(false)

  const { data } = useQuery({
    queryKey: ['alarm-watcher-poll'],
    queryFn: () => monitorApi.getEvents({ limit: 20, hours: 2, unacked_only: true }),
    refetchInterval: 60_000,
    staleTime: 0,
    gcTime: 0,
  })

  useEffect(() => {
    if (!data?.items) return

    // First fetch: seed known IDs without toasting — these are "already there"
    if (!seededRef.current) {
      data.items.forEach((ev) => seenRef.current.add(ev.id))
      seededRef.current = true
      return
    }

    // Subsequent polls: toast only genuinely new events
    let shown = 0
    for (const ev of data.items) {
      if (seenRef.current.has(ev.id)) continue
      seenRef.current.add(ev.id)

      // skip info-level; also skip if we're already on /monitor (it handles its own UI)
      if (ev.severity === 'info') continue
      if (location.pathname === '/monitor') continue
      if (shown >= 3) break

      shown++
      notification.open({
        key: `alarm-${ev.id}`,
        type: ev.severity === 'critical' ? 'error' : 'warning',
        message: `${SEV_ICON[ev.severity] ?? ''} ${ev.title}`,
        description: ev.device_hostname ? `Cihaz: ${ev.device_hostname}` : undefined,
        duration: ev.severity === 'critical' ? 0 : 10,
        placement: 'bottomRight',
        style: { cursor: 'pointer' },
        onClick: () => navigate('/monitor'),
      })
    }
  }, [data, location.pathname, navigate, notification])
}
