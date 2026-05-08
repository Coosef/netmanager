import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { buildWsUrl } from '@/utils/ws'

interface SshTerminalProps {
  deviceId: number
  isDark?: boolean
  onClose?: () => void
}

export default function SshTerminal({ deviceId, isDark = true, onClose }: SshTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const resizeObserver = useRef<ResizeObserver | null>(null)

  const sendResize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      theme: isDark
        ? { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff', selectionBackground: '#264f7840' }
        : { background: '#ffffff', foreground: '#24292f', cursor: '#0969da', selectionBackground: '#0969da30' },
      allowTransparency: true,
      scrollback: 2000,
    })
    const fit = new FitAddon()
    const links = new WebLinksAddon()
    term.loadAddon(fit)
    term.loadAddon(links)
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const url = buildWsUrl(`/api/v1/ws/ssh/${deviceId}?cols=${term.cols}&rows=${term.rows}`)
    const ws = new WebSocket(url)
    wsRef.current = ws
    ws.binaryType = 'arraybuffer'

    ws.onmessage = (evt) => {
      if (typeof evt.data === 'string') {
        term.write(evt.data)
      } else {
        term.write(new Uint8Array(evt.data))
      }
    }

    ws.onclose = () => {
      term.writeln('\r\n\x1b[33m[Session closed]\x1b[0m')
      onClose?.()
    }

    ws.onerror = () => {
      term.writeln('\r\n\x1b[31m[WebSocket error — connection failed]\x1b[0m')
    }

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    })

    term.onResize(({ cols, rows }) => sendResize(cols, rows))

    // Resize observer to refit on container size change
    const ro = new ResizeObserver(() => { fit.fit() })
    ro.observe(containerRef.current)
    resizeObserver.current = ro

    return () => {
      ro.disconnect()
      ws.close()
      term.dispose()
    }
  }, [deviceId, isDark])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        minHeight: 360,
        background: isDark ? '#0d1117' : '#ffffff',
        borderRadius: 8,
        overflow: 'hidden',
        padding: 4,
      }}
    />
  )
}
