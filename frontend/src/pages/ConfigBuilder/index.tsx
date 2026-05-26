import { useEffect, useMemo, useState } from 'react'
import {
  App, Alert, Badge, Button, Card, Col, Form, Input, Modal,
  Row, Select, Space, Spin, Table, Tag, Tooltip, Typography,
} from 'antd'
import {
  ApiOutlined, CheckCircleOutlined, ClockCircleOutlined,
  CloseCircleOutlined, DeleteOutlined, EditOutlined, FileTextOutlined,
  GlobalOutlined, LockOutlined, PlusCircleOutlined, RocketOutlined,
  SafetyOutlined, TagOutlined, ThunderboltOutlined, ToolOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery } from '@tanstack/react-query'
import { configBuilderApi, type Operation, type PreviewItem } from '@/api/configBuilder'
import { devicesApi } from '@/api/devices'
import { useTheme } from '@/contexts/ThemeContext'
import { useAuthStore } from '@/store/auth'
import type { Device } from '@/types'

const { Text } = Typography

// Icon string from backend → component
const ICON_MAP: Record<string, React.ReactNode> = {
  EditOutlined: <EditOutlined />,
  PlusCircleOutlined: <PlusCircleOutlined />,
  DeleteOutlined: <DeleteOutlined />,
  ApiOutlined: <ApiOutlined />,
  TagOutlined: <TagOutlined />,
  ClockCircleOutlined: <ClockCircleOutlined />,
  FileTextOutlined: <FileTextOutlined />,
  LockOutlined: <LockOutlined />,
  GlobalOutlined: <GlobalOutlined />,
  ToolOutlined: <ToolOutlined />,
}

const CATEGORY_LABEL: Record<string, string> = {
  global: 'Genel Cihaz Ayarları',
  vlan: 'VLAN',
  interface: 'Port / Interface',
  aaa: 'Yetkilendirme',
}

const CATEGORY_COLOR: Record<string, string> = {
  global: 'blue', vlan: 'purple', interface: 'cyan', aaa: 'orange',
}

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

// ─── Operation picker (left rail) ─────────────────────────────────────────

