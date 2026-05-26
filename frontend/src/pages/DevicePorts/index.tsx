/**
 * DevicePorts — Cihaz portları yönetimi (T9 Tur 4 #8+E2 UI).
 *
 * - getInterfaces ile port listesi (mevcut SSH-cached endpoint)
 * - Her satıra "Kapat/Aç" + "PoE Aç/Kapat" butonları
 * - 5dk safety rollback: pending kayıtlar üstte ayrı kart + countdown
 *   timer + "Onayla" / "Geri Al" butonları
 * - Pending varken aynı interface'e yeni değişiklik engellenir (UI'da)
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Alert, Badge, Button, Card, Modal, Space, Table,
  Tag, Tooltip, Typography, message,
} from 'antd'
import {
  CheckCircleOutlined, ClockCircleOutlined, CloseCircleOutlined,
  PoweroffOutlined, ReloadOutlined, ThunderboltOutlined, ArrowLeftOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { devicesApi } from '@/api/devices'
import { portControlApi, PortChangeRecord } from '@/api/portControl'
import type { Device, NetworkInterface } from '@/types'

const { Text, Paragraph } = Typography

function isPortUp(status: string): boolean {
  const s = (status || '').toLowerCase()
  return s.includes('up') || s.includes('connected') || s === 'connected'
}

function PortStatusBadge({ status }: { status: string }) {
  const up = isPortUp(status)
  return (
    <Tag color={up ? 'green' : status?.toLowerCase().includes('disabled') ? 'default' : 'orange'}>
      {status || '—'}
    </Tag>
  )
}

function PendingRollbackCard({
  record, onCommit, onCancel,
}: {
  record: PortChangeRecord
  onCommit: () => void
  onCancel: () => void
}) {
  // Countdown
  const rollbackAt = record.rollback_at ? new Date(record.rollback_at).getTime() : 0
  const [remaining, setRemaining] = useState<number>(
    Math.max(0, Math.floor((rollbackAt - Date.now()) / 1000)),
  )
  useEffect(() => {
    if (remaining <= 0) return
    const id = setInterval(() => {
      setRemaining(Math.max(0, Math.floor((rollbackAt - Date.now()) / 1000)))
    }, 1000)
    return () => clearInterval(id)
  }, [rollbackAt, remaining])

  const expired = remaining <= 0
  const pct = rollbackAt > 0 ? Math.max(0, Math.min(100, (remaining / 300) * 100)) : 0

  return (
    <Card
      size="small"
      style={{
        borderColor: expired ? 'var(--crit)' : 'var(--warn)',
        background: 'rgba(250, 173, 20, 0.06)',
      }}
      title={
        <Space>
          <ClockCircleOutlined style={{ color: 'var(--warn)' }} />
          <Text strong>Bekleyen Değişiklik</Text>
          <Tag color="orange">{record.interface}</Tag>
          <Tag>{record.change_type === 'admin' ? 'Port Kapat/Aç' : 'PoE'}</Tag>
          <Tag color={
            record.requested_state === 'up' || record.requested_state === 'on'
              ? 'green' : 'red'
          }>
            → {record.requested_state.toUpperCase()}
          </Tag>
        </Space>
      }
      extra={
        <Space>
          <Tooltip title="Değişikliği onayla — auto rollback iptal olur">
            <Button
              type="primary" icon={<CheckCircleOutlined />}
              onClick={onCommit}
            >Onayla</Button>
          </Tooltip>
          <Tooltip title="Şimdi geri al">
            <Button danger icon={<CloseCircleOutlined />} onClick={onCancel}>
              Geri Al
            </Button>
          </Tooltip>
        </Space>
      }
    >
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Text style={{ fontSize: 12, color: 'var(--fg-3)' }}>
          {expired
            ? 'Süre doldu — otomatik rollback çalıştırılıyor.'
            : `Otomatik geri alma: ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} sonra`}
        </Text>
        <div style={{
          height: 6, background: 'var(--bg-2)', borderRadius: 3, overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', width: `${pct}%`,
            background: expired ? 'var(--crit)' : 'var(--warn)',
            transition: 'width 1s linear',
          }} />
        </div>
        <details style={{ fontSize: 11, color: 'var(--fg-3)' }}>
          <summary>Uygulanan komutlar</summary>
          <pre style={{
            fontFamily: 'monospace', fontSize: 11, background: 'var(--bg-2)',
            padding: 6, borderRadius: 4, margin: 0,
          }}>{record.forward_cmds.join('\n')}</pre>
        </details>
      </Space>
    </Card>
  )
}

export default function DevicePortsPage() {
  const { deviceId: did } = useParams<{ deviceId: string }>()
  const deviceId = Number(did || 0)
  const navigate = useNavigate()
  const qc = useQueryClient()

  // Cihaz meta
  const deviceQ = useQuery({
    queryKey: ['device-detail', deviceId],
    queryFn: () => devicesApi.get(deviceId),
    enabled: deviceId > 0,
  })

  // Interface listesi (SSH cached)
  const ifaceQ = useQuery({
    queryKey: ['device-interfaces', deviceId],
    queryFn: () => devicesApi.getInterfaces(deviceId),
    enabled: deviceId > 0,
  })

  // Pending rollback'ler
  const rbQ = useQuery({
    queryKey: ['port-rollbacks', deviceId],
    queryFn: () => portControlApi.listRollbacks(deviceId),
    enabled: deviceId > 0,
    refetchInterval: 5000,  // countdown güncellemesi için
  })

  // Reason modal
  const [reasonModal, setReasonModal] = useState<{
    open: boolean
    action?: () => void
    title?: string
    body?: string
  }>({ open: false })
  const [reason, setReason] = useState('')

  const adminMut = useMutation({
    mutationFn: ({ iface, enable }: { iface: string; enable: boolean }) =>
      portControlApi.setAdmin(deviceId, iface, enable, 300, reason || undefined),
    onSuccess: () => {
      message.success('Komut uygulandı — 5dk içinde "Onayla" basın yoksa geri alınır')
      qc.invalidateQueries({ queryKey: ['port-rollbacks', deviceId] })
      qc.invalidateQueries({ queryKey: ['device-interfaces', deviceId] })
      setReason('')
    },
    onError: (e: any) => message.error(
      e?.response?.data?.detail || 'Port toggle başarısız',
    ),
  })

  const poeMut = useMutation({
    mutationFn: ({ iface, enable }: { iface: string; enable: boolean }) =>
      portControlApi.setPoe(deviceId, iface, enable, 300, reason || undefined),
    onSuccess: () => {
      message.success('PoE komutu uygulandı — 5dk içinde "Onayla" basın')
      qc.invalidateQueries({ queryKey: ['port-rollbacks', deviceId] })
      setReason('')
    },
    onError: (e: any) => message.error(
      e?.response?.data?.detail || 'PoE toggle başarısız',
    ),
  })

  const commitMut = useMutation({
    mutationFn: (rid: number) => portControlApi.commit(deviceId, rid),
    onSuccess: () => {
      message.success('Değişiklik onaylandı (kalıcı)')
      qc.invalidateQueries({ queryKey: ['port-rollbacks', deviceId] })
    },
  })

  const cancelMut = useMutation({
    mutationFn: (rid: number) => portControlApi.cancel(deviceId, rid),
    onSuccess: () => {
      message.success('Değişiklik geri alındı')
      qc.invalidateQueries({ queryKey: ['port-rollbacks', deviceId] })
      qc.invalidateQueries({ queryKey: ['device-interfaces', deviceId] })
    },
  })

  // Pending kayıtlar (interface bazlı index)
  const pendingByIface = useMemo(() => {
    const map: Record<string, PortChangeRecord[]> = {}
    for (const r of rbQ.data?.items || []) {
      if (r.status === 'pending') {
        const list = map[r.interface] || (map[r.interface] = [])
        list.push(r)
      }
    }
    return map
  }, [rbQ.data])

  const pendingList = useMemo(
    () => (rbQ.data?.items || []).filter((r) => r.status === 'pending'),
    [rbQ.data],
  )

  const device: Device | undefined = deviceQ.data
  const interfaces = ifaceQ.data?.interfaces || []

  const triggerAdmin = (iface: string, enable: boolean) => {
    setReasonModal({
      open: true,
      title: enable ? `${iface}: Aç (no shutdown)` : `${iface}: Kapat (shutdown)`,
      body: '5 dakika içinde "Onayla" basmazsanız bu değişiklik otomatik geri alınacak.',
      action: () => {
        setReasonModal({ open: false })
        adminMut.mutate({ iface, enable })
      },
    })
  }
  const triggerPoe = (iface: string, enable: boolean) => {
    setReasonModal({
      open: true,
      title: enable ? `${iface}: PoE Aç` : `${iface}: PoE Kapat`,
      body: '5 dakika içinde "Onayla" basmazsanız bu değişiklik otomatik geri alınacak.',
      action: () => {
        setReasonModal({ open: false })
        poeMut.mutate({ iface, enable })
      },
    })
  }

  const columns = [
    {
      title: 'Port', dataIndex: 'name', width: 140,
      render: (v: string) => <Text style={{ fontFamily: 'monospace', fontWeight: 500 }}>{v}</Text>,
    },
    {
      title: 'Açıklama', dataIndex: 'description', ellipsis: true,
      render: (v: string) => <Text style={{ fontSize: 12, color: 'var(--fg-2)' }}>{v || '—'}</Text>,
    },
    {
      title: 'Durum', dataIndex: 'status', width: 130,
      render: (s: string) => <PortStatusBadge status={s} />,
    },
    { title: 'VLAN', dataIndex: 'vlan', width: 70 },
    { title: 'Hız', dataIndex: 'speed', width: 80 },
    { title: 'Duplex', dataIndex: 'duplex', width: 90 },
    {
      title: 'Aksiyon', width: 240, align: 'right' as const,
      render: (_: any, row: NetworkInterface) => {
        const hasPending = (pendingByIface[row.name] || []).length > 0
        const up = isPortUp(row.status)
        return (
          <Space size={4}>
            {hasPending && (
              <Tag color="warning">
                <ClockCircleOutlined /> Bekliyor
              </Tag>
            )}
            <Tooltip title={up ? 'Portu kapat (shutdown)' : 'Portu aç (no shutdown)'}>
              <Button
                size="small"
                danger={up}
                type={up ? 'default' : 'primary'}
                icon={<PoweroffOutlined />}
                disabled={hasPending || adminMut.isPending}
                onClick={() => triggerAdmin(row.name, !up)}
              >
                {up ? 'Kapat' : 'Aç'}
              </Button>
            </Tooltip>
            <Tooltip title="PoE Aç/Kapat (varsa)">
              <Button
                size="small"
                icon={<ThunderboltOutlined />}
                disabled={hasPending || poeMut.isPending}
                onClick={() => {
                  // PoE state'i bilinmiyor (interfaces endpoint output'unda yok);
                  // Kullanıcı toggle yapar; backend mevcut state'e bakmaz, sadece
                  // istediği state'i ayarlar. UI default 'Aç' assume eder; eğer
                  // zaten açıksa kullanıcı tekrar açar (no-op SSH).
                  triggerPoe(row.name, true)
                }}
              >
                PoE
              </Button>
            </Tooltip>
          </Space>
        )
      },
    },
  ]

  if (!deviceId) return <div>Cihaz ID eksik</div>

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs">
            <Link to="/devices"><span>Cihazlar</span></Link>
            <span>{device?.hostname || `#${deviceId}`}</span>
            <span>Portlar</span>
          </div>
          <h1 className="nm-page-title">
            <Button
              size="small" type="text" icon={<ArrowLeftOutlined />}
              onClick={() => navigate('/devices')}
              style={{ marginRight: 8 }}
            />
            Port Yönetimi
            {device?.hostname && <span className="nm-pill mono">{device.hostname}</span>}
          </h1>
          <div className="nm-page-sub">
            Cihazın portlarını aç/kapat ve PoE kontrolü · her değişiklik 5 dakika
            güvenli pencerede çalışır, onaylanmazsa otomatik geri alınır.
          </div>
        </div>
        <div>
          <Button icon={<ReloadOutlined />} onClick={() => {
            ifaceQ.refetch(); rbQ.refetch()
          }}>Yenile</Button>
        </div>
      </div>

      {/* Pending rollback'ler */}
      {pendingList.length > 0 && (
        <Space direction="vertical" size={10} style={{ width: '100%', marginBottom: 14 }}>
          <Alert
            type="warning" showIcon
            message={`${pendingList.length} bekleyen değişiklik var`}
            description="Her değişiklik 5 dakika içinde onaylanmazsa cihazda otomatik geri alınacak. Aşağıdan onayla veya hemen geri al."
          />
          {pendingList.map((r) => (
            <PendingRollbackCard
              key={r.id} record={r}
              onCommit={() => commitMut.mutate(r.id)}
              onCancel={() => cancelMut.mutate(r.id)}
            />
          ))}
        </Space>
      )}

      <Card
        title={
          <Space>
            <span>Portlar</span>
            <Badge count={interfaces.length} showZero
                   style={{ backgroundColor: 'var(--accent)' }} />
          </Space>
        }
      >
        <Table
          rowKey="name"
          dataSource={interfaces}
          columns={columns}
          loading={ifaceQ.isLoading}
          pagination={{ pageSize: 50 }}
          size="small"
        />
      </Card>

      {/* Confirmation modal */}
      <Modal
        open={reasonModal.open}
        title={reasonModal.title}
        okText="Uygula"
        cancelText="Vazgeç"
        okButtonProps={{ danger: reasonModal.title?.includes('Kapat') }}
        onOk={() => reasonModal.action?.()}
        onCancel={() => { setReasonModal({ open: false }); setReason('') }}
      >
        <Paragraph>{reasonModal.body}</Paragraph>
        <Text style={{ fontSize: 12, color: 'var(--fg-3)' }}>
          Audit log için açıklama (opsiyonel):
        </Text>
        <textarea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Örn: Bakım, sorun giderme, port testi…"
          style={{
            width: '100%', padding: 8, marginTop: 6, borderRadius: 4,
            border: '1px solid var(--border-0)', background: 'var(--bg-1)',
            color: 'var(--fg)', fontSize: 13, resize: 'vertical',
          }}
        />
      </Modal>
    </div>
  )
}
