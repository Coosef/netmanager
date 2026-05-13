import { useState } from 'react'
import {
  Table, Tag, Button, Switch, Popconfirm, Tooltip, Drawer, Form,
  Input, InputNumber, Select, message, Spin, Badge, Space,
} from 'antd'
import {
  PlusOutlined, PlayCircleOutlined, DeleteOutlined,
  CheckCircleOutlined, ReloadOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { syntheticApi, type SyntheticProbe, type ProbeType } from '@/api/synthetic'
import dayjs from 'dayjs'

const PROBE_TYPE_COLOR: Record<ProbeType, string> = {
  icmp: 'blue',
  tcp:  'orange',
  http: 'green',
  dns:  'purple',
}

// icmp/tcp failures are "critical", http/dns are "warning"
const PROBE_SEVERITY: Record<ProbeType, 'critical' | 'warning'> = {
  icmp: 'critical',
  tcp:  'critical',
  http: 'warning',
  dns:  'warning',
}

const SEV_BG: Record<'critical' | 'warning', string> = {
  critical: 'rgba(239,68,68,0.07)',
  warning:  'rgba(245,158,11,0.07)',
}
const SEV_BORDER: Record<'critical' | 'warning', string> = {
  critical: '#ef4444',
  warning:  '#f59e0b',
}

// ── Expanded results sub-table ────────────────────────────────────────────────
function ProbeResultsTable({ probeId }: { probeId: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['probe-results', probeId],
    queryFn: () => syntheticApi.getResults(probeId, 20),
    staleTime: 30_000,
  })

  if (isLoading) return <Spin size="small" style={{ display: 'block', margin: '12px auto' }} />
  if (!data?.length) return <div style={{ padding: '12px 0', color: '#888', fontSize: 13 }}>Henüz sonuç yok.</div>

  return (
    <Table
      dataSource={data}
      rowKey="id"
      size="small"
      pagination={false}
      style={{ marginLeft: 24 }}
      columns={[
        {
          title: 'Sonuç', dataIndex: 'success', width: 90,
          render: (ok: boolean) => ok
            ? <Badge status="success" text={<span style={{ color: '#22c55e', fontWeight: 600 }}>✓ Başarılı</span>} />
            : <Badge status="error"   text={<span style={{ color: '#ef4444', fontWeight: 600 }}>✗ Başarısız</span>} />,
        },
        {
          title: 'Gecikme', dataIndex: 'latency_ms', width: 90,
          render: (v: number | null) => v != null ? <span style={{ color: '#888', fontSize: 12 }}>{v.toFixed(1)} ms</span> : '—',
        },
        {
          title: 'Detay', dataIndex: 'detail',
          render: (v: string | null) => v
            ? <Tooltip title={v}><span style={{ fontSize: 12, color: '#666' }}>{v.length > 60 ? v.slice(0, 60) + '…' : v}</span></Tooltip>
            : '—',
        },
        {
          title: 'Zaman', dataIndex: 'measured_at', width: 130,
          render: (v: string) => <span style={{ fontSize: 12, color: '#888' }}>{dayjs(v).format('DD.MM HH:mm:ss')}</span>,
        },
      ]}
    />
  )
}

