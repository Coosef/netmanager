import { useState } from 'react'
import {
  Alert, App, Button, Checkbox, Col, Collapse, Divider, Drawer,
  Empty, Form, Input, Modal, Popconfirm, Row, Select, Space, Table,
  Tag, Tooltip, Typography,
} from 'antd'
import {
  CheckCircleOutlined, CloseCircleOutlined, CodeOutlined,
  DeleteOutlined, EditOutlined, PlusOutlined, RocketOutlined,
  EyeOutlined, CopyOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { configTemplatesApi, type ConfigTemplate, type TemplateVariable } from '@/api/configTemplates'
import { devicesApi } from '@/api/devices'
import { OS_TYPE_OPTIONS } from '@/types'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'

const { Text } = Typography
const { TextArea } = Input

const TEMPLATES_CSS = `
@keyframes tplRowIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
`

function mkC(isDark: boolean) {
  return {
    bg:     isDark ? '#1e293b' : '#ffffff',
    bg2:    isDark ? '#0f172a' : '#f8fafc',
    border: isDark ? '#334155' : '#e2e8f0',
    text:   isDark ? '#f1f5f9' : '#1e293b',
    muted:  isDark ? '#64748b' : '#94a3b8',
    dim:    isDark ? '#475569' : '#cbd5e1',
  }
}

const BUILT_IN_TEMPLATES = [
  {
    name: 'NTP Sunucu Yapılandırması',
    description: 'Cisco/Ruijie cihazlarda NTP sunucu ayarı',
    os_types: ['cisco_ios', 'cisco_xe', 'ruijie_os'],
    template: 'ntp server {ntp_server1}\nntp server {ntp_server2}\nclock timezone {timezone} {offset}',
    variables: [
      { name: 'ntp_server1', label: 'Birincil NTP', default: '0.tr.pool.ntp.org', required: true },
      { name: 'ntp_server2', label: 'İkincil NTP', default: '1.tr.pool.ntp.org', required: false },
      { name: 'timezone', label: 'Timezone', default: 'TRT', required: true },
      { name: 'offset', label: 'UTC Ofset (saat)', default: '3', required: true },
    ],
  },
  {
    name: 'Syslog Sunucu Yapılandırması',
    description: 'Syslog hedef sunucu ve seviye ayarı',
    os_types: ['cisco_ios', 'cisco_xe', 'ruijie_os'],
    template: 'logging host {syslog_server}\nlogging trap {level}\nlogging on',
    variables: [
      { name: 'syslog_server', label: 'Syslog Sunucu IP', default: '', required: true },
      { name: 'level', label: 'Seviye', default: 'informational', required: true },
    ],
  },
  {
    name: 'Banner MOTD',
    description: 'Giriş öncesi gösterilen uyarı mesajı',
    os_types: null,
    template: 'banner motd ^{banner_text}^',
    variables: [
      { name: 'banner_text', label: 'Mesaj', default: 'Yetkisiz erisim yasaktir.', required: true },
    ],
  },
  {
    name: 'AAA Yerel Kullanıcı',
    description: 'Yerel AAA kullanıcı ve şifresi ekler',
    os_types: ['cisco_ios', 'cisco_xe'],
    template: 'username {username} privilege {privilege} secret {password}\naaa new-model\naaa authentication login default local',
    variables: [
      { name: 'username', label: 'Kullanıcı Adı', default: 'netadmin', required: true },
      { name: 'privilege', label: 'Yetki (1-15)', default: '15', required: true },
      { name: 'password', label: 'Parola', default: '', required: true },
    ],
  },
]

function VariableEditor({ value = [], onChange }: {
  value?: TemplateVariable[]
  onChange?: (v: TemplateVariable[]) => void
}) {
  const add = () => onChange?.([...value, { name: '', label: '', default: '', required: false }])
  const remove = (i: number) => onChange?.(value.filter((_, idx) => idx !== i))
  const update = (i: number, field: keyof TemplateVariable, v: string | boolean) => {
    const next = [...value]
    next[i] = { ...next[i], [field]: v }
    onChange?.(next)
  }

  return (
    <div>
      {value.map((vr, i) => (
        <Row key={i} gutter={8} style={{ marginBottom: 6 }} align="middle">
          <Col span={6}>
            <Input
              placeholder="değişken_adı"
              value={vr.name}
              onChange={(e) => update(i, 'name', e.target.value)}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
          </Col>
          <Col span={7}>
            <Input placeholder="Etiket" value={vr.label} onChange={(e) => update(i, 'label', e.target.value)} />
          </Col>
          <Col span={7}>
            <Input placeholder="Varsayılan" value={vr.default ?? ''} onChange={(e) => update(i, 'default', e.target.value)} />
          </Col>
          <Col span={2}>
            <Tooltip title="Zorunlu">
              <Checkbox checked={!!vr.required} onChange={(e) => update(i, 'required', e.target.checked)} />
            </Tooltip>
          </Col>
          <Col span={2}>
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => remove(i)} />
          </Col>
        </Row>
      ))}
      <Button size="small" icon={<PlusOutlined />} onClick={add}>Değişken Ekle</Button>
    </div>
  )
}

