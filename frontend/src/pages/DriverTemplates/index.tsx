import { useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Col,
  Descriptions,
  Drawer,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  BulbOutlined,
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  HeartOutlined,
  PlusOutlined,
  ScanOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { devicesApi } from '@/api/devices'
import {
  COMMAND_TYPE_OPTIONS,
  OS_TYPE_OPTIONS,
  driverTemplatesApi,
  type AISuggestResponse,
  type CommandExecution,
  type DriverTemplate,
  type DriverTemplatePayload,
  type ProbeDeviceResponse,
  type TemplateHealthSummary,
} from '@/api/driverTemplates'
import { useTheme } from '@/contexts/ThemeContext'

const { TextArea } = Input
const { Text, Title } = Typography

// Select that falls back to free-text when the typed value isn't in the list
function CreatableSelect({
  options,
  placeholder,
  value,
  onChange,
}: {
  options: { value: string; label: string }[]
  placeholder?: string
  value?: string
  onChange?: (v: string) => void
}) {
  const [search, setSearch] = useState('')

  const displayOptions = useMemo(() => {
    const lower = search.toLowerCase()
    const filtered = options.filter(
      (o) => o.label.toLowerCase().includes(lower) || o.value.toLowerCase().includes(lower),
    )
    const exactMatch = options.some((o) => o.value === search)
    if (search && !exactMatch) {
      filtered.push({ value: search, label: `"${search}" — yeni ekle` })
    }
    return filtered
  }, [options, search])

  return (
    <Select
      showSearch
      value={value}
      onChange={onChange}
      onSearch={setSearch}
      filterOption={false}
      placeholder={placeholder ?? 'Seçin veya yazın...'}
      options={displayOptions}
    />
  )
}

const PARSER_COLORS: Record<string, string> = {
  regex: 'blue',
  textfsm: 'purple',
  raw: 'default',
}

function osLabel(val: string) {
  return OS_TYPE_OPTIONS.find((o) => o.value === val)?.label ?? val
}
function cmdLabel(val: string) {
  return COMMAND_TYPE_OPTIONS.find((o) => o.value === val)?.label ?? val
}

// ---------------------------------------------------------------------------
// Template form drawer
// ---------------------------------------------------------------------------
interface TemplateFormProps {
  open: boolean
  initial?: DriverTemplate | null
  onClose: () => void
  onSaved: () => void
}

function TemplateFormDrawer({ open, initial, onClose, onSaved }: TemplateFormProps) {
  const [form] = Form.useForm()
  const qc = useQueryClient()
  const isEdit = !!initial

  const saveMutation = useMutation({
    mutationFn: (vals: DriverTemplatePayload) =>
      isEdit ? driverTemplatesApi.update(initial!.id, vals) : driverTemplatesApi.create(vals),
    onSuccess: () => {
      message.success(isEdit ? 'Güncellendi' : 'Oluşturuldu')
      qc.invalidateQueries({ queryKey: ['driver-templates'] })
      onSaved()
      form.resetFields()
    },
    onError: () => message.error('Kayıt başarısız'),
  })

  const [testResult, setTestResult] = useState<unknown>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const handleTestParse = async () => {
    const vals = form.getFieldsValue()
    setTesting(true)
    setTestResult(null)
    setTestError(null)
    try {
      const res = await driverTemplatesApi.testParse({
        parser_type: vals.parser_type,
        parser_template: vals.parser_template || null,
        raw_output: vals.sample_output || '',
      })
      if (res.success) setTestResult(res.parsed_result)
      else setTestError(res.error || 'Parse hatası')
    } catch {
      setTestError('İstek başarısız')
    } finally {
      setTesting(false)
    }
  }

  return (
    <Drawer
      title={isEdit ? 'Şablonu Düzenle' : 'Yeni Şablon'}
      open={open}
      onClose={onClose}
      width={640}
      extra={
        <Button type="primary" loading={saveMutation.isPending} onClick={() => form.submit()}>
          Kaydet
        </Button>
      }
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={initial ?? { parser_type: 'raw', is_verified: true, is_active: true }}
        onFinish={(vals) => saveMutation.mutate(vals)}
      >
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="os_type" label="OS Tipi" rules={[{ required: true }]}>
              <CreatableSelect options={OS_TYPE_OPTIONS} placeholder="Marka seçin veya yeni yazın..." />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="command_type" label="Komut Tipi" rules={[{ required: true }]}>
              <CreatableSelect options={COMMAND_TYPE_OPTIONS} placeholder="Komut tipi seçin veya yazın..." />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="os_version_pattern" label="OS Versiyon Deseni (regex, boş = hepsi)">
          <Input placeholder="örn: 15\.[0-9]+" />
        </Form.Item>
        <Form.Item name="command_string" label="CLI Komut" rules={[{ required: true }]}>
          <Input placeholder="örn: show lldp neighbors detail" />
        </Form.Item>
        <Row gutter={12}>
          <Col span={8}>
            <Form.Item name="parser_type" label="Parser Tipi">
              <Select>
                <Select.Option value="raw">Raw (ham metin)</Select.Option>
                <Select.Option value="regex">Regex</Select.Option>
                <Select.Option value="textfsm">TextFSM</Select.Option>
              </Select>
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="is_verified" label="Doğrulandı" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="is_active" label="Aktif" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="parser_template" label="Parser Template (regex deseni veya TextFSM gövdesi)">
          <TextArea rows={6} style={{ fontFamily: 'monospace', fontSize: 12 }} />
        </Form.Item>
        <Form.Item name="sample_output" label="Örnek Çıktı (test için)">
          <TextArea rows={6} style={{ fontFamily: 'monospace', fontSize: 12 }} />
        </Form.Item>
        <Form.Item>
          <Button icon={<ExperimentOutlined />} onClick={handleTestParse} loading={testing}>
            Parse Test Et
          </Button>
        </Form.Item>
        {testError && <Alert type="error" message={testError} showIcon style={{ marginBottom: 8 }} />}
        {testResult !== null && (
          <Alert
            type="success"
            showIcon
            message="Parse başarılı"
            description={
              <pre style={{ fontSize: 11, maxHeight: 200, overflow: 'auto', margin: 0 }}>
                {JSON.stringify(testResult, null, 2)}
              </pre>
            }
          />
        )}
        <Form.Item name="notes" label="Notlar" style={{ marginTop: 12 }}>
          <TextArea rows={2} />
        </Form.Item>
      </Form>
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// AI Suggest modal
// ---------------------------------------------------------------------------
function AISuggestModal({ onAccept }: { onAccept: (data: AISuggestResponse & { os_type: string; command_type: string }) => void }) {
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const [result, setResult] = useState<AISuggestResponse | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSuggest = async () => {
    const vals = form.getFieldsValue()
    if (!vals.os_type || !vals.command_type || !vals.raw_output) {
      message.warning('OS tipi, komut tipi ve ham çıktı zorunlu')
      return
    }
    setLoading(true)
    setResult(null)
    try {
      const res = await driverTemplatesApi.aiSuggest(vals)
      setResult(res)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } } }
      message.error(err?.response?.data?.detail || 'AI önerisi alınamadı')
    } finally {
      setLoading(false)
    }
  }

  const handleAccept = () => {
    if (!result) return
    const vals = form.getFieldsValue()
    onAccept({ ...result, os_type: vals.os_type, command_type: vals.command_type })
    setOpen(false)
    setResult(null)
    form.resetFields()
  }

  return (
    <>
      <Button icon={<BulbOutlined />} onClick={() => setOpen(true)}>
        AI ile Şablon Üret
      </Button>
      <Modal
        title="AI Destekli Şablon Üretici"
        open={open}
        onCancel={() => setOpen(false)}
        width={720}
        footer={
          <Space>
            <Button onClick={() => setOpen(false)}>Kapat</Button>
            <Button onClick={handleSuggest} loading={loading} type="default">
              AI'a Sor
            </Button>
            {result && (
              <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleAccept}>
                Şablon Olarak Kaydet
              </Button>
            )}
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="os_type" label="OS Tipi" rules={[{ required: true }]}>
                <CreatableSelect options={OS_TYPE_OPTIONS} placeholder="Marka seçin veya yeni yazın..." />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="command_type" label="Komut Tipi" rules={[{ required: true }]}>
                <CreatableSelect options={COMMAND_TYPE_OPTIONS} placeholder="Komut tipi seçin veya yazın..." />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="firmware_version" label="Firmware Versiyonu (opsiyonel)">
            <Input placeholder="örn: 15.2(4)E8" />
          </Form.Item>
          <Form.Item name="raw_output" label="Cihazdan Alınan Ham CLI Çıktısı" rules={[{ required: true }]}>
            <TextArea rows={8} style={{ fontFamily: 'monospace', fontSize: 12 }} placeholder="Cihazdan aldığınız show komutu çıktısını buraya yapıştırın..." />
          </Form.Item>
        </Form>

        {result && (
          <div style={{ marginTop: 12 }}>
            <Alert
              type="success"
              showIcon
              message={`Komut: ${result.command_string}`}
              description={
                <>
                  <Text type="secondary" style={{ fontSize: 12 }}>{result.explanation}</Text>
                  <pre style={{ marginTop: 8, fontSize: 11, maxHeight: 200, overflow: 'auto', background: 'rgba(0,0,0,0.05)', padding: 8, borderRadius: 4 }}>
                    {result.parser_template}
                  </pre>
                  {result.parsed_result != null && (
                    <>
                      <Text style={{ fontSize: 12, fontWeight: 600 }}>Parse Sonucu:</Text>
                      <pre style={{ fontSize: 11, maxHeight: 150, overflow: 'auto', background: 'rgba(0,0,0,0.05)', padding: 8, borderRadius: 4 }}>
                        {JSON.stringify(result.parsed_result, null, 2)}
                      </pre>
                    </>
                  )}
                </>
              }
            />
          </div>
        )}
      </Modal>
    </>
  )
}

