import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import {
  Typography, Switch, Divider, Tag, Tabs, Table, Button, Modal, Form,
  Input, Select, Space, message, Popconfirm, Tooltip, InputNumber, Alert, DatePicker,
} from 'antd'
import {
  GlobalOutlined, BgColorsOutlined, SunOutlined, MoonOutlined,
  CheckOutlined, BellOutlined, PlusOutlined, EditOutlined,
  DeleteOutlined, ThunderboltOutlined, SendOutlined, AlertOutlined, ToolOutlined, SafetyOutlined,
  LockOutlined, CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, PlayCircleOutlined,
  ClockCircleOutlined, RiseOutlined, WifiOutlined, KeyOutlined, CopyOutlined, ExclamationCircleOutlined,
  CodeOutlined, RobotOutlined,
} from '@ant-design/icons'
import DriverTemplatesPage from '@/pages/DriverTemplates'
import { apiTokensApi, ApiToken } from '@/api/apiTokens'
import dayjs from 'dayjs'
import { useTheme } from '@/contexts/ThemeContext'
import i18n from '@/i18n'
import {
  notificationsApi, NotificationChannel, ChannelType, NOTIFY_ON_OPTIONS,
} from '@/api/notifications'
import { alertRulesApi, AlertRule, AlertRulePayload, METRIC_OPTIONS, SEVERITY_OPTIONS } from '@/api/alertRules'
import { maintenanceWindowsApi, MaintenanceWindow } from '@/api/maintenanceWindows'
import { credentialProfilesApi, CredentialProfile, RotationPolicy } from '@/api/credentialProfiles'
import { devicesApi } from '@/api/devices'
import { slaApi, SlaPolicy, SlaPolicyCreate } from '@/api/sla'
import { snmpApi, BulkSshResult, BulkSshDeviceResult } from '@/api/snmp'
import { aiAssistantApi, type AIProviderSettings } from '@/api/aiAssistant'

const { Text } = Typography

const LANGUAGES = [
  { code: 'tr', label: 'Türkçe', flag: '🇹🇷', region: 'Türkiye' },
  { code: 'en', label: 'English', flag: '🇬🇧', region: 'United Kingdom' },
  { code: 'ru', label: 'Русский', flag: '🇷🇺', region: 'Россия' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪', region: 'Deutschland' },
]

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
      <span style={{ fontSize: 16, opacity: 0.7 }}>{icon}</span>
      <Text style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', opacity: 0.5, textTransform: 'uppercase' }}>
        {title}
      </Text>
    </div>
  )
}

// ── Notification Channels CRUD ──────────────────────────────────────────────

function ChannelTypeConfig({ type }: { type: ChannelType }) {
  if (type === 'email') return (
    <>
      <Form.Item label="SMTP Host" name={['config', 'smtp_host']} rules={[{ required: true }]}>
        <Input placeholder="smtp.example.com" />
      </Form.Item>
      <Form.Item label="SMTP Port" name={['config', 'smtp_port']}>
        <Input type="number" placeholder="587" />
      </Form.Item>
      <Form.Item label="TLS" name={['config', 'smtp_use_tls']} valuePropName="checked">
        <Switch />
      </Form.Item>
      <Form.Item label="Kullanıcı Adı" name={['config', 'smtp_username']}>
        <Input />
      </Form.Item>
      <Form.Item label="Şifre" name={['config', 'smtp_password']}>
        <Input.Password />
      </Form.Item>
      <Form.Item label="Alıcılar" name={['config', 'recipients']} extra="Virgülle ayırın">
        <Select mode="tags" tokenSeparators={[',']} placeholder="user@example.com" />
      </Form.Item>
    </>
  )
  if (type === 'slack') return (
    <Form.Item label="Webhook URL" name={['config', 'webhook_url']} rules={[{ required: true }]}>
      <Input placeholder="https://hooks.slack.com/services/..." />
    </Form.Item>
  )
  if (type === 'teams') return (
    <Form.Item label="Webhook URL" name={['config', 'webhook_url']} rules={[{ required: true }]}
      extra="Teams kanalında Incoming Webhook bağlayıcısından alın">
      <Input placeholder="https://outlook.office.com/webhook/..." />
    </Form.Item>
  )
  if (type === 'webhook') return (
    <>
      <Form.Item label="Hedef URL" name={['config', 'url']} rules={[{ required: true }]}>
        <Input placeholder="https://example.com/hooks/netmanager" />
      </Form.Item>
      <Form.Item label="Özel Başlıklar" name={['config', 'headers']}
        extra='JSON formatında: {"X-API-Key": "abc123"}'>
        <Input.TextArea rows={3} placeholder='{"Authorization": "Bearer ..."}' />
      </Form.Item>
    </>
  )
  if (type === 'telegram') return (
    <>
      <Form.Item label="Bot Token" name={['config', 'bot_token']} rules={[{ required: true }]}>
        <Input.Password placeholder="123456:ABC..." />
      </Form.Item>
      <Form.Item label="Chat ID" name={['config', 'chat_id']} rules={[{ required: true }]}>
        <Input placeholder="-1001234567890" />
      </Form.Item>
    </>
  )
  if (type === 'jira') return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12, fontSize: 12 }}
        message="Jira Cloud için Atlassian API Token kullanın. Jira Server için kullanıcı adı + şifre girin."
      />
      <Form.Item
        label="Jira URL"
        name={['config', 'jira_url']}
        rules={[{ required: true }]}
        extra="Örn: https://mycompany.atlassian.net"
      >
        <Input placeholder="https://mycompany.atlassian.net" />
      </Form.Item>
      <Form.Item
        label="E-posta / Kullanıcı Adı"
        name={['config', 'jira_email']}
        rules={[{ required: true }]}
      >
        <Input placeholder="user@example.com" />
      </Form.Item>
      <Form.Item
        label="API Token / Şifre"
        name={['config', 'jira_api_token']}
        rules={[{ required: true }]}
        extra="Atlassian Cloud: id.atlassian.com → Güvenlik → API token"
      >
        <Input.Password placeholder="ATATT3xFfGF0..." />
      </Form.Item>
      <Form.Item
        label="Proje Anahtarı"
        name={['config', 'jira_project_key']}
        rules={[{ required: true }]}
        extra="Jira proje sayfasındaki kısa kod (NET, OPS, INFRA vb.)"
      >
        <Input placeholder="NET" style={{ width: 160 }} />
      </Form.Item>
      <Form.Item
        label="Issue Türü"
        name={['config', 'jira_issue_type']}
        initialValue="Bug"
        extra="Jira projenizde tanımlı issue type adı"
      >
        <Select style={{ width: 200 }}>
          <Select.Option value="Bug">Bug</Select.Option>
          <Select.Option value="Task">Task</Select.Option>
          <Select.Option value="Incident">Incident</Select.Option>
          <Select.Option value="Story">Story</Select.Option>
          <Select.Option value="Epic">Epic</Select.Option>
        </Select>
      </Form.Item>
    </>
  )
  return null
}

// ── Alert Rules CRUD ──────────────────────────────────────────────────────────