function TemplateForm({ initial, onClose }: {
  initial?: ConfigTemplate | null
  onClose: () => void
}) {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [form] = Form.useForm()
  const [previewText, setPreviewText] = useState<string | null>(null)

  const saveMutation = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      initial
        ? configTemplatesApi.update(initial.id, values)
        : configTemplatesApi.create(values),
    onSuccess: () => {
      message.success('Kaydedildi')
      qc.invalidateQueries({ queryKey: ['config-templates'] })
      onClose()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const previewMutation = useMutation({
    mutationFn: async () => {
      const values = form.getFieldsValue()
      const vars: Record<string, string> = {}
      for (const v of (values.variables || [])) {
        if (v.name) vars[v.name] = v.default || ''
      }
      if (!initial && !values.template) return
      const id = initial?.id ?? -1
      if (id < 0) {
        const rendered = values.template?.replace(/{(\w+)}/g, (_: string, k: string) => vars[k] ?? `{${k}}`)
        setPreviewText(rendered)
        return
      }
      const r = await configTemplatesApi.preview(id, vars)
      setPreviewText(r.success ? (r.preview ?? '') : `Hata: ${r.error}`)
    },
  })

  const loadBuiltIn = (tpl: typeof BUILT_IN_TEMPLATES[0]) => {
    form.setFieldsValue(tpl)
    setPreviewText(null)
  }

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={initial ? {
        name: initial.name,
        description: initial.description,
        os_types: initial.os_types,
        template: initial.template,
        variables: initial.variables || [],
      } : { variables: [] }}
      onFinish={(v) => saveMutation.mutate(v)}
    >
      {!initial && (
        <>
          <Text type="secondary" style={{ fontSize: 12 }}>Hazır Şablon Yükle:</Text>
          <Space wrap style={{ marginBottom: 12, marginTop: 4 }}>
            {BUILT_IN_TEMPLATES.map((t) => (
              <Tag
                key={t.name}
                style={{ cursor: 'pointer', fontSize: 11 }}
                onClick={() => loadBuiltIn(t)}
              >
                {t.name}
              </Tag>
            ))}
          </Space>
          <Divider style={{ margin: '8px 0' }} />
        </>
      )}

      <Form.Item label="Şablon Adı" name="name" rules={[{ required: true }]}>
        <Input placeholder="ntp-standart" />
      </Form.Item>

      <Form.Item label="Açıklama" name="description">
        <Input placeholder="Kısa açıklama (opsiyonel)" />
      </Form.Item>

      <Form.Item label="Uyumlu OS Tipleri" name="os_types">
        <Select
          mode="multiple"
          allowClear
          placeholder="— Tüm OS'ler —"
          options={OS_TYPE_OPTIONS}
        />
      </Form.Item>

      <Form.Item
        label="Config Şablonu"
        name="template"
        rules={[{ required: true, message: 'Şablon boş olamaz' }]}
        tooltip="Değişkenler için {değişken_adı} sözdizimi kullanın"
        extra={
          <Text type="secondary" style={{ fontSize: 11 }}>
            Her satır bir config komutu olarak push edilir. Değişkenler: <code style={{ fontFamily: 'monospace' }}>{'{ntp_server}'}</code>
          </Text>
        }
      >
        <TextArea
          rows={8}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
          placeholder={"ntp server {ntp_server}\nlogging host {syslog_server}"}
        />
      </Form.Item>

      <Form.Item label="Değişkenler" name="variables">
        <VariableEditor />
      </Form.Item>

      {previewText !== null && (
        <Alert
          type="info"
          message="Önizleme (varsayılan değerler ile)"
          description={<pre style={{ fontFamily: 'monospace', fontSize: 11, margin: 0, whiteSpace: 'pre-wrap' }}>{previewText}</pre>}
          style={{ marginBottom: 12 }}
          closable
          onClose={() => setPreviewText(null)}
        />
      )}

      <Space>
        <Button type="primary" htmlType="submit" loading={saveMutation.isPending}>
          {initial ? 'Güncelle' : 'Oluştur'}
        </Button>
        <Button
          icon={<EyeOutlined />}
          onClick={() => previewMutation.mutate()}
          loading={previewMutation.isPending}
        >
          Önizle
        </Button>
        <Button onClick={onClose}>İptal</Button>
      </Space>
    </Form>
  )
}

