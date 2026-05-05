import React from 'react'
import { useEffect, useRef } from 'react'
import { App, Button, Space, Tag, Typography } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  AlertOutlined,
  ApiOutlined,
  ApartmentOutlined,
  BranchesOutlined,
  DashboardOutlined,
  DisconnectOutlined,
  ExclamationCircleOutlined,
  LineChartOutlined,
  RobotOutlined,
  SyncOutlined,
  TableOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { monitorApi } from '@/api/monitor'
import type { NetworkEvent } from '@/api/monitor'

const { Text } = Typography

// ── Event metadata config ─────────────────────────────────────────────────────

interface EventConfig {
  icon: React.ReactNode
  summary: (ev: NetworkEvent) => React.ReactNode
  actions: (ev: NetworkEvent, nav: (path: string) => void, close: () => void) => React.ReactNode
}

function devPath(ev: NetworkEvent) {
  return ev.device_hostname
    ? `/devices?search=${encodeURIComponent(ev.device_hostname)}`
    : '/devices'
}

const EVENT_CONFIG: Record<string, EventConfig> = {
  mac_loop_suspicion: {
    icon: <SyncOutlined style={{ color: '#faad14' }} />,
    summary: (ev) => {
      const d = ev.details as any
      return (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Text style={{ fontSize: 12 }}>
            Aynı MAC adresi birden fazla portta görüldü — ağ döngüsü olabilir.
          </Text>
          {d?.mac && (
            <Space size={4} wrap>
              <Tag color="orange" style={{ fontSize: 11 }}>MAC: {d.mac}</Tag>
              <Tag color="red" style={{ fontSize: 11 }}>{d.port_count} farklı port</Tag>
            </Space>
          )}
          <Text style={{ fontSize: 11, color: '#8c8c8c' }}>
            Spanning Tree durumunu ve port konfigürasyonunu kontrol edin.
          </Text>
        </Space>
      )
    },
    actions: (ev, nav, close) => (
      <Space size={4} wrap>
        <Button size="small" icon={<TableOutlined />}
          onClick={() => { nav('/mac-arp'); close() }}>
          MAC/ARP Tablosu
        </Button>
        <Button size="small" icon={<ApiOutlined />}
          onClick={() => { nav(devPath(ev)); close() }}>
          Cihaza Git
        </Button>
        <Button size="small" icon={<AlertOutlined />}
          onClick={() => { nav('/monitor'); close() }}>
          Monitör
        </Button>
      </Space>
    ),
  },

  loop_detected: {
    icon: <SyncOutlined style={{ color: '#ff4d4f' }} />,
    summary: (ev) => {
      const d = ev.details as any
      return (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Text style={{ fontSize: 12 }}>
            Log'da döngü/flap pattern'i tespit edildi.
          </Text>
          {d?.pattern && (
            <Tag color="red" style={{ fontSize: 11 }}>Pattern: {d.pattern}</Tag>
          )}
          {d?.snippet && (
            <Text
              code
              style={{ fontSize: 10, display: 'block', maxWidth: 280, overflow: 'hidden',
                       whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}
              title={d.snippet}
            >
              {d.snippet.split('\n')[0]}
            </Text>
          )}
        </Space>
      )
    },
    actions: (ev, nav, close) => (
      <Space size={4} wrap>
        <Button size="small" icon={<ApiOutlined />}
          onClick={() => { nav(devPath(ev)); close() }}>
          Cihaza Git
        </Button>
        <Button size="small" icon={<AlertOutlined />}
          onClick={() => { nav('/monitor'); close() }}>
          Monitör
        </Button>
      </Space>
    ),
  },

  stp_anomaly: {
    icon: <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />,
    summary: (ev) => {
      const d = ev.details as any
      return (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Text style={{ fontSize: 12 }}>
            Spanning Tree anomalisi — port döngüsü veya topoloji değişimi olabilir.
          </Text>
          {d?.pattern && (
            <Tag color="red" style={{ fontSize: 11 }}>Pattern: {d.pattern}</Tag>
          )}
          {d?.snippet && (
            <Text
              code
              style={{ fontSize: 10, display: 'block', maxWidth: 280, overflow: 'hidden',
                       whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}
              title={d.snippet}
            >
              {d.snippet.split('\n')[0]}
            </Text>
          )}
        </Space>
      )
    },
    actions: (ev, nav, close) => (
      <Space size={4} wrap>
        <Button size="small" icon={<ApiOutlined />}
          onClick={() => { nav(devPath(ev)); close() }}>
          Cihaza Git
        </Button>
        <Button size="small" icon={<ApartmentOutlined />}
          onClick={() => { nav('/topology'); close() }}>
          Topoloji
        </Button>
        <Button size="small" icon={<AlertOutlined />}
          onClick={() => { nav('/monitor'); close() }}>
          Monitör
        </Button>
      </Space>
    ),
  },

  device_offline: {
    icon: <DisconnectOutlined style={{ color: '#ff4d4f' }} />,
    summary: (ev) => (
      <Space direction="vertical" size={2} style={{ width: '100%' }}>
        <Text style={{ fontSize: 12 }}>
          Cihaza SSH bağlantısı başarısız — erişilemiyor.
        </Text>
        {ev.message && (
          <Text style={{ fontSize: 11, color: '#8c8c8c' }}>{ev.message}</Text>
        )}
        <Text style={{ fontSize: 11, color: '#8c8c8c' }}>
          Güç ve kablo bağlantısını, routing'i kontrol edin.
        </Text>
      </Space>
    ),
    actions: (ev, nav, close) => (
      <Space size={4} wrap>
        <Button size="small" icon={<ApiOutlined />}
          onClick={() => { nav(devPath(ev)); close() }}>
          Cihaza Git
        </Button>
        <Button size="small" icon={<ApartmentOutlined />}
          onClick={() => { nav('/topology'); close() }}>
          Topoloji
        </Button>
        <Button size="small" icon={<AlertOutlined />}
          onClick={() => { nav('/monitor'); close() }}>
          Monitör
        </Button>
      </Space>
    ),
  },

  agent_outage: {
    icon: <RobotOutlined style={{ color: '#ff4d4f' }} />,
    summary: (ev) => (
      <Space direction="vertical" size={2} style={{ width: '100%' }}>
        <Text style={{ fontSize: 12 }}>
          Proxy agent bağlantısı kesildi — aynı segment üzerindeki cihazlar etkileniyor.
        </Text>
        {ev.message && (
          <Text style={{ fontSize: 11, color: '#8c8c8c' }}>{ev.message}</Text>
        )}
        <Text style={{ fontSize: 11, color: '#faad14' }}>
          Agent'ı yeniden başlatın veya ağ bağlantısını kontrol edin.
        </Text>
      </Space>
    ),
    actions: (_ev, nav, close) => (
      <Space size={4} wrap>
        <Button size="small" icon={<RobotOutlined />}
          onClick={() => { nav('/agents'); close() }}>
          Agent Yönetimi
        </Button>
        <Button size="small" icon={<AlertOutlined />}
          onClick={() => { nav('/monitor'); close() }}>
          Monitör
        </Button>
      </Space>
    ),
  },

  correlation_incident: {
    icon: <ApartmentOutlined style={{ color: '#ff4d4f' }} />,
    summary: (ev) => {
      const d = ev.details as any
      return (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Text style={{ fontSize: 12 }}>
            Kök neden analizi: tek bir cihaz arızası cascade'e yol açtı.
          </Text>
          {d?.affected_count && (
            <Tag color="red" style={{ fontSize: 11 }}>
              {d.affected_count} cihaz etkilendi
            </Tag>
          )}
          {d?.affected_devices?.length > 0 && (
            <Text style={{ fontSize: 11, color: '#8c8c8c' }}>
              {(d.affected_devices as any[]).slice(0, 4).map((x: any) => x.hostname).join(', ')}
              {d.affected_devices.length > 4 ? ` +${d.affected_devices.length - 4}` : ''}
            </Text>
          )}
        </Space>
      )
    },
    actions: (ev, nav, close) => (
      <Space size={4} wrap>
        <Button size="small" icon={<ApartmentOutlined />}
          onClick={() => { nav('/topology'); close() }}>
          Topoloji
        </Button>
        <Button size="small" icon={<ApiOutlined />}
          onClick={() => { nav(devPath(ev)); close() }}>
          Kök Cihaz
        </Button>
        <Button size="small" icon={<AlertOutlined />}
          onClick={() => { nav('/monitor'); close() }}>
          Monitör
        </Button>
      </Space>
    ),
  },

  device_flapping: {
    icon: <WarningOutlined style={{ color: '#ff4d4f' }} />,
    summary: (ev) => (
      <Space direction="vertical" size={2} style={{ width: '100%' }}>
        <Text style={{ fontSize: 12 }}>
          Cihaz sürekli online/offline döngüsüne giriyor.
        </Text>
        {ev.message && (
          <Text style={{ fontSize: 11, color: '#8c8c8c' }}>{ev.message}</Text>
        )}
        <Text style={{ fontSize: 11, color: '#faad14' }}>
          Güç kaynağı, kablo veya NIC arızası olabilir.
        </Text>
      </Space>
    ),
    actions: (ev, nav, close) => (
      <Space size={4} wrap>
        <Button size="small" icon={<ApiOutlined />}
          onClick={() => { nav(devPath(ev)); close() }}>
          Cihaza Git
        </Button>
        <Button size="small" icon={<AlertOutlined />}
          onClick={() => { nav('/monitor'); close() }}>
          Monitör
        </Button>
      </Space>
    ),
  },

  mac_anomaly: {
    icon: <TableOutlined style={{ color: '#faad14' }} />,
    summary: (ev) => {
      const d = ev.details as any
      return (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Text style={{ fontSize: 12 }}>
            MAC tablosu boyutu normalin çok üstünde — olağandışı trafik veya saldırı olabilir.
          </Text>
          {d && (
            <Space size={4}>
              <Tag color="orange" style={{ fontSize: 11 }}>Şu an: {d.current}</Tag>
              <Tag color="blue" style={{ fontSize: 11 }}>Baseline: {d.baseline}</Tag>
            </Space>
          )}
        </Space>
      )
    },
    actions: (ev, nav, close) => (
      <Space size={4} wrap>
        <Button size="small" icon={<TableOutlined />}
          onClick={() => { nav('/mac-arp'); close() }}>
          MAC/ARP Tablosu
        </Button>
        <Button size="small" icon={<ApiOutlined />}
          onClick={() => { nav(devPath(ev)); close() }}>
          Cihaza Git
        </Button>
      </Space>
    ),
  },

  traffic_spike: {
    icon: <LineChartOutlined style={{ color: '#faad14' }} />,
    summary: (ev) => {
      const d = ev.details as any
      return (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Text style={{ fontSize: 12 }}>
            {d?.direction === 'gelen' ? 'Gelen' : 'Giden'} trafik baseline'ın 2 katına ulaştı.
          </Text>
          {d && (
            <Space size={4}>
              <Tag color="red" style={{ fontSize: 11 }}>%{d.current_pct} kullanım</Tag>
              <Tag color="blue" style={{ fontSize: 11 }}>Baseline: %{d.baseline_pct}</Tag>
            </Space>
          )}
        </Space>
      )
    },
    actions: (ev, nav, close) => (
      <Space size={4} wrap>
        <Button size="small" icon={<LineChartOutlined />}
          onClick={() => { nav('/bandwidth'); close() }}>
          Bant Genişliği
        </Button>
        <Button size="small" icon={<ApiOutlined />}
          onClick={() => { nav(devPath(ev)); close() }}>
          Cihaza Git
        </Button>
      </Space>
    ),
  },

  vlan_anomaly: {
    icon: <BranchesOutlined style={{ color: '#faad14' }} />,
    summary: (ev) => {
      const d = ev.details as any
      return (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Text style={{ fontSize: 12 }}>
            Cihazda daha önce görülmemiş VLAN'lar tespit edildi.
          </Text>
          {d?.new_vlans?.length > 0 && (
            <Space size={4} wrap>
              {(d.new_vlans as number[]).slice(0, 6).map((v: number) => (
                <Tag key={v} color="orange" style={{ fontSize: 11 }}>VLAN {v}</Tag>
              ))}
              {d.new_vlans.length > 6 && (
                <Tag style={{ fontSize: 11 }}>+{d.new_vlans.length - 6}</Tag>
              )}
            </Space>
          )}
        </Space>
      )
    },
    actions: (ev, nav, close) => (
      <Space size={4} wrap>
        <Button size="small" icon={<BranchesOutlined />}
          onClick={() => { nav('/vlan'); close() }}>
          VLAN Yönetimi
        </Button>
        <Button size="small" icon={<ApiOutlined />}
          onClick={() => { nav(devPath(ev)); close() }}>
          Cihaza Git
        </Button>
      </Space>
    ),
  },

  port_change: {
    icon: <DisconnectOutlined style={{ color: '#faad14' }} />,
    summary: (ev) => {
      const d = ev.details as any
      return (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Text style={{ fontSize: 12 }}>Port durum değişikliği algılandı.</Text>
          {(d?.log_line || ev.message) && (
            <Text
              code
              style={{ fontSize: 10, display: 'block', maxWidth: 280, overflow: 'hidden',
                       whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}
              title={d?.log_line || ev.message || ''}
            >
              {(d?.log_line || ev.message || '').split('\n')[0]}
            </Text>
          )}
        </Space>
      )
    },
    actions: (ev, nav, close) => (
      <Space size={4} wrap>
        <Button size="small" icon={<ApiOutlined />}
          onClick={() => { nav(devPath(ev)); close() }}>
          Cihaza Git
        </Button>
        <Button size="small" icon={<AlertOutlined />}
          onClick={() => { nav('/monitor'); close() }}>
          Monitör
        </Button>
      </Space>
    ),
  },
}

// ── Fallback config ───────────────────────────────────────────────────────────

const FALLBACK_CONFIG: EventConfig = {
  icon: <AlertOutlined style={{ color: '#faad14' }} />,
  summary: (ev) => (
    <Text style={{ fontSize: 12 }}>{ev.message || 'Detay için monitörü kontrol edin.'}</Text>
  ),
  actions: (ev, nav, close) => (
    <Space size={4} wrap>
      {ev.device_hostname && (
        <Button size="small" icon={<ApiOutlined />}
          onClick={() => { nav(devPath(ev)); close() }}>
          Cihaza Git
        </Button>
      )}
      <Button size="small" icon={<DashboardOutlined />}
        onClick={() => { nav('/monitor'); close() }}>
        Monitöre Git
      </Button>
    </Space>
  ),
}

// ── Hook ──────────────────────────────────────────────────────────────────────

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

    if (!seededRef.current) {
      data.items.forEach((ev) => seenRef.current.add(ev.id))
      seededRef.current = true
      return
    }

    let shown = 0
    for (const ev of data.items) {
      if (seenRef.current.has(ev.id)) continue
      seenRef.current.add(ev.id)

      if (ev.severity === 'info') continue
      if (location.pathname === '/monitor') continue
      if (shown >= 3) break
      shown++

      const cfg = EVENT_CONFIG[ev.event_type] ?? FALLBACK_CONFIG
      const notifKey = `alarm-${ev.id}`
      const closeThis = () => notification.destroy(notifKey)
      const closeAll  = () => notification.destroy()

      notification.open({
        key: notifKey,
        type: ev.severity === 'critical' ? 'error' : 'warning',
        duration: ev.severity === 'critical' ? 0 : 12,
        placement: 'bottomRight',
        style: { width: 360, padding: '12px 16px' },
        message: (
          <Space size={6}>
            {cfg.icon}
            <Text strong style={{ fontSize: 13 }}>{ev.title}</Text>
          </Space>
        ),
        description: (
          <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 4 }}>
            {ev.device_hostname && (
              <Tag color="default" style={{ fontSize: 11, marginBottom: 2 }}>
                📡 {ev.device_hostname}
              </Tag>
            )}
            {cfg.summary(ev)}
            <Space size={4} style={{ marginTop: 4 }} onClick={(e) => e.stopPropagation()} wrap>
              {cfg.actions(ev, navigate, closeThis)}
              <Button size="small" onClick={closeAll} style={{ color: '#8c8c8c' }}>
                Tümünü Kapat
              </Button>
            </Space>
          </Space>
        ),
      })
    }
  }, [data, location.pathname, navigate, notification])
}