function AlertRulesTab() {
  const qc = useQueryClient()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<AlertRule | null>(null)
  const [form] = Form.useForm()

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ['alert-rules'],
    queryFn: alertRulesApi.list,
  })

  const { data: devices = [] } = useQuery({
    queryKey: ['devices-simple'],
    queryFn: () => devicesApi.list({ limit: 500 }).then((r) => r.items),
  })

  const saveMutation = useMutation({
    mutationFn: async (values: any) => {
      const payload: AlertRulePayload = {
        name: values.name,
        device_id: values.device_id ?? null,
        if_name_pattern: values.if_name_pattern || null,
        metric: values.metric,
        threshold_value: Number(values.threshold_value),
        consecutive_count: Number(values.consecutive_count ?? 2),
        severity: values.severity,
        cooldown_minutes: Number(values.cooldown_minutes ?? 60),
        enabled: values.enabled ?? true,
      }
      if (editing) return alertRulesApi.update(editing.id, payload)
      return alertRulesApi.create(payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alert-rules'] })
      setModalOpen(false)
      form.resetFields()
      setEditing(null)
      message.success(editing ? 'Kural güncellendi' : 'Kural oluşturuldu')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata oluştu'),
  })

  const deleteMutation = useMutation({
    mutationFn: alertRulesApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alert-rules'] })
      message.success('Kural silindi')
    },
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      alertRulesApi.update(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-rules'] }),
  })

  function openCreate() {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ metric: 'max_util_pct', severity: 'warning', consecutive_count: 2, cooldown_minutes: 60, enabled: true })
    setModalOpen(true)
  }

  function openEdit(rule: AlertRule) {
    setEditing(rule)
    form.setFieldsValue({ ...rule, device_id: rule.device_id ?? undefined })
    setModalOpen(true)
  }

  const columns = [
    {
      title: 'Ad', dataIndex: 'name', render: (v: string, r: AlertRule) => (
        <Space>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: r.enabled ? '#22c55e' : '#475569', display: 'inline-block', marginRight: 2 }} />
          <strong>{v}</strong>
        </Space>
      ),
    },
    {
      title: 'Cihaz', dataIndex: 'device_id',
      render: (v: number | null) => v
        ? <Tag>{devices.find((d) => d.id === v)?.hostname || `#${v}`}</Tag>
        : <Tag color="default">Tüm Cihazlar</Tag>,
    },
    {
      title: 'Interface', dataIndex: 'if_name_pattern',
      render: (v: string | null) => <code style={{ fontSize: 11 }}>{v || '*'}</code>,
    },
    {
      title: 'Metrik / Eşik', render: (_: any, r: AlertRule) => (
        <Space>
          <Tag color="blue">{METRIC_OPTIONS.find((m) => m.value === r.metric)?.label || r.metric}</Tag>
          <Tag color={r.threshold_value >= 80 ? 'red' : r.threshold_value >= 60 ? 'orange' : 'green'}>
            {r.metric === 'error_rate' ? `>${r.threshold_value}/dk` : `≥ ${r.threshold_value}%`}
          </Tag>
        </Space>
      ),
    },
    {
      title: 'Ardışık Poll', dataIndex: 'consecutive_count',
      render: (v: number) => <Tag>{v}x</Tag>,
      width: 90,
    },
    {
      title: 'Seviye', dataIndex: 'severity',
      render: (v: string) => <Tag color={v === 'critical' ? 'red' : 'orange'}>{v === 'critical' ? 'Kritik' : 'Uyarı'}</Tag>,
      width: 80,
    },
    {
      title: 'Aktif', dataIndex: 'enabled', width: 70,
      render: (v: boolean, r: AlertRule) => (
        <Switch
          size="small"
          checked={v}
          onChange={(val) => toggleMutation.mutate({ id: r.id, enabled: val })}
        />
      ),
    },
    {
      title: 'İşlem', width: 90,
      render: (_: any, r: AlertRule) => (
        <Space>
          <Tooltip title="Düzenle">
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          </Tooltip>
          <Popconfirm title="Bu kural silinsin mi?" onConfirm={() => deleteMutation.mutate(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="SNMP poll sonuçlarına göre arayüz utilization veya hata eşiği aşıldığında bildirim gönderir."
        description="Bildirim kanallarınızın 'Eşik Uyarısı (SNMP)' seçeneği etkin olmalıdır."
      />
      <div style={{ marginBottom: 12 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Yeni Kural
        </Button>
      </div>
      <Table
        dataSource={rules}
        rowKey="id"
        columns={columns}
        loading={isLoading}
        size="small"
        pagination={false}
        locale={{ emptyText: 'Henüz kural yok' }}
      />

      <Modal
        title={editing ? 'Kuralı Düzenle' : 'Yeni Uyarı Kuralı'}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setEditing(null) }}
        onOk={() => form.submit()}
        confirmLoading={saveMutation.isPending}
        width={520}
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMutation.mutate(v)}>
          <Form.Item label="Kural Adı" name="name" rules={[{ required: true }]}>
            <Input placeholder="Örn: Core Switch Yüksek Utilization" />
          </Form.Item>
          <Form.Item label="Cihaz" name="device_id" tooltip="Boş bırakılırsa tüm cihazlara uygulanır">
            <Select
              allowClear
              placeholder="— Tüm Cihazlar —"
              showSearch
              filterOption={(input, opt) =>
                (opt?.label as string ?? '').toLowerCase().includes(input.toLowerCase())
              }
              options={devices.map((d) => ({ label: `${d.hostname} (${d.ip_address})`, value: d.id }))}
            />
          </Form.Item>
          <Form.Item
            label="Interface Pattern"
            name="if_name_pattern"
            tooltip="fnmatch pattern. Örn: Gi0/*, Te*, boş = tüm interface"
          >
            <Input placeholder="* (tüm interface)" />
          </Form.Item>
          <Form.Item label="Metrik" name="metric" rules={[{ required: true }]}>
            <Select options={METRIC_OPTIONS} />
          </Form.Item>
          <Form.Item label="Eşik Değeri (%)" name="threshold_value" rules={[{ required: true }]}>
            <InputNumber min={0} max={100} step={5} style={{ width: '100%' }} addonAfter="%" />
          </Form.Item>
          <Form.Item label="Ardışık Poll Sayısı" name="consecutive_count" tooltip="Kaç ardışık poll sonucu eşiği aşmalı">
            <InputNumber min={1} max={10} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="Seviye" name="severity" rules={[{ required: true }]}>
            <Select options={SEVERITY_OPTIONS} />
          </Form.Item>
          <Form.Item label="Soğuma Süresi (dk)" name="cooldown_minutes" tooltip="Aynı kural için minimum bildirim aralığı">
            <InputNumber min={1} max={1440} style={{ width: '100%' }} addonAfter="dk" />
          </Form.Item>
          <Form.Item label="Aktif" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

// ── Notification Channels CRUD ──────────────────────────────────────────────

function NotificationChannelsTab() {
  const qc = useQueryClient()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<NotificationChannel | null>(null)
  const [channelType, setChannelType] = useState<ChannelType>('email')
  const [form] = Form.useForm()

  const { data, isLoading } = useQuery({
    queryKey: ['notification-channels'],
    queryFn: notificationsApi.list,
  })

  const saveMutation = useMutation({
    mutationFn: async (values: any) => {
      const payload = {
        name: values.name,
        type: values.type,
        config: values.config || {},
        notify_on: values.notify_on || [],
        is_active: values.is_active ?? true,
      }
      if (editing) return notificationsApi.update(editing.id, payload)
      return notificationsApi.create(payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notification-channels'] })
      setDrawerOpen(false)
      form.resetFields()
      message.success(editing ? 'Kanal güncellendi' : 'Kanal oluşturuldu')
    },
    onError: () => message.error('İşlem başarısız'),
  })

  const deleteMutation = useMutation({
    mutationFn: notificationsApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notification-channels'] })
      message.success('Kanal silindi')
    },
  })

  const testMutation = useMutation({
    mutationFn: notificationsApi.test,
    onSuccess: (res) => {
      if (res.success) message.success('Test mesajı gönderildi!')
      else message.error(`Test başarısız: ${res.error || 'Bilinmeyen hata'}`)
    },
  })

  const digestMutation = useMutation({
    mutationFn: notificationsApi.sendWeeklyDigest,
    onSuccess: () => message.success('Haftalık özet kuyruğa alındı'),
  })

  function openCreate() {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ type: 'email', is_active: true })
    setChannelType('email')
    setDrawerOpen(true)
  }

  function openEdit(ch: NotificationChannel) {
    setEditing(ch)
    form.setFieldsValue({
      name: ch.name,
      type: ch.type,
      config: ch.config,
      notify_on: ch.notify_on,
      is_active: ch.is_active,
    })
    setChannelType(ch.type)
    setDrawerOpen(true)
  }

  const TYPE_COLORS: Record<ChannelType, string> = { email: 'blue', slack: 'purple', telegram: 'cyan', teams: 'geekblue', webhook: 'volcano', jira: 'blue' }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Text style={{ fontSize: 13, opacity: 0.6 }}>
          Bildirim kanallarını yönetin. Olaylar gerçekleştiğinde seçilen kanallara otomatik mesaj gönderilir.
        </Text>
        <Space>
          <Popconfirm title="Haftalık özet gönderilsin mi?" onConfirm={() => digestMutation.mutate()}>
            <Button icon={<SendOutlined />} loading={digestMutation.isPending}>
              Haftalık Özet Gönder
            </Button>
          </Popconfirm>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Kanal Ekle
          </Button>
        </Space>
      </div>

      <Table
        dataSource={data?.items}
        loading={isLoading}
        rowKey="id"
        size="small"
        pagination={false}
        columns={[
          { title: 'Ad', dataIndex: 'name', render: (v: string, r: NotificationChannel) => (
            <div>
              <Text strong style={{ fontSize: 13 }}>{v}</Text>
              {!r.is_active && <Tag color="default" style={{ marginLeft: 6, fontSize: 10 }}>Pasif</Tag>}
            </div>
          )},
          { title: 'Tür', dataIndex: 'type', width: 90, render: (v: ChannelType) => <Tag color={TYPE_COLORS[v]}>{v.toUpperCase()}</Tag> },
          { title: 'Tetikleyiciler', dataIndex: 'notify_on', render: (v: string[]) => (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {v.map((on) => {
                const opt = NOTIFY_ON_OPTIONS.find((o) => o.value === on)
                return <Tag key={on} style={{ fontSize: 11, margin: 0 }}>{opt?.label || on}</Tag>
              })}
            </div>
          )},
          { title: 'Durum', dataIndex: 'is_active', width: 80, render: (v: boolean) => (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: v ? '#22c55e' : '#475569', display: 'inline-block' }} />
              <Text style={{ fontSize: 12, color: v ? '#22c55e' : '#64748b' }}>{v ? 'Aktif' : 'Pasif'}</Text>
            </span>
          )},
          { title: 'İşlem', width: 140, render: (_: any, r: NotificationChannel) => (
            <Space size={4}>
              <Tooltip title="Test gönder">
                <Button
                  size="small" icon={<ThunderboltOutlined />}
                  loading={testMutation.isPending && testMutation.variables === r.id}
                  onClick={() => testMutation.mutate(r.id)}
                />
              </Tooltip>
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
              <Popconfirm title="Kanal silinsin mi?" onConfirm={() => deleteMutation.mutate(r.id)}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </Space>
          )},
        ]}
      />

      <Modal
        open={drawerOpen}
        onCancel={() => setDrawerOpen(false)}
        title={editing ? 'Kanalı Düzenle' : 'Yeni Bildirim Kanalı'}
        width={560}
        onOk={() => form.submit()}
        okText={editing ? 'Güncelle' : 'Oluştur'}
        confirmLoading={saveMutation.isPending}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => saveMutation.mutate(values)}
          style={{ marginTop: 16 }}
        >
          <Form.Item label="Kanal Adı" name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="Tür" name="type" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'email', label: 'E-posta' },
                { value: 'slack', label: 'Slack' },
                { value: 'teams', label: 'Microsoft Teams' },
                { value: 'telegram', label: 'Telegram' },
                { value: 'webhook', label: 'Generic Webhook' },
                { value: 'jira', label: 'Jira (Ticket)' },
              ]}
              onChange={(v) => {
                setChannelType(v as ChannelType)
                form.setFieldValue('config', {})
              }}
            />
          </Form.Item>

          <ChannelTypeConfig type={channelType} />

          <Form.Item label="Tetikleyiciler" name="notify_on">
            <Select
              mode="multiple"
              options={NOTIFY_ON_OPTIONS}
              placeholder="Bildirim gönderilecek olayları seçin"
            />
          </Form.Item>
          <Form.Item label="Aktif" name="is_active" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