function PushModal({ template, onClose }: { template: ConfigTemplate; onClose: () => void }) {
  const { message } = App.useApp()
  const { activeSite } = useSite()
  const [form] = Form.useForm()
  const [selectedDevices, setSelectedDevices] = useState<number[]>([])
  const [dryRun, setDryRun] = useState(true)
  const [results, setResults] = useState<null | { results: any[]; success_count: number; total: number }>(null)

  const { data: devices = [] } = useQuery({
    queryKey: ['devices-simple', activeSite],
    queryFn: () => devicesApi.list({ limit: 500, site: activeSite || undefined }),
    select: (d: any) => d.items || d,
  })

  const compatDevices = template.os_types
    ? devices.filter((d: any) => template.os_types!.includes(d.os_type))
    : devices

  const pushMutation = useMutation({
    mutationFn: (values: Record<string, string>) =>
      configTemplatesApi.push(template.id, selectedDevices, values, dryRun),
    onSuccess: (data) => {
      setResults(data)
      if (!dryRun) message.success(`${data.success_count}/${data.total} cihaza başarıyla push edildi`)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Push hatası'),
  })

  return (
    <Modal
      title={<><RocketOutlined style={{ marginRight: 8 }} />Push: {template.name}</>}
      open
      onCancel={onClose}
      footer={null}
      width={760}
    >
      {results ? (
        <div>
          <Alert
            type={results.success_count === results.total ? 'success' : 'warning'}
            message={`${results.success_count}/${results.total} cihaz başarılı${dryRun ? ' (Kuru Çalışma)' : ''}`}
            style={{ marginBottom: 12 }}
          />
          <Table
            size="small"
            pagination={false}
            dataSource={results.results}
            rowKey="device_id"
            columns={[
              {
                title: 'Cihaz',
                render: (_: unknown, r: any) => (
                  <Space size={4}>
                    {r.success
                      ? <CheckCircleOutlined style={{ color: '#22c55e' }} />
                      : <CloseCircleOutlined style={{ color: '#ef4444' }} />}
                    <Text strong style={{ fontSize: 13 }}>{r.hostname}</Text>
                  </Space>
                ),
              },
              {
                title: 'Çıktı / Hata',
                render: (_: unknown, r: any) => r.success
                  ? <Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace' }}>{r.output?.slice(0, 120)}</Text>
                  : <Text type="danger" style={{ fontSize: 11 }}>{r.error}</Text>,
              },
            ]}
          />
          <Button style={{ marginTop: 12 }} onClick={() => { setResults(null); setDryRun(false) }}>Gerçek Push Yap</Button>
        </div>
      ) : (
        <>
          <Row gutter={16}>
            <Col span={12}>
              <Text strong style={{ fontSize: 12 }}>Hedef Cihazlar ({selectedDevices.length} seçili)</Text>
              <Select
                mode="multiple"
                style={{ width: '100%', marginTop: 4 }}
                placeholder="Cihaz seçin..."
                value={selectedDevices}
                onChange={setSelectedDevices}
                options={compatDevices.map((d: any) => ({
                  label: `${d.hostname} (${d.ip_address})`,
                  value: d.id,
                }))}
                maxTagCount={3}
              />
              {template.os_types && (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  Sadece uyumlu OS ({template.os_types.join(', ')}) gösteriliyor
                </Text>
              )}
            </Col>
            <Col span={12}>
              <Text strong style={{ fontSize: 12 }}>Değişken Değerleri</Text>
              <Form form={form} layout="vertical" style={{ marginTop: 4 }}>
                {template.variables.map((v) => (
                  <Form.Item
                    key={v.name}
                    name={v.name}
                    label={<Text style={{ fontSize: 12 }}>{v.label} <code style={{ fontSize: 10 }}>{`{${v.name}}`}</code></Text>}
                    initialValue={v.default}
                    rules={[{ required: v.required, message: `${v.label} gerekli` }]}
                    style={{ marginBottom: 8 }}
                  >
                    <Input size="small" style={{ fontFamily: 'monospace' }} />
                  </Form.Item>
                ))}
                {template.variables.length === 0 && (
                  <Text type="secondary" style={{ fontSize: 12 }}>Bu şablonda değişken yok</Text>
                )}
              </Form>
            </Col>
          </Row>

          <Divider style={{ margin: '12px 0' }} />

          <Space>
            <Checkbox checked={dryRun} onChange={(e) => setDryRun(e.target.checked)}>
              Kuru Çalışma (Dry-run) — push yapmadan önizle
            </Checkbox>
          </Space>

          <div style={{ marginTop: 12 }}>
            <Space>
              <Button
                type="primary"
                icon={<RocketOutlined />}
                loading={pushMutation.isPending}
                disabled={selectedDevices.length === 0}
                onClick={() => form.validateFields().then((vals) => pushMutation.mutate(vals))}
              >
                {dryRun ? 'Kuru Çalışma Başlat' : `${selectedDevices.length} Cihaza Push Et`}
              </Button>
              <Button onClick={onClose}>İptal</Button>
            </Space>
            {selectedDevices.length === 0 && (
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>En az 1 cihaz seçin</Text>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}

export default function ConfigTemplatesPage() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<ConfigTemplate | null>(null)
  const [pushing, setPushing] = useState<ConfigTemplate | null>(null)
  const [viewingTemplate, setViewingTemplate] = useState<ConfigTemplate | null>(null)
  const { message } = App.useApp()
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const qc = useQueryClient()

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['config-templates'],
    queryFn: configTemplatesApi.list,
  })

  const deleteMutation = useMutation({
    mutationFn: configTemplatesApi.delete,
    onSuccess: () => {
      message.success('Silindi')
      qc.invalidateQueries({ queryKey: ['config-templates'] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const openNew = () => { setEditing(null); setDrawerOpen(true) }
  const openEdit = (t: ConfigTemplate) => { setEditing(t); setDrawerOpen(true) }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{TEMPLATES_CSS}</style>

      {/* Header */}
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : C.bg,
        border: `1px solid ${isDark ? '#6366f120' : C.border}`,
        borderLeft: '4px solid #6366f1',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: '#6366f120', border: '1px solid #6366f130',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <CodeOutlined style={{ color: '#6366f1', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>Config Şablonları</div>
            <div style={{ color: C.muted, fontSize: 12 }}>Tekrar kullanılabilir yapılandırma şablonları — değişken doldur, cihazlara push et</div>
          </div>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openNew}>
          Yeni Şablon
        </Button>
      </div>

      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
      <Table<ConfigTemplate>
        dataSource={templates}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={false}
        onRow={() => ({ style: { animation: 'tplRowIn 0.2s ease-out' } })}
        locale={{ emptyText: <Empty description="Henüz şablon yok — yukarıdan yeni şablon oluşturun" /> }}
        columns={[
          {
            title: 'Şablon',
            render: (_: unknown, t: ConfigTemplate) => (
              <div>
                <span style={{ fontWeight: 600, fontSize: 13, color: C.text }}>{t.name}</span>
                {t.description && <><br /><span style={{ fontSize: 11, color: C.muted }}>{t.description}</span></>}
              </div>
            ),
          },
          {
            title: 'Uyumlu OS',
            render: (_: unknown, t: ConfigTemplate) =>
              t.os_types?.length
                ? <Space size={4} wrap>{t.os_types.map((o) => <Tag key={o} style={{ fontSize: 10, color: '#06b6d4', borderColor: '#06b6d450', background: '#06b6d418' }}>{o}</Tag>)}</Space>
                : <Tag style={{ fontSize: 10, color: C.muted, borderColor: C.border }}>Tüm OS'ler</Tag>,
          },
          {
            title: 'Değişkenler',
            render: (_: unknown, t: ConfigTemplate) => {
              const cnt = t.variables?.length || 0
              const hex = cnt > 0 ? '#6366f1' : '#64748b'
              return <Tag style={{ fontSize: 11, color: hex, borderColor: hex + '50', background: hex + '18' }}>{cnt} değişken</Tag>
            },
            width: 110,
          },
          {
            title: 'Oluşturan',
            dataIndex: 'created_by',
            width: 110,
            render: (v: string | null) => <span style={{ fontSize: 11, color: C.muted }}>{v || '—'}</span>,
          },
          {
            title: '',
            width: 180,
            render: (_: unknown, t: ConfigTemplate) => (
              <Space size={4}>
                <Tooltip title="Şablonu Görüntüle">
                  <Button size="small" icon={<CodeOutlined />} onClick={() => setViewingTemplate(t)} />
                </Tooltip>
                <Tooltip title="Push Et">
                  <Button size="small" type="primary" icon={<RocketOutlined />} onClick={() => setPushing(t)} />
                </Tooltip>
                <Tooltip title="Düzenle">
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(t)} />
                </Tooltip>
                <Popconfirm
                  title="Bu şablonu silmek istediğinize emin misiniz?"
                  onConfirm={() => deleteMutation.mutate(t.id)}
                  okText="Sil"
                  cancelText="İptal"
                  okButtonProps={{ danger: true }}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
        expandable={{
          expandedRowRender: (t: ConfigTemplate) => (
            <div style={{ padding: '8px 16px', background: C.bg2 }}>
              <Collapse size="small"
                style={{ background: C.bg, border: `1px solid ${C.border}` }}
                items={[{
                  key: '1',
                  label: <span style={{ fontSize: 12, color: C.text }}>Şablon İçeriği</span>,
                  children: (
                    <pre style={{ fontFamily: 'monospace', fontSize: 11, margin: 0, whiteSpace: 'pre-wrap', color: C.text }}>
                      {t.template}
                    </pre>
                  ),
                }]} />
            </div>
          ),
          rowExpandable: () => true,
        }}
      />
      </div>

      {/* Create / Edit Drawer */}
      <Drawer
        title={<span style={{ color: C.text }}>{editing ? `Düzenle: ${editing.name}` : 'Yeni Config Şablonu'}</span>}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={600}
        destroyOnClose
        styles={{
          body: { background: C.bg },
          header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
        }}
      >
        <TemplateForm initial={editing} onClose={() => setDrawerOpen(false)} />
      </Drawer>

      {/* Push Modal */}
      {pushing && (
        <PushModal template={pushing} onClose={() => setPushing(null)} />
      )}

      {/* View Raw Modal */}
      {viewingTemplate && (
        <Modal
          title={<span style={{ color: C.text }}><CodeOutlined style={{ marginRight: 8, color: '#6366f1' }} />{viewingTemplate.name}</span>}
          open
          onCancel={() => setViewingTemplate(null)}
          footer={[
            <Button
              key="copy"
              icon={<CopyOutlined />}
              onClick={() => {
                navigator.clipboard.writeText(viewingTemplate.template)
                message.success('Kopyalandı')
              }}
            >
              Kopyala
            </Button>,
            <Button key="close" onClick={() => setViewingTemplate(null)}>Kapat</Button>,
          ]}
          width={600}
          styles={{
            content: { background: C.bg, border: `1px solid ${C.border}` },
            header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
          }}
        >
          <pre style={{
            fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap',
            background: '#0f172a', color: '#e2e8f0', padding: 16, borderRadius: 6,
          }}>
            {viewingTemplate.template}
          </pre>
          {viewingTemplate.variables.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <span style={{ fontWeight: 600, fontSize: 12, color: C.text }}>Değişkenler:</span>
              <Table
                size="small"
                pagination={false}
                dataSource={viewingTemplate.variables}
                rowKey="name"
                style={{ marginTop: 6 }}
                columns={[
                  { title: 'Ad', dataIndex: 'name', render: (v: string) => <code style={{ fontFamily: 'monospace', fontSize: 11, color: isDark ? '#a5b4fc' : '#4f46e5' }}>{`{${v}}`}</code> },
                  { title: 'Etiket', dataIndex: 'label', render: (v: string) => <span style={{ fontSize: 12, color: C.text }}>{v}</span> },
                  { title: 'Varsayılan', dataIndex: 'default', render: (v: string) => <span style={{ fontSize: 11, color: C.muted }}>{v || '—'}</span> },
                  { title: 'Zorunlu', dataIndex: 'required', render: (v: boolean) => v
                    ? <Tag style={{ fontSize: 10, color: '#ef4444', borderColor: '#ef444450', background: '#ef444418' }}>Evet</Tag>
                    : <Tag style={{ fontSize: 10, color: C.dim, borderColor: C.border, background: 'transparent' }}>Hayır</Tag>
                  },
                ]}
              />
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