// ── Create probe form (Drawer) ────────────────────────────────────────────────
function ProbeDrawer({ open, onClose, onCreated }: {
  open: boolean
  onClose: () => void
  onCreated: () => void
}) {
  const [form] = Form.useForm()
  const [probeType, setProbeType] = useState<ProbeType>('icmp')

  const createMutation = useMutation({
    mutationFn: syntheticApi.create,
    onSuccess: () => { message.success('Probe oluşturuldu'); form.resetFields(); onCreated(); onClose() },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Oluşturulamadı'),
  })

  return (
    <Drawer title="Yeni Synthetic Probe" open={open} onClose={onClose} width={420}
      footer={
        <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
          <Button onClick={onClose}>İptal</Button>
          <Button type="primary" onClick={() => form.submit()} loading={createMutation.isPending}>Oluştur</Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical"
        onFinish={(vals) => createMutation.mutate({
          ...vals,
          enabled: true,
          http_method: vals.http_method || 'GET',
          dns_record_type: vals.dns_record_type || 'A',
        })}
      >
        <Form.Item name="name" label="Adı" rules={[{ required: true }]}>
          <Input placeholder="web-check-01" />
        </Form.Item>
        <Form.Item name="probe_type" label="Tip" rules={[{ required: true }]} initialValue="icmp">
          <Select onChange={(v) => setProbeType(v)} options={[
            { value: 'icmp', label: 'ICMP Ping' },
            { value: 'tcp',  label: 'TCP Port' },
            { value: 'http', label: 'HTTP/HTTPS' },
            { value: 'dns',  label: 'DNS Lookup' },
          ]} />
        </Form.Item>
        <Form.Item name="target" label="Hedef" rules={[{ required: true }]}>
          <Input placeholder={probeType === 'http' ? 'https://example.com' : '10.0.0.1'} />
        </Form.Item>
        <Form.Item name="agent_id" label="Agent ID">
          <Input placeholder="agent kimliği (opsiyonel)" />
        </Form.Item>
        {probeType === 'tcp' && (
          <Form.Item name="port" label="Port" rules={[{ required: true }]}>
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
        )}
        {probeType === 'http' && (
          <>
            <Form.Item name="http_method" label="HTTP Metodu" initialValue="GET">
              <Select options={['GET', 'HEAD', 'POST'].map(v => ({ value: v, label: v }))} />
            </Form.Item>
            <Form.Item name="expected_status" label="Beklenen HTTP Kodu" initialValue={200}>
              <InputNumber min={100} max={599} style={{ width: '100%' }} />
            </Form.Item>
          </>
        )}
        {probeType === 'dns' && (
          <Form.Item name="dns_record_type" label="DNS Kayıt Tipi" initialValue="A">
            <Select options={['A', 'AAAA', 'MX', 'TXT', 'CNAME'].map(v => ({ value: v, label: v }))} />
          </Form.Item>
        )}
        <Form.Item name="interval_secs" label="Kontrol Aralığı (sn)" initialValue={300}>
          <InputNumber min={30} max={86400} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="timeout_secs" label="Timeout (sn)" initialValue={5}>
          <InputNumber min={1} max={30} style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Drawer>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function SyntheticProbesPage() {
  const qc = useQueryClient()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [runningIds, setRunningIds] = useState<Set<number>>(new Set())

  const { data: probes, isLoading } = useQuery({
    queryKey: ['synthetic-probes'],
    queryFn: () => syntheticApi.list(),
    refetchInterval: 60_000,
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      syntheticApi.update(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['synthetic-probes'] }),
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Güncellenemedi'),
  })

  const deleteMutation = useMutation({
    mutationFn: syntheticApi.delete,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['synthetic-probes'] }); message.success('Probe silindi') },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Silinemedi'),
  })

  const runNow = async (probe: SyntheticProbe) => {
    setRunningIds(prev => new Set(prev).add(probe.id))
    try {
      await syntheticApi.runNow(probe.id)
      message.success(`${probe.name} — probe çalıştırıldı`)
      qc.invalidateQueries({ queryKey: ['probe-results', probe.id] })
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'Çalıştırılamadı')
    } finally {
      setRunningIds(prev => { const s = new Set(prev); s.delete(probe.id); return s })
    }
  }

  const columns = [
    {
      title: 'Ad', dataIndex: 'name', key: 'name',
      render: (name: string, row: SyntheticProbe) => (
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{name}</div>
          <div style={{ color: '#888', fontSize: 12, fontFamily: 'monospace' }}>{row.target}</div>
        </div>
      ),
    },
    {
      title: 'Tip', dataIndex: 'probe_type', key: 'type', width: 90,
      render: (t: ProbeType) => <Tag color={PROBE_TYPE_COLOR[t]}>{t.toUpperCase()}</Tag>,
    },
    {
      title: 'Durum', key: 'enabled', width: 80,
      render: (_: unknown, row: SyntheticProbe) => (
        <Switch
          size="small"
          checked={row.enabled}
          loading={toggleMutation.isPending}
          onChange={(v) => toggleMutation.mutate({ id: row.id, enabled: v })}
        />
      ),
    },
    {
      title: 'Aralık', dataIndex: 'interval_secs', width: 90,
      render: (v: number) => <span style={{ color: '#888', fontSize: 12 }}>{v}s</span>,
    },
    {
      title: 'İşlemler', key: 'actions', width: 120,
      render: (_: unknown, row: SyntheticProbe) => (
        <Space size={4}>
          <Tooltip title="Şimdi Çalıştır">
            <Button
              size="small" icon={<PlayCircleOutlined />}
              loading={runningIds.has(row.id)}
              onClick={() => runNow(row)}
            />
          </Tooltip>
          <Popconfirm title="Probe silinsin mi?" onConfirm={() => deleteMutation.mutate(row.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: '0 0 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Synthetic Probes</h2>
          <div style={{ color: '#888', fontSize: 13, marginTop: 2 }}>
            Periyodik ağ erişilebilirlik testleri — ICMP / TCP / HTTP / DNS
          </div>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => qc.invalidateQueries({ queryKey: ['synthetic-probes'] })}>
            Yenile
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawerOpen(true)}>
            Yeni Probe
          </Button>
        </Space>
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
      ) : !probes?.length ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: '#888' }}>
          <CheckCircleOutlined style={{ fontSize: 36, marginBottom: 12, display: 'block', color: '#22c55e' }} />
          <div style={{ fontSize: 15 }}>Henüz probe tanımlanmamış.</div>
          <Button type="primary" icon={<PlusOutlined />} style={{ marginTop: 12 }} onClick={() => setDrawerOpen(true)}>
            İlk Probe'u Oluştur
          </Button>
        </div>
      ) : (
        <Table
          dataSource={probes}
          rowKey="id"
          columns={columns}
          size="middle"
          pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
          expandable={{
            expandedRowRender: (row: SyntheticProbe) => <ProbeResultsTable probeId={row.id} />,
          }}
          onRow={(row: SyntheticProbe) => {
            const sev = PROBE_SEVERITY[row.probe_type]
            return {
              style: !row.enabled ? {
                opacity: 0.55,
                background: SEV_BG[sev],
                borderLeft: `3px solid ${SEV_BORDER[sev]}`,
              } : undefined,
            }
          }}
        />
      )}

      <ProbeDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onCreated={() => qc.invalidateQueries({ queryKey: ['synthetic-probes'] })}
      />
    </div>
  )
}