// ── Credential Profiles (Vault) ─────────────────────────────────────────────

function CredentialProfilesTab() {
  const qc = useQueryClient()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<CredentialProfile | null>(null)
  const [form] = Form.useForm()

  const { data: profiles = [], isLoading } = useQuery({
    queryKey: ['credential-profiles'],
    queryFn: credentialProfilesApi.list,
  })

  const saveMutation = useMutation({
    mutationFn: async (values: any) => {
      const payload: any = {
        name: values.name,
        description: values.description || null,
        ssh_username: values.ssh_username || null,
        ssh_port: values.ssh_port || 22,
        snmp_enabled: !!values.snmp_enabled,
        snmp_community: values.snmp_community || null,
        snmp_version: values.snmp_version || 'v2c',
        snmp_port: values.snmp_port || 161,
        snmp_v3_username: values.snmp_v3_username || null,
        snmp_v3_auth_protocol: values.snmp_v3_auth_protocol || null,
        snmp_v3_priv_protocol: values.snmp_v3_priv_protocol || null,
      }
      if (values.ssh_password) payload.ssh_password = values.ssh_password
      if (values.enable_secret !== undefined) payload.enable_secret = values.enable_secret
      if (values.snmp_v3_auth_passphrase) payload.snmp_v3_auth_passphrase = values.snmp_v3_auth_passphrase
      if (values.snmp_v3_priv_passphrase) payload.snmp_v3_priv_passphrase = values.snmp_v3_priv_passphrase

      if (editing) return credentialProfilesApi.update(editing.id, payload)
      return credentialProfilesApi.create(payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credential-profiles'] })
      setModalOpen(false)
      form.resetFields()
      setEditing(null)
      message.success(editing ? 'Profil güncellendi' : 'Profil oluşturuldu')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata oluştu'),
  })

  const deleteMutation = useMutation({
    mutationFn: credentialProfilesApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credential-profiles'] })
      message.success('Profil silindi')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Silinemedi'),
  })

  function openCreate() {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ ssh_port: 22, snmp_version: 'v2c', snmp_port: 161, snmp_enabled: false })
    setModalOpen(true)
  }

  function openEdit(p: CredentialProfile) {
    setEditing(p)
    form.setFieldsValue({
      name: p.name,
      description: p.description,
      ssh_username: p.ssh_username,
      ssh_port: p.ssh_port,
      snmp_enabled: p.snmp_enabled,
      snmp_version: p.snmp_version,
      snmp_port: p.snmp_port,
      snmp_v3_username: p.snmp_v3_username,
      snmp_v3_auth_protocol: p.snmp_v3_auth_protocol,
      snmp_v3_priv_protocol: p.snmp_v3_priv_protocol,
      // passwords intentionally left blank — only fill if changing
    })
    setModalOpen(true)
  }

  function PasswordStatusIcon({ isSet }: { isSet: boolean }) {
    return isSet
      ? <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 13 }} />
      : <CloseCircleOutlined style={{ color: '#d9d9d9', fontSize: 13 }} />
  }

  const columns = [
    {
      title: 'Profil Adı', dataIndex: 'name',
      render: (v: string, r: CredentialProfile) => (
        <Space>
          <LockOutlined style={{ opacity: 0.4 }} />
          <strong>{v}</strong>
          {r.description && <Text type="secondary" style={{ fontSize: 12 }}>{r.description}</Text>}
        </Space>
      ),
    },
    {
      title: 'SSH', render: (_: any, r: CredentialProfile) => (
        <Space size={4}>
          <Tag style={{ fontSize: 11 }}>{r.ssh_username || '—'}</Tag>
          <Text type="secondary" style={{ fontSize: 11 }}>:{r.ssh_port}</Text>
          <PasswordStatusIcon isSet={r.ssh_password_set} />
        </Space>
      ),
    },
    {
      title: 'Enable', dataIndex: 'enable_secret_set', width: 80,
      render: (v: boolean) => <PasswordStatusIcon isSet={v} />,
    },
    {
      title: 'SNMP', render: (_: any, r: CredentialProfile) => {
        if (!r.snmp_enabled) return <Tag color="default">Devre Dışı</Tag>
        if (r.snmp_version === 'v3') return <Tag color="purple">v3 / {r.snmp_v3_username || '—'}</Tag>
        return <Tag color="blue">{r.snmp_version} / {r.snmp_community_set ? '••••••••' : '—'}</Tag>
      },
    },
    {
      title: 'İşlem', width: 90,
      render: (_: any, r: CredentialProfile) => (
        <Space>
          <Tooltip title="Düzenle">
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          </Tooltip>
          <Popconfirm
            title="Bu profil silinsin mi?"
            description="Profile atanmış cihazlar varsa silinemez."
            onConfirm={() => deleteMutation.mutate(r.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Kimlik bilgileri Fernet şifrelemesiyle saklanır. Şifreler hiçbir zaman API yanıtında döndürülmez."
        description="Cihazlara profil atayarak credential yönetimini merkezileştirin. Profil atanmış cihazlar SSH/SNMP bağlantılarında bu profili kullanır."
      />
      <div style={{ marginBottom: 12 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Yeni Profil
        </Button>
      </div>
      <Table
        dataSource={profiles}
        rowKey="id"
        columns={columns}
        loading={isLoading}
        size="small"
        pagination={false}
        locale={{ emptyText: 'Henüz profil yok' }}
      />

      <Modal
        title={editing ? 'Profili Düzenle' : 'Yeni Kimlik Profili'}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setEditing(null) }}
        onOk={() => form.submit()}
        confirmLoading={saveMutation.isPending}
        width={560}
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMutation.mutate(v)}>
          <Form.Item label="Profil Adı" name="name" rules={[{ required: true }]}>
            <Input placeholder="Örn: Cisco Core, Aruba Access, Read-Only" />
          </Form.Item>
          <Form.Item label="Açıklama" name="description">
            <Input placeholder="Opsiyonel not" />
          </Form.Item>

          <Divider orientation="left" style={{ fontSize: 12, opacity: 0.6 }}>SSH</Divider>
          <Form.Item label="SSH Kullanıcı Adı" name="ssh_username">
            <Input placeholder="admin" />
          </Form.Item>
          <Form.Item
            label={editing ? 'SSH Şifre (değiştirmek için doldurun)' : 'SSH Şifre'}
            name="ssh_password"
          >
            <Input.Password placeholder={editing ? '— değiştirmek için girin —' : ''} />
          </Form.Item>
          <Form.Item label="SSH Port" name="ssh_port">
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            label={editing ? 'Enable Secret (değiştirmek için doldurun)' : 'Enable Secret'}
            name="enable_secret"
            tooltip="Boş bırakılırsa mevcut değer korunur; temizlemek için boşluk girin"
          >
            <Input.Password placeholder={editing ? '— değiştirmek için girin —' : ''} />
          </Form.Item>

          <Divider orientation="left" style={{ fontSize: 12, opacity: 0.6 }}>SNMP</Divider>
          <Form.Item name="snmp_enabled" valuePropName="checked" label="SNMP Aktif">
            <Switch />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.snmp_enabled !== cur.snmp_enabled}
          >
            {({ getFieldValue }) => getFieldValue('snmp_enabled') && (
              <>
                <Form.Item label="SNMP Versiyon" name="snmp_version">
                  <Select
                    options={[
                      { value: 'v1', label: 'v1' },
                      { value: 'v2c', label: 'v2c' },
                      { value: 'v3', label: 'v3 (USM)' },
                    ]}
                  />
                </Form.Item>
                <Form.Item label="SNMP Port" name="snmp_port">
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  noStyle
                  shouldUpdate={(prev, cur) => prev.snmp_version !== cur.snmp_version}
                >
                  {({ getFieldValue: gfv }) => gfv('snmp_version') !== 'v3'
                    ? (
                      <Form.Item label="Community String" name="snmp_community">
                        <Input placeholder="public" />
                      </Form.Item>
                    )
                    : (
                      <>
                        <Form.Item label="v3 Kullanıcı Adı" name="snmp_v3_username">
                          <Input />
                        </Form.Item>
                        <Form.Item label="Auth Protokolü" name="snmp_v3_auth_protocol">
                          <Select allowClear placeholder="— yok —" options={[
                            { value: 'md5', label: 'MD5' },
                            { value: 'sha1', label: 'SHA-1' },
                          ]} />
                        </Form.Item>
                        <Form.Item label="Auth Parolası" name="snmp_v3_auth_passphrase">
                          <Input.Password />
                        </Form.Item>
                        <Form.Item label="Priv Protokolü" name="snmp_v3_priv_protocol">
                          <Select allowClear placeholder="— yok —" options={[
                            { value: 'des', label: 'DES' },
                            { value: 'aes128', label: 'AES-128' },
                          ]} />
                        </Form.Item>
                        <Form.Item label="Priv Parolası" name="snmp_v3_priv_passphrase">
                          <Input.Password />
                        </Form.Item>
                      </>
                    )
                  }
                </Form.Item>
              </>
            )}
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

// ── Secret Rotation ─────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { color: string; hex: string; label: string; icon: React.ReactNode }> = {
  idle:    { color: 'default',    hex: '#64748b', label: 'Bekliyor',    icon: <ClockCircleOutlined /> },
  running: { color: 'processing', hex: '#3b82f6', label: 'Çalışıyor',  icon: <SyncOutlined spin /> },
  success: { color: 'success',    hex: '#22c55e', label: 'Başarılı',   icon: <CheckCircleOutlined /> },
  failed:  { color: 'error',      hex: '#ef4444', label: 'Başarısız',  icon: <CloseCircleOutlined /> },
}

// ── SLA Policies Tab ───────────────────────────────────────────────────────

function SlaPoliciesTab() {
  const qc = useQueryClient()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<SlaPolicy | null>(null)
  const [form] = Form.useForm()

  const { data: policies = [], isLoading } = useQuery({
    queryKey: ['sla-policies'],
    queryFn: slaApi.listPolicies,
  })

  const { data: devices = [] } = useQuery({
    queryKey: ['devices-simple'],
    queryFn: () => devicesApi.list({ limit: 500 }).then((r) => r.items),
  })

  const saveMutation = useMutation({
    mutationFn: (values: SlaPolicyCreate) =>
      editing ? slaApi.updatePolicy(editing.id, values) : slaApi.createPolicy(values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sla-policies'] })
      setModalOpen(false)
      form.resetFields()
      setEditing(null)
      message.success(editing ? 'SLA politikası güncellendi' : 'SLA politikası oluşturuldu')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata oluştu'),
  })

  const deleteMutation = useMutation({
    mutationFn: slaApi.deletePolicy,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sla-policies'] })
      message.success('SLA politikası silindi')
    },
  })

  function openCreate() {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({
      target_uptime_pct: 99.0,
      measurement_window_days: 30,
      notify_on_breach: true,
      device_ids: [],
      group_ids: [],
    })
    setModalOpen(true)
  }

  function openEdit(p: SlaPolicy) {
    setEditing(p)
    form.setFieldsValue({
      name: p.name,
      target_uptime_pct: p.target_uptime_pct,
      measurement_window_days: p.measurement_window_days,
      device_ids: p.device_ids,
      group_ids: p.group_ids,
      notify_on_breach: p.notify_on_breach,
    })
    setModalOpen(true)
  }

  const columns = [
    {
      title: 'Politika Adı', dataIndex: 'name',
      render: (v: string) => <strong>{v}</strong>,
    },
    {
      title: 'Hedef Uptime',
      dataIndex: 'target_uptime_pct',
      render: (v: number) => (
        <Tag color={v >= 99.9 ? 'red' : v >= 99 ? 'orange' : 'blue'}>%{v}</Tag>
      ),
    },
    {
      title: 'Ölçüm Penceresi',
      dataIndex: 'measurement_window_days',
      render: (v: number) => `${v} gün`,
    },
    {
      title: 'Kapsam',
      render: (_: unknown, r: SlaPolicy) => {
        if (!r.device_ids?.length && !r.group_ids?.length) return <Tag>Tüm Cihazlar</Tag>
        return (
          <Space>
            {r.device_ids?.length > 0 && <Tag color="blue">{r.device_ids.length} cihaz</Tag>}
            {r.group_ids?.length > 0 && <Tag color="green">{r.group_ids.length} grup</Tag>}
          </Space>
        )
      },
    },
    {
      title: 'Bildirim',
      dataIndex: 'notify_on_breach',
      render: (v: boolean) => v
        ? <Tag icon={<BellOutlined />} color="orange">Aktif</Tag>
        : <Tag>Pasif</Tag>,
    },
    {
      title: '',
      render: (_: unknown, r: SlaPolicy) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          <Popconfirm title="Bu politikayı silmek istiyor musunuz?" onConfirm={() => deleteMutation.mutate(r.id)}>
            <Button size="small" icon={<DeleteOutlined />} danger />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Text type="secondary" style={{ fontSize: 13 }}>
          Cihaz veya grup bazında uptime hedefi tanımlayın. İhlalde bildirim gönderilebilir.
        </Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Politika Ekle</Button>
      </div>

      <Table
        dataSource={policies}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={false}
      />

      <Modal
        title={editing ? 'SLA Politikasını Düzenle' : 'Yeni SLA Politikası'}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setEditing(null) }}
        onOk={() => form.submit()}
        confirmLoading={saveMutation.isPending}
        width={500}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => saveMutation.mutate(values as SlaPolicyCreate)}
        >
          <Form.Item label="Politika Adı" name="name" rules={[{ required: true }]}>
            <Input placeholder="Kritik Altyapı SLA" />
          </Form.Item>
          <Form.Item label="Hedef Uptime (%)" name="target_uptime_pct" rules={[{ required: true }]}>
            <InputNumber min={0} max={100} step={0.1} precision={2} style={{ width: '100%' }}
              addonAfter="%" />
          </Form.Item>
          <Form.Item label="Ölçüm Penceresi" name="measurement_window_days" rules={[{ required: true }]}>
            <Select>
              {[7, 14, 30, 60, 90].map((d) => (
                <Select.Option key={d} value={d}>{d} gün</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label="Kapsam — Cihazlar"
            name="device_ids"
            extra="Boş bırakırsanız tüm cihazlar dahil edilir"
          >
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              placeholder="Belirli cihazlar seçin (opsiyonel)"
              options={devices.map((d: any) => ({ value: d.id, label: d.hostname }))}
            />
          </Form.Item>
          <Form.Item label="İhlalde Bildirim Gönder" name="notify_on_breach" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

// ── SNMP Configuration Tab ──────────────────────────────────────────────────

function SnmpConfigTab() {
  const qc = useQueryClient()
  const [form] = Form.useForm()
  const [confirmAll, setConfirmAll] = useState(false)
  const [sshResult, setSshResult] = useState<BulkSshResult | null>(null)

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['snmp-status'],
    queryFn: snmpApi.getStatus,
    refetchInterval: 15_000,
  })

  const pollMutation = useMutation({
    mutationFn: snmpApi.triggerPoll,
    onSuccess: () => {
      message.success('SNMP poll görevi kuyruğa alındı — ~30 saniye sonra veri güncellenir')
      setTimeout(() => qc.invalidateQueries({ queryKey: ['snmp-status'] }), 31_000)
    },
    onError: () => message.error('Poll görevi başlatılamadı'),
  })

  const sshMutation = useMutation({
    mutationFn: snmpApi.bulkSshConfigure,
    onSuccess: (data) => {
      setSshResult(data)
      qc.invalidateQueries({ queryKey: ['snmp-status'] })
      form.resetFields()
      setConfirmAll(false)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'SSH yapılandırma başarısız'),
  })

  const onApply = (values: any) => {
    if (!values.community) return message.error('Community string gerekli')
    sshMutation.mutate({
      community: values.community,
      version: values.version || 'v2c',
      port: values.port || 161,
    })
  }

  const sshResultColumns = [
    {
      title: 'Cihaz',
      dataIndex: 'hostname',
      key: 'hostname',
      render: (hostname: string, row: BulkSshDeviceResult) => (
        <span>
          <Text strong>{hostname}</Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>{row.ip}</Text>
        </span>
      ),
    },
    {
      title: 'Durum',
      dataIndex: 'success',
      key: 'success',
      width: 90,
      render: (ok: boolean) =>
        ok
          ? <Tag color="success">Başarılı</Tag>
          : <Tag color="error">Hata</Tag>,
    },
    {
      title: 'Hata',
      dataIndex: 'error',
      key: 'error',
      render: (err?: string) => err ? <Text type="danger" style={{ fontSize: 12 }}>{err}</Text> : null,
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Status cards */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {[
          { label: 'Toplam Cihaz', value: status?.total_devices ?? '—', color: '#3b82f6' },
          { label: 'SNMP Aktif', value: status?.snmp_enabled ?? '—', color: (status?.snmp_enabled ?? 0) > 0 ? '#22c55e' : '#64748b' },
          { label: 'Poll Kayıt Sayısı', value: status?.poll_results ?? '—', color: '#8b5cf6' },
          { label: 'Son Poll', value: status?.last_poll_at ? dayjs(status.last_poll_at).fromNow() : 'Henüz yok', color: '#06b6d4' },
        ].map((s) => (
          <div key={s.label} style={{
            flex: 1, minWidth: 130,
            border: `1px solid ${s.color}33`,
            borderTop: `2px solid ${s.color}88`,
            borderRadius: 8, padding: '10px 14px',
          }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: s.color, lineHeight: 1 }}>{statusLoading ? '…' : s.value}</div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>{s.label}</div>
          </div>
        ))}
      </div>

      <Divider orientation="left" plain style={{ fontSize: 13 }}>Toplu SNMP Yapılandırma (SSH)</Divider>

      <Alert
        type="warning"
        showIcon
        message="Ruijie community string kuralı"
        description='Community string en az 3 karakter türü içermeli: büyük harf + küçük harf + rakam. Örnek: "NetManager1"'
        style={{ marginBottom: 8 }}
      />

      <Alert
        type="info"
        showIcon
        message="SSH ile doğrudan cihaz firmware'ine SNMP komutları gönderilir"
        description="Her cihaza SSH bağlanılır, SNMP aktifleştirilir ve community string yazılır. 58 cihaz için ~2-3 dakika sürebilir."
        style={{ marginBottom: 8 }}
      />

      <Form form={form} layout="vertical" onFinish={onApply} style={{ maxWidth: 480 }}>
        <Form.Item
          label="SNMP Community String"
          name="community"
          rules={[{ required: true, message: 'Gerekli' }]}
          extra='Ruijie için büyük harf + küçük harf + rakam gerekli — örn. "NetManager1"'
        >
          <Input placeholder="NetManager1" />
        </Form.Item>
        <Form.Item label="Versiyon" name="version" initialValue="v2c">
          <Select options={[
            { value: 'v1', label: 'SNMPv1' },
            { value: 'v2c', label: 'SNMPv2c (önerilen)' },
          ]} style={{ width: 220 }} />
        </Form.Item>
        <Form.Item label="Port" name="port" initialValue={161}>
          <InputNumber min={1} max={65535} style={{ width: 120 }} />
        </Form.Item>
        <Form.Item>
          {!confirmAll ? (
            <Button type="primary" icon={<SendOutlined />} onClick={() => setConfirmAll(true)}>
              Tüm Cihazlara SSH ile Uygula
            </Button>
          ) : (
            <Space>
              <Text type="warning">Tüm {status?.total_devices} cihaza SSH bağlanılacak. Emin misin?</Text>
              <Button
                danger
                loading={sshMutation.isPending}
                onClick={() => form.submit()}
              >
                {sshMutation.isPending ? 'Yapılandırılıyor...' : 'Evet, Uygula'}
              </Button>
              <Button onClick={() => setConfirmAll(false)} disabled={sshMutation.isPending}>İptal</Button>
            </Space>
          )}
        </Form.Item>
      </Form>

      <Divider orientation="left" plain style={{ fontSize: 13 }}>Manuel Poll</Divider>

      <Space>
        <Button
          type="default"
          icon={<ThunderboltOutlined />}
          loading={pollMutation.isPending}
          onClick={() => pollMutation.mutate()}
        >
          Şimdi Poll Et
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Celery beat her 5 dakikada bir otomatik poll eder.
          Bu buton hemen kuyruğa gönderir.
        </Text>
      </Space>

      {/* SSH Results Modal */}
      <Modal
        open={sshResult !== null}
        title={
          sshResult
            ? `SSH Yapılandırma Sonucu — ${sshResult.succeeded}/${sshResult.attempted} başarılı`
            : ''
        }
        onCancel={() => setSshResult(null)}
        footer={
          <Button type="primary" onClick={() => setSshResult(null)}>Kapat</Button>
        }
        width={700}
      >
        {sshResult && (
          <>
            <Space style={{ marginBottom: 16 }}>
              <Tag color="success">{sshResult.succeeded} Başarılı</Tag>
              {sshResult.failed > 0 && <Tag color="error">{sshResult.failed} Başarısız</Tag>}
            </Space>
            {sshResult.failed > 0 && (
              <Alert
                type="warning"
                showIcon
                message="Başarısız cihazlar için Cihaz Detayı → Health → SNMP Güncelle kullanabilirsiniz."
                style={{ marginBottom: 12 }}
              />
            )}
            <Table
              dataSource={sshResult.results}
              columns={sshResultColumns}
              rowKey="device_id"
              size="small"
              pagination={{ pageSize: 20 }}
              scroll={{ y: 400 }}
            />
          </>
        )}
      </Modal>
    </div>
  )
}

function SecretRotationTab() {
  const qc = useQueryClient()
  const [policyModal, setPolicyModal] = useState<{ open: boolean; profileId?: number; policy?: RotationPolicy | null }>({ open: false })
  const [resultModal, setResultModal] = useState<RotationPolicy | null>(null)
  const [policyForm] = Form.useForm()

  const { data: profiles = [] } = useQuery({ queryKey: ['credential-profiles'], queryFn: credentialProfilesApi.list })
  const { data: policies = [], isLoading } = useQuery({
    queryKey: ['rotation-policies'],
    queryFn: credentialProfilesApi.listRotationPolicies,
    refetchInterval: 10_000,
  })

  const saveMutation = useMutation({
    mutationFn: async (values: { interval_days: number; is_active: boolean }) => {
      const { profileId, policy } = policyModal
      if (!profileId) return
      if (policy) return credentialProfilesApi.updateRotationPolicy(profileId, values)
      return credentialProfilesApi.createRotationPolicy(profileId, values)
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['rotation-policies'] }); setPolicyModal({ open: false }) },
  })

  const deleteMutation = useMutation({
    mutationFn: (profileId: number) => credentialProfilesApi.deleteRotationPolicy(profileId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rotation-policies'] }),
  })

  const rotateMutation = useMutation({
    mutationFn: (profileId: number) => credentialProfilesApi.rotateNow(profileId),
    onSuccess: () => {
      message.success('Rotasyon başlatıldı')
      setTimeout(() => qc.invalidateQueries({ queryKey: ['rotation-policies'] }), 2000)
    },
  })

  // Profiles without a policy
  const policiedIds = new Set(policies.map((p) => p.credential_profile_id))
  const unassigned = profiles.filter((p) => !policiedIds.has(p.id))

  const openCreate = (profileId: number) => {
    policyForm.setFieldsValue({ interval_days: 90, is_active: true })
    setPolicyModal({ open: true, profileId, policy: null })
  }

  const openEdit = (policy: RotationPolicy) => {
    policyForm.setFieldsValue({ interval_days: policy.interval_days, is_active: policy.is_active })
    setPolicyModal({ open: true, profileId: policy.credential_profile_id, policy })
  }

  const columns = [
    {
      title: 'Kimlik Profili', dataIndex: 'profile_name', key: 'profile_name',
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: 'Aralık', dataIndex: 'interval_days', key: 'interval_days',
      render: (d: number) => `${d} gün`,
    },
    {
      title: 'Durum', dataIndex: 'status', key: 'status',
      render: (s: string, row: RotationPolicy) => (
        <Space size={4}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_CONFIG[s]?.hex ?? '#64748b', display: 'inline-block' }} />
          <Text>{STATUS_CONFIG[s]?.label ?? s}</Text>
          {!row.is_active && <Tag>Pasif</Tag>}
        </Space>
      ),
    },
    {
      title: 'Son Rotasyon', dataIndex: 'last_rotated_at', key: 'last_rotated_at',
      render: (v: string | null) => v ? dayjs(v).format('DD.MM.YYYY HH:mm') : <Text type="secondary">—</Text>,
    },
    {
      title: 'Sonraki Rotasyon', dataIndex: 'next_rotate_at', key: 'next_rotate_at',
      render: (v: string | null) => {
        if (!v) return <Text type="secondary">—</Text>
        const diff = dayjs(v).diff(dayjs(), 'day')
        const color = diff <= 7 ? 'red' : diff <= 30 ? 'orange' : undefined
        return <Text style={{ color }}>{dayjs(v).format('DD.MM.YYYY')}</Text>
      },
    },
    {
      title: 'İşlemler', key: 'actions',
      render: (_: unknown, row: RotationPolicy) => (
        <Space>
          {row.last_result && (
            <Tooltip title="Son Sonuç">
              <Button size="small" icon={<CheckCircleOutlined />} onClick={() => setResultModal(row)} />
            </Tooltip>
          )}
          <Tooltip title="Şimdi Döndür">
            <Button
              size="small" icon={<PlayCircleOutlined />} type="primary"
              loading={rotateMutation.isPending}
              disabled={row.status === 'running'}
              onClick={() => rotateMutation.mutate(row.credential_profile_id)}
            />
          </Tooltip>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
          <Popconfirm title="Rotasyon politikası silinsin mi?" onConfirm={() => deleteMutation.mutate(row.credential_profile_id)}>
            <Button size="small" icon={<DeleteOutlined />} danger />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Alert
        showIcon type="warning"
        message="SSH şifresi rotasyonu gerçek cihazlara bağlanır ve parolayı değiştirir."
        description="Tüm cihazlar başarılı olmadan profil güncellenmez. Cisco IOS/IOS-XE ve Ruijie desteklenmektedir."
        style={{ marginBottom: 16 }}
      />

      {unassigned.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary">Politika atanmamış profiller: </Text>
          <Space wrap>
            {unassigned.map((p) => (
              <Button key={p.id} size="small" icon={<PlusOutlined />} onClick={() => openCreate(p.id)}>
                {p.name}
              </Button>
            ))}
          </Space>
        </div>
      )}

      <Table
        dataSource={policies}
        rowKey="id"
        loading={isLoading}
        size="small"
        columns={columns}
        pagination={false}
        locale={{ emptyText: 'Henüz rotasyon politikası yok. Üstteki profil butonlarından ekleyin.' }}
      />

      {/* Create/Edit Policy Modal */}
      <Modal
        title={policyModal.policy ? 'Politikayı Düzenle' : 'Rotasyon Politikası Ekle'}
        open={policyModal.open}
        onCancel={() => setPolicyModal({ open: false })}
        onOk={() => policyForm.submit()}
        confirmLoading={saveMutation.isPending}
      >
        {policyModal.profileId && (
          <Alert
            type="info" showIcon style={{ marginBottom: 16 }}
            message={`Profil: ${profiles.find((p) => p.id === policyModal.profileId)?.name}`}
          />
        )}
        <Form form={policyForm} layout="vertical" onFinish={(v) => saveMutation.mutate(v)}>
          <Form.Item name="interval_days" label="Rotasyon Aralığı (Gün)" rules={[{ required: true }]}>
            <InputNumber min={1} max={365} style={{ width: '100%' }} addonAfter="gün" />
          </Form.Item>
          <Form.Item name="is_active" label="Aktif" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      {/* Last Result Modal */}
      <Modal
        title="Son Rotasyon Sonucu"
        open={!!resultModal}
        onCancel={() => setResultModal(null)}
        footer={<Button onClick={() => setResultModal(null)}>Kapat</Button>}
        width={560}
      >
        {resultModal?.last_result && (
          <div>
            {resultModal.last_result.rotated_at && (
              <Text type="secondary">
                {dayjs(resultModal.last_result.rotated_at).format('DD.MM.YYYY HH:mm')} tarihinde çalıştırıldı
              </Text>
            )}
            {resultModal.last_result.message && (
              <Alert type="info" message={resultModal.last_result.message} style={{ marginTop: 8 }} />
            )}
            {(resultModal.last_result.device_results || []).map((r) => (
              <div key={r.device_id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                {r.success
                  ? <CheckCircleOutlined style={{ color: '#52c41a' }} />
                  : <CloseCircleOutlined style={{ color: '#f5222d' }} />}
                <Text strong>{r.hostname}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>{r.message}</Text>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  )
}

// ── Maintenance Windows CRUD ────────────────────────────────────────────────

function MaintenanceWindowsTab() {
  const qc = useQueryClient()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<MaintenanceWindow | null>(null)
  const [form] = Form.useForm()

  const { data: windows = [], isLoading } = useQuery({
    queryKey: ['maintenance-windows'],
    queryFn: maintenanceWindowsApi.list,
  })

  const { data: devices = [] } = useQuery({
    queryKey: ['devices-simple'],
    queryFn: () => devicesApi.list({ limit: 500 }).then((r) => r.items),
  })

  const saveMutation = useMutation({
    mutationFn: async (values: any) => {
      const [start, end] = values.time_range
      const payload = {
        name: values.name,
        description: values.description || null,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        applies_to_all: !!values.applies_to_all,
        device_ids: values.applies_to_all ? [] : (values.device_ids || []),
      }
      if (editing) return maintenanceWindowsApi.update(editing.id, payload)
      return maintenanceWindowsApi.create(payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-windows'] })
      setModalOpen(false)
      form.resetFields()
      setEditing(null)
      message.success(editing ? 'Bakım penceresi güncellendi' : 'Bakım penceresi oluşturuldu')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata oluştu'),
  })

  const deleteMutation = useMutation({
    mutationFn: maintenanceWindowsApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-windows'] })
      message.success('Bakım penceresi silindi')
    },
  })

  function openCreate() {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ applies_to_all: false })
    setModalOpen(true)
  }

  function openEdit(w: MaintenanceWindow) {
    setEditing(w)
    form.setFieldsValue({
      name: w.name,
      description: w.description,
      time_range: [dayjs(w.start_time), dayjs(w.end_time)],
      applies_to_all: w.applies_to_all,
      device_ids: w.device_ids,
    })
    setModalOpen(true)
  }

  const columns = [
    {
      title: 'Bakım Adı', dataIndex: 'name',
      render: (v: string, r: MaintenanceWindow) => (
        <Space>
          {r.is_active
            ? <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f97316', display: 'inline-block' }} />
            : <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#475569', display: 'inline-block' }} />}
          <strong>{v}</strong>
          {r.description && <Text type="secondary" style={{ fontSize: 12 }}>{r.description}</Text>}
        </Space>
      ),
    },
    {
      title: 'Başlangıç', dataIndex: 'start_time',
      render: (v: string) => dayjs(v).format('DD.MM.YYYY HH:mm'),
      width: 160,
    },
    {
      title: 'Bitiş', dataIndex: 'end_time',
      render: (v: string) => dayjs(v).format('DD.MM.YYYY HH:mm'),
      width: 160,
    },
    {
      title: 'Kapsam', render: (_: any, r: MaintenanceWindow) => r.applies_to_all
        ? <Tag color="red">Tüm Cihazlar</Tag>
        : (
          <Space size={4} wrap>
            {(r.device_ids || []).map((id) => {
              const d = devices.find((x) => x.id === id)
              return <Tag key={id} style={{ fontSize: 11 }}>{d?.hostname || `#${id}`}</Tag>
            })}
            {(!r.device_ids || r.device_ids.length === 0) && <Tag color="default">—</Tag>}
          </Space>
        ),
    },
    {
      title: 'Durum', dataIndex: 'is_active', width: 100,
      render: (v: boolean) => v
        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f97316', display: 'inline-block' }} /><Text style={{ fontSize: 12, color: '#f97316' }}>Aktif</Text></span>
        : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: '#475569', display: 'inline-block' }} /><Text style={{ fontSize: 12, color: '#64748b' }}>Pasif</Text></span>,
    },
    {
      title: 'İşlem', width: 90,
      render: (_: any, r: MaintenanceWindow) => (
        <Space>
          <Tooltip title="Düzenle">
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          </Tooltip>
          <Popconfirm title="Bu bakım penceresi silinsin mi?" onConfirm={() => deleteMutation.mutate(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const activeCount = windows.filter((w) => w.is_active).length

  return (
    <div>
      <Alert
        type={activeCount > 0 ? 'warning' : 'info'}
        showIcon
        style={{ marginBottom: 16 }}
        message={
          activeCount > 0
            ? `${activeCount} aktif bakım penceresi — bu cihazlar için SNMP uyarıları susturulmuş.`
            : 'Planlı bakım sürelerinde SNMP threshold uyarıları otomatik susturulur.'
        }
        description="Bakım penceresi aktifken ilgili cihazlar için AlertRule ihlalleri bildirim göndermez."
      />
      <div style={{ marginBottom: 12 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Bakım Penceresi Ekle
        </Button>
      </div>
      <Table
        dataSource={windows}
        rowKey="id"
        columns={columns}
        loading={isLoading}
        size="small"
        pagination={false}
        locale={{ emptyText: 'Henüz bakım penceresi yok' }}
      />

      <Modal
        title={editing ? 'Bakım Penceresini Düzenle' : 'Yeni Bakım Penceresi'}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setEditing(null) }}
        onOk={() => form.submit()}
        confirmLoading={saveMutation.isPending}
        width={520}
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMutation.mutate(v)}>
          <Form.Item label="Bakım Adı" name="name" rules={[{ required: true }]}>
            <Input placeholder="Örn: Aylık Güncelleme — Core Katman" />
          </Form.Item>
          <Form.Item label="Açıklama" name="description">
            <Input placeholder="Opsiyonel not" />
          </Form.Item>
          <Form.Item label="Tarih & Saat Aralığı" name="time_range" rules={[{ required: true }]}>
            <DatePicker.RangePicker
              showTime={{ format: 'HH:mm' }}
              format="DD.MM.YYYY HH:mm"
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item name="applies_to_all" valuePropName="checked" label="Kapsam">
            <Switch checkedChildren="Tüm Cihazlar" unCheckedChildren="Seçili Cihazlar" />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.applies_to_all !== cur.applies_to_all}
          >
            {({ getFieldValue }) => !getFieldValue('applies_to_all') && (
              <Form.Item label="Cihazlar" name="device_ids" tooltip="Bakım kapsamındaki cihazları seçin">
                <Select
                  mode="multiple"
                  placeholder="Cihaz seçin"
                  showSearch
                  filterOption={(input, opt) =>
                    (opt?.label as string ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                  options={devices.map((d) => ({ label: `${d.hostname} (${d.ip_address})`, value: d.id }))}
                />
              </Form.Item>
            )}
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

// ── API Tokens Tab ──────────────────────────────────────────────────────────

function ApiTokensTab() {
  const qc = useQueryClient()
  const { isDark } = useTheme()
  const [createOpen, setCreateOpen] = useState(false)
  const [createdToken, setCreatedToken] = useState<string | null>(null)
  const [form] = Form.useForm()
  const [msgApi, msgCtx] = message.useMessage()

  const { data: tokens, isLoading } = useQuery<ApiToken[]>({
    queryKey: ['api-tokens'],
    queryFn: apiTokensApi.list,
  })

  const createMut = useMutation({
    mutationFn: ({ name, days }: { name: string; days?: number }) =>
      apiTokensApi.create(name, days),
    onSuccess: (data) => {
      setCreatedToken(data.token)
      qc.invalidateQueries({ queryKey: ['api-tokens'] })
      form.resetFields()
    },
    onError: () => msgApi.error('Token oluşturulamadı'),
  })

  const revokeMut = useMutation({
    mutationFn: (id: number) => apiTokensApi.revoke(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['api-tokens'] })
      msgApi.success('Token iptal edildi')
    },
  })

  const C = isDark
    ? { bg: '#1e293b', border: '#334155', text: '#f1f5f9', muted: '#64748b', codeBg: '#0f172a' }
    : { bg: '#ffffff', border: '#e2e8f0', text: '#1e293b', muted: '#94a3b8', codeBg: '#f1f5f9' }

  const columns = [
    {
      title: 'İsim',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <Text style={{ fontWeight: 600, color: C.text }}>{name}</Text>,
    },
    {
      title: 'Prefix',
      dataIndex: 'prefix',
      key: 'prefix',
      render: (p: string) => (
        <code style={{ background: C.codeBg, padding: '2px 6px', borderRadius: 4, fontSize: 12, color: '#22c55e' }}>
          {p}…
        </code>
      ),
    },
    {
      title: 'Son Kullanım',
      dataIndex: 'last_used_at',
      key: 'last_used_at',
      render: (d?: string) => d ? (
        <Tooltip title={dayjs(d).format('DD.MM.YYYY HH:mm:ss')}>
          <Text style={{ color: C.muted, fontSize: 12 }}>{dayjs(d).fromNow()}</Text>
        </Tooltip>
      ) : <Text style={{ color: C.muted, fontSize: 12 }}>Hiç kullanılmadı</Text>,
    },
    {
      title: 'Son Kullanma',
      dataIndex: 'expires_at',
      key: 'expires_at',
      render: (d?: string) => d ? (
        <Tag color={dayjs(d).isBefore(dayjs()) ? 'red' : dayjs(d).diff(dayjs(), 'day') < 7 ? 'orange' : 'default'}>
          {dayjs(d).format('DD.MM.YYYY')}
        </Tag>
      ) : <Tag color="green">Süresiz</Tag>,
    },
    {
      title: 'Oluşturulma',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (d: string) => <Text style={{ color: C.muted, fontSize: 12 }}>{dayjs(d).format('DD.MM.YYYY HH:mm')}</Text>,
    },
    {
      title: '',
      key: 'action',
      render: (_: unknown, rec: ApiToken) => (
        <Popconfirm
          title="Bu token'ı iptal et?"
          description="Bu işlem geri alınamaz."
          okText="İptal Et"
          cancelText="Vazgeç"
          okButtonProps={{ danger: true }}
          onConfirm={() => revokeMut.mutate(rec.id)}
        >
          <Button size="small" danger type="text" icon={<DeleteOutlined />} loading={revokeMut.isPending}>
            İptal Et
          </Button>
        </Popconfirm>
      ),
    },
  ]

  return (
    <div>
      {msgCtx}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <Text style={{ fontWeight: 600, fontSize: 15 }}>API Token Yönetimi</Text>
          <br />
          <Text type="secondary" style={{ fontSize: 12 }}>
            Otomasyon ve API erişimi için uzun ömürlü tokenlar oluşturun.
          </Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          Yeni Token
        </Button>
      </div>

      <Table
        dataSource={tokens || []}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        locale={{ emptyText: 'Henüz token yok' }}
        pagination={false}
      />

      {/* Create modal */}
      <Modal
        open={createOpen && !createdToken}
        title={<Space><KeyOutlined style={{ color: '#3b82f6' }} /> Yeni API Token Oluştur</Space>}
        onCancel={() => { setCreateOpen(false); form.resetFields() }}
        onOk={() => form.submit()}
        okText="Oluştur"
        confirmLoading={createMut.isPending}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(vals) => createMut.mutate({ name: vals.name, days: vals.expires_in_days || undefined })}
          style={{ marginTop: 16 }}
        >
          <Form.Item label="Token İsmi" name="name" rules={[{ required: true, message: 'İsim giriniz' }]}>
            <Input placeholder="ör. CI/CD Pipeline, Monitoring Bot" />
          </Form.Item>
          <Form.Item label="Son Kullanma Tarihi" name="expires_in_days" help="Boş bırakılırsa süresiz">
            <Select allowClear placeholder="Süresiz">
              <Select.Option value={30}>30 gün</Select.Option>
              <Select.Option value={90}>90 gün</Select.Option>
              <Select.Option value={180}>180 gün</Select.Option>
              <Select.Option value={365}>1 yıl</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* Show created token */}
      <Modal
        open={!!createdToken}
        title={<Space><KeyOutlined style={{ color: '#22c55e' }} /> Token Oluşturuldu</Space>}
        onCancel={() => { setCreatedToken(null); setCreateOpen(false) }}
        footer={[
          <Button key="close" type="primary" onClick={() => { setCreatedToken(null); setCreateOpen(false) }}>
            Tamam, Sakladım
          </Button>,
        ]}
      >
        <Alert
          type="warning"
          showIcon
          icon={<ExclamationCircleOutlined />}
          message="Bu token bir daha gösterilmeyecek!"
          description="Lütfen şimdi kopyalayın ve güvenli bir yere saklayın."
          style={{ marginBottom: 16 }}
        />
        <div style={{
          background: C.codeBg, border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <code style={{ flex: 1, fontSize: 13, wordBreak: 'break-all', color: '#22c55e', fontFamily: 'monospace' }}>
            {createdToken}
          </code>
          <Tooltip title="Kopyala">
            <Button
              icon={<CopyOutlined />}
              size="small"
              onClick={() => {
                navigator.clipboard.writeText(createdToken!)
                msgApi.success('Token kopyalandı')
              }}
            />
          </Tooltip>
        </div>
        <Text type="secondary" style={{ fontSize: 12, marginTop: 8, display: 'block' }}>
          Header'da kullanım: <code>Authorization: Bearer {createdToken?.slice(0, 16)}…</code>
        </Text>
      </Modal>
    </div>
  )
}

// ── AI Settings Tab ─────────────────────────────────────────────────────────

const PROVIDER_COLORS: Record<string, string> = {
  claude: '#cc785c',
  openai: '#10a37f',
  gemini: '#4285f4',
  ollama: '#7c3aed',
}

const CLAUDE_MODELS = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']
const OPENAI_MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo']
const GEMINI_MODELS = ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash-exp']

function AISettingsTab() {
  const qc = useQueryClient()
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})

  const { data: settings, isLoading } = useQuery<AIProviderSettings>({
    queryKey: ['ai-settings'],
    queryFn: aiAssistantApi.getSettings,
  })

  React.useEffect(() => {
    if (settings) {
      form.setFieldsValue({
        active_provider: settings.active_provider ?? '',
        claude_model: settings.claude_model,
        openai_model: settings.openai_model,
        gemini_model: settings.gemini_model,
        ollama_base_url: settings.ollama_base_url,
        ollama_model: settings.ollama_model,
      })
    }
  }, [settings, form])

  const activeProvider = Form.useWatch('active_provider', form)

  const save = async () => {
    const vals = form.getFieldsValue()
    setSaving(true)
    try {
      const payload: Record<string, any> = { active_provider: vals.active_provider || null }
      if (vals.claude_model) payload.claude_model = vals.claude_model
      if (vals.claude_api_key) payload.claude_api_key = vals.claude_api_key
      if (vals.openai_model) payload.openai_model = vals.openai_model
      if (vals.openai_api_key) payload.openai_api_key = vals.openai_api_key
      if (vals.gemini_model) payload.gemini_model = vals.gemini_model
      if (vals.gemini_api_key) payload.gemini_api_key = vals.gemini_api_key
      if (vals.ollama_base_url !== undefined) payload.ollama_base_url = vals.ollama_base_url
      if (vals.ollama_model !== undefined) payload.ollama_model = vals.ollama_model
      await aiAssistantApi.updateSettings(payload)
      qc.invalidateQueries({ queryKey: ['ai-settings'] })
      message.success('AI ayarları kaydedildi')
    } catch {
      message.error('Kayıt başarısız')
    } finally {
      setSaving(false)
    }
  }

  const { isDark } = useTheme()
  const C = { bg2: isDark ? '#0f172a' : '#f8fafc', border: isDark ? '#334155' : '#e2e8f0', text: isDark ? '#f1f5f9' : '#1e293b', muted: isDark ? '#64748b' : '#94a3b8' }

  const providers: { id: string; name: string; keyField?: string; modelField?: string; models?: string[]; configured?: boolean }[] = [
    { id: 'claude', name: 'Anthropic Claude', keyField: 'claude_api_key', modelField: 'claude_model', models: CLAUDE_MODELS, configured: settings?.claude_configured },
    { id: 'openai', name: 'OpenAI GPT', keyField: 'openai_api_key', modelField: 'openai_model', models: OPENAI_MODELS, configured: settings?.openai_configured },
    { id: 'gemini', name: 'Google Gemini', keyField: 'gemini_api_key', modelField: 'gemini_model', models: GEMINI_MODELS, configured: settings?.gemini_configured },
    { id: 'ollama', name: 'Ollama (Yerel)', configured: true },
  ]

  return (
    <div style={{ maxWidth: 720 }}>
      <Alert
        type="info"
        showIcon
        message="API anahtarlarınız sunucuda Fernet şifrelemesiyle saklanır ve asla loglanmaz."
        style={{ marginBottom: 20 }}
      />

      <Form form={form} layout="vertical">
        <Form.Item label="Aktif Sağlayıcı" name="active_provider">
          <Select placeholder="Sağlayıcı seçin" allowClear style={{ width: 280 }}>
            {providers.map(p => (
              <Select.Option key={p.id} value={p.id}>
                <span style={{ color: PROVIDER_COLORS[p.id], fontWeight: 600 }}>● </span>
                {p.name}
                {p.configured && p.id !== 'ollama' && <CheckCircleOutlined style={{ color: '#22c55e', marginLeft: 8 }} />}
              </Select.Option>
            ))}
          </Select>
        </Form.Item>

        {providers.filter(p => p.id !== 'ollama').map(p => (
          <div key={p.id} style={{
            background: C.bg2, border: `1px solid ${activeProvider === p.id ? PROVIDER_COLORS[p.id] : C.border}`,
            borderRadius: 10, padding: '16px 20px', marginBottom: 16,
            opacity: activeProvider && activeProvider !== p.id ? 0.6 : 1,
            transition: 'all 0.2s',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ color: PROVIDER_COLORS[p.id], fontWeight: 700, fontSize: 14 }}>
                {p.name}
              </span>
              {p.configured
                ? <Tag color="success" icon={<CheckCircleOutlined />}>Yapılandırıldı</Tag>
                : <Tag color="default">API anahtarı yok</Tag>}
            </div>
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              <Form.Item name={p.keyField} noStyle>
                <Input.Password
                  placeholder={`${p.name} API Anahtarı${p.configured ? ' (değiştirmek için yaz)' : ''}`}
                  style={{ width: '100%' }}
                  visibilityToggle={{
                    visible: showKeys[p.id!] ?? false,
                    onVisibleChange: v => setShowKeys(prev => ({ ...prev, [p.id!]: v })),
                  }}
                />
              </Form.Item>
              <Form.Item name={p.modelField} noStyle>
                <Select style={{ width: 280 }} placeholder="Model seç">
                  {(p.models ?? []).map(m => (
                    <Select.Option key={m} value={m}>{m}</Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Space>
          </div>
        ))}

        {/* Ollama */}
        <div style={{
          background: C.bg2, border: `1px solid ${activeProvider === 'ollama' ? PROVIDER_COLORS['ollama'] : C.border}`,
          borderRadius: 10, padding: '16px 20px', marginBottom: 16,
          opacity: activeProvider && activeProvider !== 'ollama' ? 0.6 : 1,
          transition: 'all 0.2s',
        }}>
          <div style={{ fontWeight: 700, color: PROVIDER_COLORS['ollama'], marginBottom: 12, fontSize: 14 }}>
            Ollama (Yerel Model)
            <Tag color="purple" style={{ marginLeft: 8 }}>API Key Gerektirmez</Tag>
          </div>
          <Space>
            <Form.Item name="ollama_base_url" noStyle>
              <Input placeholder="http://localhost:11434" style={{ width: 280 }} />
            </Form.Item>
            <Form.Item name="ollama_model" noStyle>
              <Input placeholder="llama3.2" style={{ width: 160 }} />
            </Form.Item>
          </Space>
        </div>

        <Button type="primary" loading={saving || isLoading} onClick={save} icon={<CheckOutlined />}>
          Kaydet
        </Button>
      </Form>
    </div>
  )
}

// ── Main Settings Page ──────────────────────────────────────────────────────

export default function SettingsPage() {
  const { t } = useTranslation()
  const { isDark, toggle } = useTheme()
  const currentLang = i18n.language

  function handleLangChange(code: string) {
    i18n.changeLanguage(code)
    localStorage.setItem('nm-lang', code)
  }

  const generalContent = (
    <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 28 }}>
      {/* Language */}
      <div>
        <SectionHeader icon={<GlobalOutlined />} title={t('settings.section_general')} />
        <div style={{ marginBottom: 8 }}>
          <Text style={{ fontWeight: 600, fontSize: 14 }}>{t('settings.language')}</Text>
          <br />
          <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.language_desc')}</Text>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          {LANGUAGES.map((lang) => {
            const isActive = currentLang === lang.code
            return (
              <div
                key={lang.code}
                onClick={() => handleLangChange(lang.code)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '14px 16px',
                  borderRadius: 10,
                  border: isActive
                    ? '2px solid #3b82f6'
                    : `2px solid ${isDark ? '#334155' : '#e2e8f0'}`,
                  background: isActive
                    ? (isDark ? '#1d4ed815' : '#eff6ff')
                    : (isDark ? '#1e293b' : '#ffffff'),
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  position: 'relative',
                }}
              >
                <span style={{ fontSize: 28, lineHeight: 1 }}>{lang.flag}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: isActive ? 700 : 500, fontSize: 14 }}>{lang.label}</div>
                  <div style={{ fontSize: 11, opacity: 0.5 }}>{lang.region}</div>
                </div>
                {isActive && (
                  <div style={{
                    width: 22, height: 22, borderRadius: '50%',
                    background: '#3b82f6',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    <CheckOutlined style={{ color: '#fff', fontSize: 11 }} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <Divider style={{ margin: '4px 0' }} />

      {/* Appearance */}
      <div>
        <SectionHeader icon={<BgColorsOutlined />} title={t('settings.section_appearance')} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <Text style={{ fontWeight: 600, fontSize: 14 }}>{t('settings.theme')}</Text>
            <br />
            <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.theme_desc')}</Text>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Tag icon={isDark ? <MoonOutlined /> : <SunOutlined />} color={isDark ? 'blue' : 'default'}>
              {isDark ? t('settings.theme_dark') : t('settings.theme_light')}
            </Tag>
            <Switch
              checked={isDark}
              onChange={toggle}
              checkedChildren={<MoonOutlined />}
              unCheckedChildren={<SunOutlined />}
            />
          </div>
        </div>
      </div>

      <Divider style={{ margin: '4px 0' }} />

      <div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('settings.version')}: 1.0.0
        </Text>
      </div>
    </div>
  )

  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = searchParams.get('tab') || 'general'

  const C = { bg: isDark ? '#1e293b' : '#ffffff', bg2: isDark ? '#0f172a' : '#f8fafc', border: isDark ? '#334155' : '#e2e8f0', text: isDark ? '#f1f5f9' : '#1e293b', muted: isDark ? '#64748b' : '#94a3b8' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : C.bg,
        border: `1px solid ${isDark ? '#64748b20' : C.border}`,
        borderLeft: '4px solid #64748b',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10,
          background: '#64748b20', border: '1px solid #64748b30',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <ToolOutlined style={{ color: '#64748b', fontSize: 20 }} />
        </div>
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>{t('settings.title')}</div>
          <div style={{ color: C.muted, fontSize: 12 }}>NetManager v1.0</div>
        </div>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setSearchParams({ tab: key })}
        items={[
          {
            key: 'general',
            label: <span><GlobalOutlined /> Genel</span>,
            children: generalContent,
          },
          {
            key: 'notifications',
            label: <span><BellOutlined /> Bildirimler</span>,
            children: <NotificationChannelsTab />,
          },
          {
            key: 'alert-rules',
            label: <span><AlertOutlined /> Uyarı Kuralları</span>,
            children: <AlertRulesTab />,
          },
          {
            key: 'maintenance',
            label: <span><ToolOutlined /> Bakım Pencereleri</span>,
            children: <MaintenanceWindowsTab />,
          },
          {
            key: 'credentials',
            label: <span><SafetyOutlined /> Kimlik Profilleri</span>,
            children: <CredentialProfilesTab />,
          },
          {
            key: 'rotation',
            label: <span><SyncOutlined /> Şifre Rotasyonu</span>,
            children: <SecretRotationTab />,
          },
          {
            key: 'sla',
            label: <span><RiseOutlined /> SLA Politikaları</span>,
            children: <SlaPoliciesTab />,
          },
          {
            key: 'snmp',
            label: <span><WifiOutlined /> SNMP</span>,
            children: <SnmpConfigTab />,
          },
          {
            key: 'api-tokens',
            label: <span><KeyOutlined /> API Tokenlar</span>,
            children: <ApiTokensTab />,
          },
          {
            key: 'driver-templates',
            label: <span><CodeOutlined /> Sürücü Şablonları</span>,
            children: <DriverTemplatesPage />,
          },
          {
            key: 'ai',
            label: <span><RobotOutlined /> AI Asistanı</span>,
            children: <AISettingsTab />,
          },
        ]}
      />
    </div>
  )
}