function OperationPicker({
  operations, selected, onSelect, isDark,
}: {
  operations: Operation[]
  selected: string | null
  onSelect: (k: string) => void
  isDark: boolean
}) {
  const C = mkC(isDark)
  const grouped = useMemo(() => {
    const m: Record<string, Operation[]> = {}
    for (const op of operations) {
      (m[op.category] ||= []).push(op)
    }
    return m
  }, [operations])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {Object.entries(grouped).map(([cat, ops]) => (
        <div key={cat}>
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 1,
            color: C.muted, marginBottom: 6, textTransform: 'uppercase',
          }}>
            <Tag color={CATEGORY_COLOR[cat] || 'default'} style={{ fontSize: 10 }}>
              {CATEGORY_LABEL[cat] || cat}
            </Tag>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {ops.map((op) => {
              const isActive = op.key === selected
              return (
                <button
                  key={op.key}
                  onClick={() => onSelect(op.key)}
                  style={{
                    textAlign: 'left',
                    background: isActive ? (isDark ? '#1e40af40' : '#dbeafe') : 'transparent',
                    border: `1px solid ${isActive ? '#3b82f6' : C.border}`,
                    borderRadius: 8, padding: '8px 10px', cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: isActive ? '#3b82f6' : C.muted }}>
                      {ICON_MAP[op.icon] || <ToolOutlined />}
                    </span>
                    <Text strong style={{ color: C.text, fontSize: 13 }}>{op.label}</Text>
                  </div>
                  <Text style={{ color: C.muted, fontSize: 11, marginLeft: 24, display: 'block', marginTop: 2 }}>
                    {op.description}
                  </Text>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Dynamic form for an operation ────────────────────────────────────────

function OperationForm({
  operation, value, onChange, isDark,
}: {
  operation: Operation
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  isDark: boolean
}) {
  const C = mkC(isDark)
  return (
    <Form layout="vertical" size="middle">
      {operation.fields.map((f) => (
        <Form.Item
          key={f.name}
          label={
            <Space size={4}>
              <Text style={{ color: C.text, fontSize: 13 }}>{f.label}</Text>
              {f.required && <Text style={{ color: '#ef4444' }}>*</Text>}
            </Space>
          }
          help={f.help || undefined}
          style={{ marginBottom: 12 }}
        >
          {f.type === 'enum' && f.options ? (
            <Select
              value={(value[f.name] ?? f.default) as string}
              options={f.options}
              onChange={(v) => onChange({ ...value, [f.name]: v })}
            />
          ) : f.type === 'vlan_id' || f.type === 'int' ? (
            <Input
              type="number"
              min={f.min ?? undefined}
              max={f.max ?? undefined}
              placeholder={f.placeholder || undefined}
              value={(value[f.name] ?? '') as string | number}
              onChange={(e) => onChange({ ...value, [f.name]: e.target.value })}
            />
          ) : (
            <Input
              placeholder={f.placeholder || undefined}
              value={(value[f.name] ?? '') as string}
              onChange={(e) => onChange({ ...value, [f.name]: e.target.value })}
            />
          )}
        </Form.Item>
      ))}
    </Form>
  )
}

// ─── Push confirmation modal ──────────────────────────────────────────────

function PushConfirmModal({
  open, onClose, operation, params, deviceIds, items, isDark,
}: {
  open: boolean
  onClose: () => void
  operation: Operation
  params: Record<string, unknown>
  deviceIds: number[]
  items: PreviewItem[]
  isDark: boolean
}) {
  const { message } = App.useApp()
  const C = mkC(isDark)
  const [reason, setReason] = useState('')
  const [results, setResults] = useState<{ device_id: number; hostname: string; success: boolean; error?: string | null; skipped?: boolean }[] | null>(null)

  useEffect(() => {
    if (open) { setReason(''); setResults(null) }
  }, [open])

  const pushMut = useMutation({
    mutationFn: () => configBuilderApi.push(
      operation.key, params, deviceIds, { reason: reason.trim() || undefined },
    ),
    onSuccess: (r) => {
      setResults(r.results.map((it) => ({
        device_id: it.device_id, hostname: it.hostname,
        success: it.success, error: it.error, skipped: it.skipped,
      })))
      if (r.success_count === r.total) message.success(`Tüm ${r.total} cihazda başarılı.`)
      else if (r.success_count > 0) message.warning(`${r.success_count}/${r.total} cihazda başarılı.`)
      else message.error('Hiçbir cihazda uygulanamadı.', 6)
    },
    onError: (e: any) => {
      message.error(e?.response?.data?.detail || 'İşlem başlatılamadı', 6)
    },
  })

  const executableCount = items.filter((it) => it.supported && !it.error).length

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={
        <Space>
          <RocketOutlined style={{ color: '#3b82f6' }} />
          <Text strong style={{ color: C.text }}>{operation.label} — Uygula</Text>
        </Space>
      }
      width={720}
      okText={results ? 'Kapat' : `${executableCount} Cihaza Uygula`}
      okButtonProps={{
        danger: !results,
        loading: pushMut.isPending,
        disabled: executableCount === 0 && !results,
      }}
      cancelText={results ? 'Kapat' : 'Vazgeç'}
      cancelButtonProps={results ? { style: { display: 'none' } } : undefined}
      onOk={() => results ? onClose() : pushMut.mutate()}
      styles={{
        content: { background: C.bg, border: `1px solid ${C.border}` },
        header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
      }}
    >
      {!results ? (
        <>
          <Alert
            type="warning"
            showIcon
            icon={<SafetyOutlined />}
            message={`${executableCount} cihaza CLI komutu gönderilecek.`}
            description={
              <Text style={{ fontSize: 12 }}>
                Her cihaz için <Text code style={{ fontSize: 11 }}>send_config</Text> + <Text code style={{ fontSize: 11 }}>write memory</Text> çağrılır.
                Önizlemede hata gösteren cihazlar atlanır.
              </Text>
            }
            style={{ marginBottom: 12 }}
          />
          <div style={{ marginBottom: 8, fontSize: 12, color: C.muted, fontWeight: 600 }}>
            Sebep (opsiyonel — audit log)
          </div>
          <Input.TextArea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="örn. 'Yeni VLAN 200 — IoT ağı için.'"
            rows={2}
            maxLength={400}
            showCount
          />
        </>
      ) : (
        <Table
          dataSource={results}
          rowKey="device_id"
          size="small"
          pagination={false}
          columns={[
            {
              title: 'Cihaz', dataIndex: 'hostname',
              render: (v: string) => <Text style={{ color: C.text }}>{v}</Text>,
            },
            {
              title: 'Sonuç', width: 110,
              render: (_: unknown, r: { success: boolean; skipped?: boolean }) =>
                r.skipped
                  ? <Tag icon={<CloseCircleOutlined />} color="default">Atlandı</Tag>
                  : r.success
                    ? <Tag icon={<CheckCircleOutlined />} color="green">Başarılı</Tag>
                    : <Tag icon={<CloseCircleOutlined />} color="red">Hata</Tag>,
            },
            {
              title: 'Hata', dataIndex: 'error',
              render: (e: string | null | undefined) =>
                e ? <Text style={{ color: '#ef4444', fontSize: 12 }}>{e}</Text> : <Text style={{ color: C.dim }}>—</Text>,
            },
          ]}
        />
      )}
    </Modal>
  )
}

// ─── Main page ─────────────────────────────────────────────────────────────

export default function ConfigBuilderPage() {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const { message } = App.useApp()
  const canPush = useAuthStore((s) => s.can('config_backups', 'edit'))

  const [selectedOpKey, setSelectedOpKey] = useState<string | null>(null)
  const [params, setParams] = useState<Record<string, unknown>>({})
  const [deviceIds, setDeviceIds] = useState<number[]>([])
  const [previewOpen, setPreviewOpen] = useState(false)
  const [pushModalOpen, setPushModalOpen] = useState(false)

  const { data: operations = [], error: opsError, isLoading: opsLoading } = useQuery({
    queryKey: ['config-builder-operations'],
    queryFn: () => configBuilderApi.listOperations(),
    staleTime: 600_000,
    retry: 1,
  })

  const { data: devicesData } = useQuery({
    queryKey: ['devices-for-builder'],
    queryFn: () => devicesApi.list({ limit: 500 }),
    staleTime: 60_000,
  })

  // Auto-select first op once loaded
  useEffect(() => {
    if (!selectedOpKey && operations.length) {
      setSelectedOpKey(operations[0].key)
    }
  }, [operations, selectedOpKey])

  const selectedOp = operations.find((o) => o.key === selectedOpKey)

  // Reset params when operation changes — load defaults.
  useEffect(() => {
    if (!selectedOp) return
    const next: Record<string, unknown> = {}
    for (const f of selectedOp.fields) {
      if (f.default !== null && f.default !== undefined) next[f.name] = f.default
    }
    setParams(next)
  }, [selectedOpKey])

  const previewMut = useMutation({
    mutationFn: () =>
      configBuilderApi.preview(selectedOp!.key, params, deviceIds, true),
    onSuccess: () => setPreviewOpen(true),
    onError: (e: any) =>
      message.error(e?.response?.data?.detail || 'Önizleme alınamadı', 5),
  })

  const validateParams = (): string | null => {
    if (!selectedOp) return 'Önce bir işlem seçin.'
    if (!deviceIds.length) return 'En az bir cihaz seçin.'
    for (const f of selectedOp.fields) {
      const v = params[f.name]
      if (f.required && (v === undefined || v === '' || v === null)) {
        return `'${f.label}' zorunlu.`
      }
    }
    return null
  }

  const handlePreview = () => {
    const err = validateParams()
    if (err) { message.warning(err); return }
    previewMut.mutate()
  }

  const handlePushClick = () => {
    if (!previewMut.data) return
    if (previewMut.data.supported_count === 0) {
      message.warning('Uygulanabilir cihaz yok — preview hata satırlarını gözden geçirin.')
      return
    }
    setPushModalOpen(true)
  }

  const devicesById = useMemo(
    () => Object.fromEntries((devicesData?.items || []).map((d: Device) => [d.id, d])),
    [devicesData],
  )

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>Ağ Operasyonları</span><span>Easy Config Builder</span></div>
          <h1 className="nm-page-title">
            Easy Config Builder
            <span className="nm-pill mono">{operations.length} işlem</span>
            <Tag color="purple" style={{ fontSize: 10, fontWeight: 600 }}>T9 Tur 5 · #11</Tag>
          </h1>
          <div className="nm-page-sub">
            CLI yazmadan VLAN ekle, port etiketle, NTP/syslog/SNMP ayarla. Form-driven sihirbaz vendor'a göre doğru komutu üretir, dry-run önizleme ile başlar.
          </div>
        </div>
      </div>

      {!opsLoading && operations.length === 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="Operasyon listesi yüklenemedi"
          description={
            <div>
              <div>Backend <Text code style={{ fontSize: 11 }}>GET /api/v1/config-builder/operations</Text> isteği boş döndü.</div>
              <div style={{ marginTop: 6, fontSize: 12 }}>
                Olası sebep: Backend container yeni endpoint'leri yüklemek için <b>yeniden başlatılmamış</b>.
                Local'de: <Text code style={{ fontSize: 11 }}>docker-compose restart backend</Text> ·
                VPS'te: deploy script'ini yeniden çalıştırın.
              </div>
              {opsError && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#ef4444', fontFamily: 'monospace' }}>
                  Detay: {(opsError as any)?.response?.data?.detail || (opsError as Error).message || 'bilinmeyen hata'}
                </div>
              )}
            </div>
          }
        />
      )}

      <Row gutter={14}>
        {/* Left: operation picker */}
        <Col span={7}>
          <Card
            size="small"
            title={
              <Space>
                <ToolOutlined style={{ color: '#3b82f6' }} />
                <Text strong>İşlem Seç</Text>
              </Space>
            }
            style={{ background: C.bg, border: `1px solid ${C.border}` }}
            styles={{ body: { padding: 12, maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' } }}
          >
            <OperationPicker
              operations={operations}
              selected={selectedOpKey}
              onSelect={setSelectedOpKey}
              isDark={isDark}
            />
          </Card>
        </Col>

        {/* Middle: form */}
        <Col span={9}>
          <Card
            size="small"
            title={
              <Space>
                {selectedOp && (ICON_MAP[selectedOp.icon] || <ToolOutlined />)}
                <Text strong>{selectedOp?.label || 'Detaylar'}</Text>
                {selectedOp && (
                  <Tag color={CATEGORY_COLOR[selectedOp.category] || 'default'} style={{ fontSize: 10, marginLeft: 4 }}>
                    {CATEGORY_LABEL[selectedOp.category] || selectedOp.category}
                  </Tag>
                )}
              </Space>
            }
            style={{ background: C.bg, border: `1px solid ${C.border}` }}
          >
            {selectedOp ? (
              <>
                <Text style={{ color: C.muted, fontSize: 12, marginBottom: 12, display: 'block' }}>
                  {selectedOp.description}
                </Text>
                <OperationForm
                  operation={selectedOp}
                  value={params}
                  onChange={setParams}
                  isDark={isDark}
                />
              </>
            ) : (
              <Text style={{ color: C.muted }}>Soldaki listeden bir işlem seçin.</Text>
            )}
          </Card>
        </Col>

        {/* Right: device picker + actions */}
        <Col span={8}>
          <Card
            size="small"
            title={
              <Space>
                <ApiOutlined style={{ color: '#3b82f6' }} />
                <Text strong>Cihazlar</Text>
                <Tag color="blue">{deviceIds.length} seçili</Tag>
              </Space>
            }
            style={{ background: C.bg, border: `1px solid ${C.border}` }}
          >
            <Select
              mode="multiple"
              showSearch
              placeholder="Cihaz(lar) seçin"
              style={{ width: '100%' }}
              value={deviceIds}
              onChange={setDeviceIds}
              optionFilterProp="label"
              maxTagCount="responsive"
              options={(devicesData?.items || []).map((d: Device) => ({
                value: d.id,
                label: `${d.hostname} — ${d.ip_address} (${d.os_type || '?'})`,
              }))}
            />
            {deviceIds.length > 0 && selectedOp && (
              <div style={{ marginTop: 10 }}>
                <Text style={{ color: C.muted, fontSize: 11 }}>
                  Vendor uyumluluğu (operasyon: <Text code style={{ fontSize: 10 }}>{selectedOp.key}</Text>):
                </Text>
                <div style={{ marginTop: 4 }}>
                  {deviceIds.map((id) => {
                    const d = devicesById[id]
                    if (!d) return null
                    const ok = selectedOp.supported_vendors.includes(d.os_type || '')
                    return (
                      <Tooltip key={id} title={ok ? 'Bu vendor destekleniyor' : `Bu işlem ${d.os_type || '?'} için tanımlı değil`}>
                        <Tag
                          color={ok ? 'green' : 'red'}
                          style={{ marginBottom: 4, fontSize: 11 }}
                          icon={ok ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                        >
                          {d.hostname}
                        </Tag>
                      </Tooltip>
                    )
                  })}
                </div>
              </div>
            )}

            <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Button
                type="default"
                icon={<FileTextOutlined />}
                onClick={handlePreview}
                loading={previewMut.isPending}
                block
                disabled={!selectedOp}
              >
                CLI Önizleme (dry-run)
              </Button>
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                danger
                onClick={handlePushClick}
                disabled={!canPush || !previewMut.data || previewMut.data.supported_count === 0}
                block
              >
                Cihazlara Uygula
              </Button>
              {!canPush && (
                <Text style={{ fontSize: 11, color: C.muted, textAlign: 'center' }}>
                  Bu işlem için yetkiniz yok (ORG_ADMIN+ gerekli).
                </Text>
              )}
            </div>
          </Card>
        </Col>
      </Row>

      {/* Preview modal */}
      <Modal
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        title={
          <Space>
            <FileTextOutlined style={{ color: '#3b82f6' }} />
            <Text strong>CLI Önizleme — {selectedOp?.label}</Text>
            {previewMut.data && (
              <>
                <Badge status="success" text={`${previewMut.data.supported_count} hazır`} />
                {previewMut.data.error_count > 0 && (
                  <Badge status="error" text={`${previewMut.data.error_count} hatalı`} />
                )}
              </>
            )}
          </Space>
        }
        width={820}
        footer={[
          <Button key="cancel" onClick={() => setPreviewOpen(false)}>Kapat</Button>,
          <Button
            key="push"
            type="primary"
            danger
            icon={<ThunderboltOutlined />}
            disabled={!canPush || !previewMut.data || previewMut.data.supported_count === 0}
            onClick={() => { setPreviewOpen(false); setPushModalOpen(true) }}
          >
            Şimdi Uygula ({previewMut.data?.supported_count ?? 0} cihaz)
          </Button>,
        ]}
        styles={{
          content: { background: C.bg, border: `1px solid ${C.border}` },
          header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
        }}
      >
        {previewMut.isPending && <div style={{ textAlign: 'center', padding: 30 }}><Spin /></div>}
        {previewMut.data && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {previewMut.data.items.map((it) => (
              <Card
                key={it.device_id}
                size="small"
                style={{
                  background: it.error ? (isDark ? '#7f1d1d18' : '#fef2f2') : C.bg2,
                  border: `1px solid ${it.error ? '#ef444460' : C.border}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  {it.error ? (
                    <CloseCircleOutlined style={{ color: '#ef4444' }} />
                  ) : (
                    <CheckCircleOutlined style={{ color: '#22c55e' }} />
                  )}
                  <Text strong style={{ color: C.text }}>{it.hostname}</Text>
                  <Tag color="default" style={{ fontSize: 10 }}>{it.os_type || '?'}</Tag>
                  {it.error && <Tag color="red" style={{ fontSize: 11, marginLeft: 'auto' }}>{it.error}</Tag>}
                </div>
                {it.commands.length > 0 && (
                  <pre style={{
                    background: isDark ? '#0d1117' : '#f8fafc',
                    border: `1px solid ${C.border}`,
                    borderRadius: 4, padding: '6px 10px',
                    margin: 0, fontSize: 11, fontFamily: 'monospace',
                    color: C.text, lineHeight: 1.5, whiteSpace: 'pre',
                  }}>
                    {it.commands.join('\n')}
                  </pre>
                )}
              </Card>
            ))}
          </div>
        )}
      </Modal>

      {/* Push confirmation + result modal */}
      {selectedOp && (
        <PushConfirmModal
          open={pushModalOpen}
          onClose={() => setPushModalOpen(false)}
          operation={selectedOp}
          params={params}
          deviceIds={deviceIds}
          items={previewMut.data?.items ?? []}
          isDark={isDark}
        />
      )}
    </div>
  )
}
