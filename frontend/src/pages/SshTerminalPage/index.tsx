import { useEffect, useRef, useCallback, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Button, Space, Tag, Tooltip } from 'antd'
import {
  ConsoleSqlOutlined, ClearOutlined,
  DisconnectOutlined, LinkOutlined, LoadingOutlined,
} from '@ant-design/icons'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { buildWsUrl } from '@/utils/ws'

type ConnState = 'connecting' | 'connected' | 'disconnected'

export default function SshTerminalPage() {
  const { deviceId } = useParams<{ deviceId: string }>()
  const [searchParams] = useSearchParams()
  const hostname = searchParams.get('hostname') ?? `Device #${deviceId}`
  const ip       = searchParams.get('ip') ?? ''

  const containerRef = useRef<HTMLDivElement>(null)
  const termRef      = useRef<Terminal | null>(null)
  const fitRef       = useRef<FitAddon | null>(null)
  const wsRef        = useRef<WebSocket | null>(null)

  const [connState, setConnState] = useState<ConnState>('connecting')

  const sendResize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN)
      wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }))
  }, [])

  const handleClear = () => termRef.current?.clear()

  const handleDisconnect = () => {
    wsRef.current?.close()
    termRef.current?.writeln('\r\n\x1b[33m[Manually disconnected]\x1b[0m')
    setConnState('disconnected')
  }

  useEffect(() => {
    if (!containerRef.current || !deviceId) return

    document.title = `SSH — ${hostname}`

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      fontSize: 14,
      lineHeight: 1.3,
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: '#264f7840',
        black: '#484f58', red: '#ff7b72', green: '#3fb950',
        yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff',
        cyan: '#39c5cf', white: '#b1bac4',
        brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
        brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
      },
      allowTransparency: true,
      scrollback: 5000,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current  = fit

    const url = buildWsUrl(`/api/v1/ws/ssh/${deviceId}?cols=${term.cols}&rows=${term.rows}`)
    const ws  = new WebSocket(url)
    wsRef.current = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => setConnState('connected')

    ws.onmessage = (evt) => {
      if (typeof evt.data === 'string') term.write(evt.data)
      else term.write(new Uint8Array(evt.data))
    }

    ws.onclose = () => setConnState('disconnected')

    ws.onerror = () => {
      term.writeln('\r\n\x1b[31m[WebSocket error — connection failed]\x1b[0m')
      setConnState('disconnected')
    }

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    })
    term.onResize(({ cols, rows }) => sendResize(cols, rows))

    const ro = new ResizeObserver(() => fit.fit())
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      ws.close()
      term.dispose()
    }
  }, [deviceId]) // eslint-disable-line react-hooks/exhaustive-deps

  const statusColor = connState === 'connected' ? '#22c55e' : connState === 'connecting' ? '#faad14' : '#ef4444'
  const statusLabel = connState === 'connected' ? 'Bağlı' : connState === 'connecting' ? 'Bağlanıyor…' : 'Bağlantı Kesildi'
  const StatusIcon  = connState === 'connecting' ? LoadingOutlined : connState === 'connected' ? LinkOutlined : DisconnectOutlined

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#030c1e' }}>
      {/* ── Toolbar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 16px', background: '#071224',
        borderBottom: '1px solid #1a3458', flexShrink: 0,
      }}>
        {/* Left — device info */}
        <Space size={10}>
          <ConsoleSqlOutlined style={{ color: '#22c55e', fontSize: 16 }} />
          <span style={{ fontFamily: 'monospace', fontSize: 14, color: '#f1f5f9', fontWeight: 600 }}>
            {hostname}
          </span>
          {ip && (
            <Tag style={{ fontFamily: 'monospace', fontSize: 12, background: '#0e1e38', border: '1px solid #1a3458', color: '#94a3b8' }}>
              {ip}
            </Tag>
          )}
        </Space>

        {/* Center — connection status */}
        <Space size={6}>
          <StatusIcon style={{ color: statusColor, fontSize: 13 }} spin={connState === 'connecting'} />
          <span style={{ fontSize: 12, color: statusColor }}>{statusLabel}</span>
        </Space>

        {/* Right — actions */}
        <Space size={4}>
          <Tooltip title="Terminali temizle">
            <Button
              size="small" type="text"
              icon={<ClearOutlined />}
              onClick={handleClear}
              style={{ color: '#94a3b8' }}
              disabled={connState !== 'connected'}
            />
          </Tooltip>
          <Tooltip title="Bağlantıyı kes">
            <Button
              size="small" type="text"
              icon={<DisconnectOutlined />}
              onClick={handleDisconnect}
              style={{ color: connState === 'connected' ? '#ef4444' : '#475569' }}
              disabled={connState !== 'connected'}
            />
          </Tooltip>
        </Space>
      </div>

      {/* ── Terminal ── */}
      <div
        ref={containerRef}
        style={{ flex: 1, overflow: 'hidden', padding: '6px 4px 4px' }}
      />
    </div>
  )
}
