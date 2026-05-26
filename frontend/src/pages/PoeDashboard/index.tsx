import { useMemo, useState } from 'react'
import {
  Alert, App, Badge, Button, Card, Drawer, Progress, Space, Table, Tag, Tooltip, Typography,
} from 'antd'
import {
  ApiOutlined, BulbOutlined, ClockCircleOutlined, PoweroffOutlined,
  ReloadOutlined, SyncOutlined, ThunderboltOutlined, WarningOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery } from '@tanstack/react-query'
import { poeApi, type PoeDeviceRow, type PoePort } from '@/api/poe'
import { useTheme } from '@/contexts/ThemeContext'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)

const { Text } = Typography

function mkC(isDark: boolean) {
  return {
    bg: isDark ? '#1e293b' : '#ffffff',
    bg2: isDark ? '#0f172a' : '#f8fafc',
    border: isDark ? '#334155' : '#e2e8f0',
    text: isDark ? '#f1f5f9' : '#1e293b',
    muted: isDark ? '#64748b' : '#94a3b8',
    dim: isDark ? '#475569' : '#cbd5e1',
  }
}

// ─── Per-device drilldown drawer ──────────────────────────────────────────

function DevicePoeDrawer({
  deviceId, open, onClose, isDark,
}: { deviceId: number | null; open: boolean; onClose: () => void; isDark: boolean }) {
  const C = mkC(isDark)
  const { data, isLoading } = useQuery({
    queryKey: ['poe-device', deviceId],
    queryFn: () => poeApi.device(deviceId!),
    enabled: open && deviceId !== null,
  })

  const portCols = [
    {
      title: 'Port', dataIndex: 'port', width: 160,
      render: (v: string) => <Text style={{ fontFamily: 'monospace', color: C.text }}>{v}</Text>,
    },
    {
      title: 'Durum', dataIndex: 'oper_status', width: 110,
      render: (v: string) => {
        if (v === 'on') return <Tag color="green" icon={<ThunderboltOutlined />}>Aktif</Tag>
        if (v === 'off') return <Tag color="default" icon={<PoweroffOutlined />}>Kapalı</Tag>
        if (v === 'faulty') return <Tag color="red" icon={<WarningOutlined />}>Hatalı</Tag>
        if (v === 'denied') return <Tag color="orange">Reddedildi</Tag>
        if (v === 'searching') return <Tag color="blue">Arıyor</Tag>
        return <Tag>{v}</Tag>
      },
    },
    {
      title: (
        <Tooltip title="Tahmini çekiş — cihaz vendor'ı gerçek mW raporlamıyorsa PD class'tan IEEE 802.3 max bütçesi kullanılır.">
          <span>Güç (W) <span style={{ color: '#94a3b8', fontSize: 11 }}>ⓘ</span></span>
        </Tooltip>
      ),
      dataIndex: 'power_watts', width: 130,
      sorter: (a: PoePort, b: PoePort) => (a.power_mw || 0) - (b.power_mw || 0),
      render: (v: number, r: PoePort) =>
        r.oper_status === 'on'
          ? <Text strong style={{ color: '#22c55e' }}>{v} W</Text>
          : <Text style={{ color: C.muted }}>—</Text>,
    },
    {
      title: (
        <Tooltip title={
          <div style={{ fontSize: 11, lineHeight: 1.5 }}>
            <b>IEEE 802.3 PD Power Class</b> — bağlı cihazın talep ettiği güç sınıfı:<br/>
            • Class 1 — ~4 W (VoIP telefon)<br/>
            • Class 2 — ~6 W (basic IP kamera)<br/>
            • Class 3 — ~13 W (WiFi AP, gelişmiş kamera)<br/>
            • Class 4 — ~25 W (PoE+ — PTZ kamera, AP-AX)<br/>
            • Class 5-8 — 45-90 W (PoE++ / UPOE)
          </div>
        }>
          <span>Sınıf <span style={{ color: '#94a3b8', fontSize: 11 }}>ⓘ</span></span>
        </Tooltip>
      ),
      dataIndex: 'device_class', width: 100,
      render: (v: string | null) => v ? <Tag>{v}</Tag> : <Text style={{ color: C.dim }}>—</Text>,
    },
    {
      title: 'Güncellendi', dataIndex: 'updated_at', width: 120,
      render: (v: string | null) =>
        v
          ? <Tooltip title={dayjs(v).format('DD.MM.YYYY HH:mm:ss')}>
              <Text style={{ fontSize: 12, color: C.muted }}>{dayjs(v).fromNow()}</Text>
            </Tooltip>
          : <Text style={{ color: C.dim }}>—</Text>,
    },
  ]

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={760}
      title={
        <Space>
          <BulbOutlined style={{ color: '#facc15' }} />
          <Text strong>PoE — {data?.device.hostname || '...'}</Text>
          {data && (
            <Tag color="default" style={{ fontSize: 11 }}>{data.device.ip_address}</Tag>
          )}
        </Space>
      }
      styles={{ body: { background: isDark ? '#0f172a' : '#f8fafc' } }}
    >
      {isLoading && <div style={{ textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
            <Card size="small" style={{ background: C.bg, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 10, color: C.muted, fontWeight: 600, letterSpacing: 0.5 }}>AKTİF PORT</div>
              <div style={{ fontSize: 22, color: '#22c55e', fontWeight: 700 }}>{data.summary.active_ports}<small style={{ color: C.muted, fontSize: 11 }}> / {data.summary.total_ports}</small></div>
            </Card>
            <Card size="small" style={{ background: C.bg, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 10, color: C.muted, fontWeight: 600, letterSpacing: 0.5 }}>ANLIK ÇEKİŞ</div>
              <div style={{ fontSize: 22, color: '#3b82f6', fontWeight: 700 }}>{data.summary.total_power_watts} W</div>
            </Card>
            <Card size="small" style={{ background: C.bg, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 10, color: C.muted, fontWeight: 600, letterSpacing: 0.5 }}>ORT. / PORT</div>
              <div style={{ fontSize: 22, color: '#facc15', fontWeight: 700 }}>
                {data.summary.active_ports > 0
                  ? `${(data.summary.total_power_watts / data.summary.active_ports).toFixed(1)} W`
                  : '—'}
              </div>
            </Card>
          </div>
          <Table
            dataSource={data.ports}
            rowKey="id"
            columns={portCols}
            size="small"
            pagination={false}
            locale={{ emptyText: 'PoE portu kaydedilmedi' }}
          />
        </>
      )}
    </Drawer>
  )
}