// ---------------------------------------------------------------------------
// Health dashboard
// ---------------------------------------------------------------------------
function HealthDashboard() {
  const { isDark } = useTheme()

  const { data: health = [], isLoading: hLoading } = useQuery({
    queryKey: ['driver-templates-health'],
    queryFn: driverTemplatesApi.getHealth,
    refetchInterval: 60_000,
  })

  const { data: failures = [], isLoading: fLoading } = useQuery({
    queryKey: ['driver-template-executions-fail'],
    queryFn: () => driverTemplatesApi.getExecutions({ parse_success: false, limit: 30 }),
    refetchInterval: 60_000,
  })

  const healthColor = (s: string) =>
    s === 'healthy' ? 'green' : s === 'warning' ? 'orange' : s === 'broken' ? 'red' : 'default'

  const healthCols = [
    {
      title: 'OS Tipi',
      dataIndex: 'os_type',
      render: (v: string) => <Tag>{osLabel(v)}</Tag>,
    },
    {
      title: 'Komut',
      dataIndex: 'command_type',
      render: (v: string) => cmdLabel(v),
    },
    {
      title: 'Sağlık',
      dataIndex: 'health_status',
      render: (v: string) => <Tag color={healthColor(v)}>{v.toUpperCase()}</Tag>,
    },
    {
      title: 'Başarı Oranı',
      dataIndex: 'success_rate',
      render: (v: number | null, r: TemplateHealthSummary) => {
        if (v === null) return <Text type="secondary">—</Text>
        return (
          <Tooltip title={`${r.success_count} başarı / ${r.failure_count} hata`}>
            <Progress
              percent={Math.round(v * 100)}
              size="small"
              strokeColor={v >= 0.8 ? '#52c41a' : v >= 0.5 ? '#fa8c16' : '#ff4d4f'}
              style={{ width: 120 }}
            />
          </Tooltip>
        )
      },
    },
    {
      title: 'Son Hata',
      dataIndex: 'last_failure_at',
      render: (v: string | null) =>
        v ? <Text type="secondary" style={{ fontSize: 12 }}>{new Date(v).toLocaleString('tr-TR')}</Text> : '—',
    },
  ]

  const execCols = [
    {
      title: 'Cihaz ID',
      dataIndex: 'device_id',
      width: 80,
    },
    {
      title: 'Komut Tipi',
      dataIndex: 'command_type',
      render: (v: string) => cmdLabel(v),
    },
    {
      title: 'Komut',
      dataIndex: 'command_string',
      render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text>,
    },
    {
      title: 'Hata',
      dataIndex: 'error_message',
      render: (v: string | null) =>
        v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : '—',
    },
    {
      title: 'Zaman',
      dataIndex: 'created_at',
      render: (v: string) =>
        <Text type="secondary" style={{ fontSize: 12 }}>{new Date(v).toLocaleString('tr-TR')}</Text>,
    },
  ]

  return (
    <div>
      {health.length === 0 && !hLoading && (
        <Alert
          type="success"
          showIcon
          message="Tüm şablonlar sağlıklı"
          description="Yeterli veri olan şablonlarda sorun tespit edilmedi."
          style={{ marginBottom: 16 }}
        />
      )}

      {health.length > 0 && (
        <>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            Sorunlu Şablonlar ({health.length})
          </Text>
          <Table
            dataSource={health}
            columns={healthCols}
            rowKey="template_id"
            loading={hLoading}
            size="small"
            pagination={false}
            style={{ marginBottom: 24 }}
            rowClassName={(r) =>
              r.health_status === 'broken'
                ? (isDark ? 'ant-table-row-warning-dark' : 'ant-table-row-warning')
                : ''
            }
          />
        </>
      )}

      <Text strong style={{ display: 'block', marginBottom: 8 }}>
        Son Parse Hataları
      </Text>
      <Table
        dataSource={failures as CommandExecution[]}
        columns={execCols}
        rowKey="id"
        loading={fLoading}
        size="small"
        pagination={{ pageSize: 10 }}
        expandable={{
          expandedRowRender: (r: CommandExecution) =>
            r.raw_output ? (
              <pre style={{
                fontSize: 11,
                maxHeight: 200,
                overflow: 'auto',
                background: isDark ? 'rgba(0,0,0,0.3)' : '#f8fafc',
                padding: 8,
                borderRadius: 4,
              }}>
                {r.raw_output.slice(0, 2000)}
              </pre>
            ) : <Text type="secondary">Raw output yok</Text>,
          rowExpandable: (r: CommandExecution) => !!r.raw_output,
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Probe device modal
// ---------------------------------------------------------------------------
function ProbeDeviceModal({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [deviceId, setDeviceId] = useState<number | null>(null)
  const [result, setResult] = useState<ProbeDeviceResponse | null>(null)
  const [loading, setLoading] = useState(false)

  const { data: devices = [] } = useQuery({
    queryKey: ['devices-list-probe'],
    queryFn: () => devicesApi.list({ limit: 500 }).then((r) => 'items' in r ? r.items : r as never[]),
    enabled: open,
  })

  const handleProbe = async () => {
    if (!deviceId) { message.warning('Cihaz seçin'); return }
    setLoading(true)
    setResult(null)
    try {
      const res = await driverTemplatesApi.probeDevice(deviceId)
      setResult(res)
      onDone()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } } }
      message.error(err?.response?.data?.detail || 'Tarama başarısız')
    } finally {
      setLoading(false)
    }
  }

  const statusColor = (s: string) =>
    s === 'created' ? 'green' : s === 'error' ? 'red' : 'default'

  return (
    <>
      <Button icon={<ScanOutlined />} onClick={() => setOpen(true)}>
        Cihazı Otomatik Tara
      </Button>
      <Modal
        title="Cihaz Otomatik Tarama"
        open={open}
        onCancel={() => { setOpen(false); setResult(null) }}
        width={680}
        footer={
          <Space>
            <Button onClick={() => { setOpen(false); setResult(null) }}>Kapat</Button>
            <Button type="primary" icon={<ScanOutlined />} loading={loading} onClick={handleProbe}>
              Taramayı Başlat
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          message="Ne yapar?"
          description="SSH ile cihaza bağlanır, show version çıktısını AI'a gönderir; marka/model/firmware tespiti yapar. Eksik komut şablonları için her komutun çıktısını alıp otomatik parser üretir."
          style={{ marginBottom: 16 }}
        />
        <Select
          showSearch
          style={{ width: '100%', marginBottom: 16 }}
          placeholder="Cihaz seçin..."
          optionFilterProp="label"
          onChange={(v) => setDeviceId(v as number)}
          options={(devices as Array<{ id: number; hostname: string; ip_address: string; os_type: string }>).map((d) => ({
            value: d.id,
            label: `${d.hostname} (${d.ip_address}) — ${d.os_type}`,
          }))}
        />
        {loading && (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <Spin size="large" />
            <div style={{ marginTop: 12, color: '#64748b' }}>
              Cihaza bağlanıyor, komutları çalıştırıyor ve AI şablon üretiyor...
            </div>
          </div>
        )}
        {result && !loading && (
          <>
            <Descriptions size="small" bordered column={2} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="Tespit Edilen Marka">{result.detected_vendor || '—'}</Descriptions.Item>
              <Descriptions.Item label="Model">{result.detected_model || '—'}</Descriptions.Item>
              <Descriptions.Item label="Firmware">{result.detected_firmware || '—'}</Descriptions.Item>
              <Descriptions.Item label="OS Tipi">{result.detected_os_type || '—'}</Descriptions.Item>
              <Descriptions.Item label="Oluşturulan Şablon">
                <Tag color="green">{result.templates_created}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Mevcut (Atlandı)">
                <Tag>{result.templates_skipped}</Tag>
              </Descriptions.Item>
            </Descriptions>
            <List
              size="small"
              dataSource={result.details}
              renderItem={(item) => (
                <List.Item>
                  <Space>
                    <Tag color={statusColor(item.status)}>{item.status.toUpperCase()}</Tag>
                    <Text strong style={{ fontSize: 12 }}>{item.command_type}</Text>
                    {item.command_string && <Text code style={{ fontSize: 11 }}>{item.command_string}</Text>}
                    {item.reason && <Text type="secondary" style={{ fontSize: 11 }}>{item.reason}</Text>}
                  </Space>
                </List.Item>
              )}
            />
          </>
        )}
      </Modal>
    </>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function DriverTemplatesPage() {
  const { isDark } = useTheme()
  const qc = useQueryClient()
  const [filterOS, setFilterOS] = useState<string | undefined>()
  const [filterCmd, setFilterCmd] = useState<string | undefined>()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<DriverTemplate | null>(null)

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['driver-templates', filterOS, filterCmd],
    queryFn: () => driverTemplatesApi.list({ os_type: filterOS, command_type: filterCmd }),
  })

  const deleteMutation = useMutation({
    mutationFn: driverTemplatesApi.delete,
    onSuccess: () => {
      message.success('Silindi')
      qc.invalidateQueries({ queryKey: ['driver-templates'] })
    },
  })

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) =>
      driverTemplatesApi.update(id, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['driver-templates'] }),
  })

  const verifyMutation = useMutation({
    mutationFn: (id: number) => driverTemplatesApi.update(id, { is_verified: true }),
    onSuccess: () => {
      message.success('Doğrulandı')
      qc.invalidateQueries({ queryKey: ['driver-templates'] })
    },
  })

  const handleAIAccept = async (_data: AISuggestResponse & { os_type: string; command_type: string }) => {
    // AI already saved as unverified — just refresh
    qc.invalidateQueries({ queryKey: ['driver-templates'] })
    message.success('AI şablonu eklendi — doğrulamak için onaylayın')
  }

  const unverifiedCount = templates.filter((t) => !t.is_verified).length

  const columns = [
    {
      title: 'OS Tipi',
      dataIndex: 'os_type',
      width: 170,
      render: (v: string) => <Tag>{osLabel(v)}</Tag>,
    },
    {
      title: 'Versiyon',
      dataIndex: 'os_version_pattern',
      width: 120,
      render: (v: string | null) => v ? <Text code style={{ fontSize: 11 }}>{v}</Text> : <Text type="secondary" style={{ fontSize: 11 }}>Tümü</Text>,
    },
    {
      title: 'Komut Tipi',
      dataIndex: 'command_type',
      width: 170,
      render: (v: string) => cmdLabel(v),
    },
    {
      title: 'CLI Komutu',
      dataIndex: 'command_string',
      render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text>,
    },
    {
      title: 'Parser',
      dataIndex: 'parser_type',
      width: 90,
      render: (v: string) => <Tag color={PARSER_COLORS[v] ?? 'default'}>{v.toUpperCase()}</Tag>,
    },
    {
      title: 'Sağlık',
      width: 130,
      render: (_: unknown, r: DriverTemplate) => {
        const total = r.success_count + r.failure_count
        if (total < 5) return <Tag color="default">Yeni</Tag>
        const pct = Math.round((r.success_rate ?? 0) * 100)
        const color = r.health_status === 'healthy' ? 'green'
          : r.health_status === 'warning' ? 'orange' : 'red'
        return (
          <Tooltip title={`${r.success_count} başarı / ${r.failure_count} hata`}>
            <Progress
              percent={pct}
              size="small"
              strokeColor={color === 'green' ? '#52c41a' : color === 'orange' ? '#fa8c16' : '#ff4d4f'}
              format={(p) => `${p}%`}
              style={{ width: 100 }}
            />
          </Tooltip>
        )
      },
    },
    {
      title: 'Durum',
      width: 120,
      render: (_: unknown, r: DriverTemplate) => (
        <Space>
          {r.is_verified
            ? <Tag color="green" icon={<CheckCircleOutlined />}>Doğrulandı</Tag>
            : <Tag color="orange" icon={<WarningOutlined />}>Bekliyor</Tag>}
        </Space>
      ),
    },
    {
      title: 'Aktif',
      dataIndex: 'is_active',
      width: 70,
      render: (v: boolean, r: DriverTemplate) => (
        <Switch
          size="small"
          checked={v}
          onChange={(checked) => toggleActiveMutation.mutate({ id: r.id, is_active: checked })}
        />
      ),
    },
    {
      title: '',
      width: 120,
      render: (_: unknown, r: DriverTemplate) => (
        <Space>
          {!r.is_verified && (
            <Tooltip title="Doğrula">
              <Button
                size="small"
                type="primary"
                icon={<CheckCircleOutlined />}
                onClick={() => verifyMutation.mutate(r.id)}
              />
            </Tooltip>
          )}
          <Tooltip title="Düzenle">
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => { setEditing(r); setDrawerOpen(true) }}
            />
          </Tooltip>
          <Popconfirm title="Silinsin mi?" onConfirm={() => deleteMutation.mutate(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const templateTable = (
    <>
      {unverifiedCount > 0 && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message={`${unverifiedCount} adet AI tarafından üretilen şablon doğrulama bekliyor`}
          description="AI şablonları cihazda test edilene kadar doğrulanmış sayılmaz. Düzenle → Test Et → Doğrula adımlarını izleyin."
          style={{ marginBottom: 16 }}
          closable
        />
      )}
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col>
          <Select
            allowClear
            placeholder="OS Tipine göre filtrele"
            style={{ width: 200 }}
            options={OS_TYPE_OPTIONS}
            onChange={setFilterOS}
          />
        </Col>
        <Col>
          <Select
            allowClear
            placeholder="Komut tipine göre"
            style={{ width: 200 }}
            options={COMMAND_TYPE_OPTIONS}
            onChange={setFilterCmd}
          />
        </Col>
      </Row>
      <Table
        dataSource={templates}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 30, showTotal: (t) => `${t} şablon` }}
        rowClassName={(r) =>
          !r.is_verified ? (isDark ? 'ant-table-row-warning-dark' : 'ant-table-row-warning') : ''
        }
        expandable={{
          expandedRowRender: (r) => (
            <div style={{ padding: '8px 16px' }}>
              {r.parser_template && (
                <>
                  <Text strong style={{ fontSize: 12 }}>Parser Template:</Text>
                  <pre style={{ fontSize: 11, background: isDark ? 'rgba(0,0,0,0.3)' : '#f8fafc', padding: 8, borderRadius: 4, marginTop: 4, overflow: 'auto' }}>
                    {r.parser_template}
                  </pre>
                </>
              )}
              {r.notes && <Text type="secondary" style={{ fontSize: 12 }}>{r.notes}</Text>}
            </div>
          ),
          rowExpandable: (r) => !!(r.parser_template || r.notes),
        }}
      />
    </>
  )

  return (
    <div style={{ padding: 24 }}>
      <Row align="middle" justify="space-between" style={{ marginBottom: 16 }}>
        <Col>
          <Title level={4} style={{ margin: 0 }}>
            Sürücü Şablonları
            {unverifiedCount > 0 && (
              <Badge count={unverifiedCount} style={{ marginLeft: 8 }} title="Doğrulama bekleyen" />
            )}
          </Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            Vendor komutları ve parser şablonları — AI ile yeni marka / versiyon eklenebilir
          </Text>
        </Col>
        <Col>
          <Space>
            <ProbeDeviceModal onDone={() => qc.invalidateQueries({ queryKey: ['driver-templates'] })} />
            <AISuggestModal onAccept={handleAIAccept} />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => { setEditing(null); setDrawerOpen(true) }}
            >
              Manuel Ekle
            </Button>
          </Space>
        </Col>
      </Row>

      <Tabs
        items={[
          {
            key: 'templates',
            label: <span>Şablonlar</span>,
            children: templateTable,
          },
          {
            key: 'health',
            label: (
              <span>
                <HeartOutlined /> Parser Sağlığı
              </span>
            ),
            children: <HealthDashboard />,
          },
        ]}
      />

      <TemplateFormDrawer
        open={drawerOpen}
        initial={editing}
        onClose={() => { setDrawerOpen(false); setEditing(null) }}
        onSaved={() => { setDrawerOpen(false); setEditing(null) }}
      />
    </div>
  )
}