// ─── Main page ─────────────────────────────────────────────────────────────

export default function PoeDashboardPage() {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const { message } = App.useApp()
  const [drilldownId, setDrilldownId] = useState<number | null>(null)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['poe-summary'],
    queryFn: () => poeApi.summary(),
    refetchInterval: 60_000,
  })

  const snapshotMut = useMutation({
    mutationFn: () => poeApi.snapshotNow(),
    onSuccess: () => {
      message.success('Veri çekme kuyruğa alındı — birkaç saniye sonra sonuç gelir', 5)
      // 5s sonra otomatik yenile — worker'ın çoğunlukla bitmesi için makul bir gecikme.
      setTimeout(() => refetch(), 5000)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Tetiklenemedi', 5),
  })

  const totalWatts = data?.summary.total_power_watts ?? 0
  const totalActive = data?.summary.active_ports ?? 0
  const totalPorts = data?.summary.total_ports ?? 0
  const utilization = totalPorts > 0 ? Math.round((totalActive / totalPorts) * 100) : 0

  const cols = useMemo(() => [
    {
      title: 'Cihaz', dataIndex: 'hostname',
      render: (v: string, r: PoeDeviceRow) => (
        <div>
          <Text strong style={{ color: C.text }}>{v}</Text>
          {r.is_stale && (
            <Tooltip title="Veri eski — periyodik snapshot bu cihaza ulaşamıyor olabilir">
              <Tag color="orange" style={{ fontSize: 10, marginLeft: 6 }} icon={<ClockCircleOutlined />}>eski</Tag>
            </Tooltip>
          )}
          <div style={{ fontSize: 11, color: C.muted, fontFamily: 'monospace' }}>{r.ip_address}</div>
        </div>
      ),
    },
    {
      title: 'Vendor', dataIndex: 'vendor', width: 100,
      render: (v: string) => <Tag>{v || '—'}</Tag>,
    },
    {
      title: 'Aktif Port', dataIndex: 'active_ports', width: 120,
      sorter: (a: PoeDeviceRow, b: PoeDeviceRow) => a.active_ports - b.active_ports,
      render: (v: number, r: PoeDeviceRow) => (
        <Space size={6}>
          <Badge status={v > 0 ? 'success' : 'default'} />
          <Text style={{ color: C.text }}>{v} / {r.total_ports}</Text>
        </Space>
      ),
    },
    {
      title: 'Güç (W)', dataIndex: 'power_watts', width: 150,
      sorter: (a: PoeDeviceRow, b: PoeDeviceRow) => a.power_mw - b.power_mw,
      defaultSortOrder: 'descend' as const,
      render: (v: number, r: PoeDeviceRow) => {
        const maxRow = data?.devices[0]?.power_watts || 1
        const pct = maxRow > 0 ? Math.min(100, Math.round((v / maxRow) * 100)) : 0
        return (
          <div>
            <Text strong style={{ color: v > 0 ? '#22c55e' : C.muted }}>{v} W</Text>
            <Progress
              percent={pct}
              size="small"
              showInfo={false}
              strokeColor={r.is_stale ? '#f59e0b' : '#22c55e'}
              trailColor={isDark ? '#1e293b' : '#e2e8f0'}
            />
          </div>
        )
      },
    },
    {
      title: 'Son Snapshot', dataIndex: 'last_updated_at', width: 140,
      render: (v: string | null) =>
        v
          ? <Tooltip title={dayjs(v).format('DD.MM.YYYY HH:mm:ss')}>
              <Text style={{ fontSize: 12, color: C.muted }}>{dayjs(v).fromNow()}</Text>
            </Tooltip>
          : <Text style={{ color: C.dim }}>—</Text>,
    },
    {
      title: '',
      width: 70,
      render: (_: unknown, r: PoeDeviceRow) => (
        <Button size="small" icon={<ApiOutlined />} onClick={() => setDrilldownId(r.device_id)}>
          Port
        </Button>
      ),
    },
  ], [data, isDark, C])

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>Ağ Operasyonları</span><span>PoE / Enerji</span></div>
          <h1 className="nm-page-title">
            PoE / Enerji Tüketimi
            <span className="nm-pill mono">{totalWatts.toFixed(1)} W</span>
            <Tag color="purple" style={{ fontSize: 10, fontWeight: 600 }}>T9 Tur 6 · #B</Tag>
          </h1>
          <div className="nm-page-sub">
            Cihaz başına anlık PoE çekişi — periyodik snapshot (15 dk).
            Eski snapshot'lar turuncu rozetli; periyot içinde ulaşılamayan cihazlar.
          </div>
        </div>
        <Space>
          <Button
            type="primary"
            icon={<SyncOutlined />}
            loading={snapshotMut.isPending}
            onClick={() => snapshotMut.mutate()}
          >
            Veri Çek (Anlık)
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => { refetch(); message.info('Yenilendi') }}>
            Yenile
          </Button>
        </Space>
      </div>

      {data && data.summary.stale_devices > 0 && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          style={{ marginBottom: 12 }}
          message={`${data.summary.stale_devices} cihazda PoE verisi eski.`}
          description={`Son ${data.stale_threshold_minutes} dakikadır snapshot beat task'ı bu cihazlarda PoE durumunu güncelleyemedi — cihazlar offline olabilir veya 'show power inline' başarısız oluyor.`}
        />
      )}

      <div className="nm-statbar">
        <div className="nm-stat">
          <div className="nm-stat-label">CİHAZ</div>
          <div className="nm-stat-val">{data?.summary.device_count ?? 0}</div>
          <div className="nm-stat-delta">PoE kapsamında</div>
        </div>
        <div className={`nm-stat ${totalActive > 0 ? 'ok' : ''}`}>
          <div className="nm-stat-label">AKTİF PORT</div>
          <div className="nm-stat-val">{totalActive}</div>
          <div className="nm-stat-delta">/ {totalPorts} toplam</div>
        </div>
        <div className={`nm-stat ${utilization > 70 ? 'warn' : 'ok'}`}>
          <div className="nm-stat-label">KULLANIM</div>
          <div className="nm-stat-val">{utilization}<small>%</small></div>
          <div className="nm-stat-delta">aktif / toplam</div>
        </div>
        <div className="nm-stat ok">
          <div className="nm-stat-label">ANLIK ÇEKİŞ</div>
          <div className="nm-stat-val">{totalWatts.toFixed(1)}<small> W</small></div>
          <div className="nm-stat-delta">tüm cihazlar</div>
        </div>
        <div className={`nm-stat ${data && data.summary.stale_devices > 0 ? 'warn' : ''}`}>
          <div className="nm-stat-label">ESKİ VERİ</div>
          <div className="nm-stat-val">{data?.summary.stale_devices ?? 0}</div>
          <div className="nm-stat-delta">cihaz</div>
        </div>
      </div>

      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden', marginTop: 14 }}>
        <Table
          dataSource={data?.devices ?? []}
          rowKey="device_id"
          columns={cols}
          loading={isLoading}
          size="small"
          pagination={{ pageSize: 50, showTotal: (n) => <span style={{ color: C.muted }}>{n} cihaz</span> }}
          locale={{ emptyText: 'Henüz PoE snapshot kaydı yok — beat task ilk çevriminde dolacak (15 dk içinde).' }}
        />
      </div>

      <DevicePoeDrawer
        deviceId={drilldownId}
        open={drilldownId !== null}
        onClose={() => setDrilldownId(null)}
        isDark={isDark}
      />
    </div>
  )
}
