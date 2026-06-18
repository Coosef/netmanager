// AgentDetailModal — agent detail/management modal (Durum/Güvenlik/Komut Logu/
// Keşif/Syslog/Akış/SNMP/Vault tabs), ported from the pre-T8.4 AgentsPage so
// the NOC card grid keeps full per-agent management. Real data + real actions
// (restart, key rotation, security policy, discovery, syslog, SSH stream, SNMP,
// vault refresh). Card click in NocAgents opens this.
import { useState } from 'react'
import {
  App, Alert, AutoComplete, Button, Descriptions, Form, Input, Modal, Select,
  Popconfirm, Progress, Space, Table, Tag, Tooltip, Typography,
  Tabs, Badge, Switch, Divider,
} from 'antd'
import { useTheme } from '@/contexts/ThemeContext'
import {
  ReloadOutlined, RobotOutlined, CopyOutlined,
  PoweroffOutlined, ThunderboltOutlined,
  CheckCircleOutlined, CloseCircleOutlined, DashboardOutlined,
  SafetyOutlined, HistoryOutlined, KeyOutlined, LockOutlined, UnlockOutlined,
  WarningOutlined, PlusCircleOutlined, SearchOutlined, WifiOutlined,
  DatabaseOutlined, SafetyCertificateOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  agentsApi, type Agent,
  type AgentCommandLog, type AgentSecurityConfig,
  type SnmpGetResult, type SnmpWalkResult,
} from '@/api/agents'
import { devicesApi } from '@/api/devices'
import { useAuthStore } from '@/store/auth'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)

const { Text } = Typography

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

function MetricBar({ label, value, color }: { label: string; value: number; color: string }) {
  const { isDark } = useTheme()
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
        <span>{label}</span>
        <span style={{ fontWeight: 600, color }}>{value.toFixed(1)}%</span>
      </div>
      <Progress
        percent={value}
        showInfo={false}
        size="small"
        strokeColor={value > 85 ? '#ef4444' : value > 60 ? '#f59e0b' : color}
        trailColor={isDark ? '#334155' : '#e2e8f0'}
      />
    </div>
  )
}

// ── SecurityTab ───────────────────────────────────────────────────────────────

function SecurityTab({ agent }: { agent: Agent; onClose: () => void }) {
  // location-agent-permissions: hard-disable every mutating control in
  // the SecurityTab when the caller lacks `agents.update`. The backend
  // gate (_require_agent_perm in agents.py) is authoritative; this is
  // the UX layer so a viewer / install-only operator does not click a
  // button only to get bounced with a 403.
  const canUpdate = useAuthStore((s) => s.can('agents', 'update'))
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const { message } = App.useApp()
  const queryClient = useQueryClient()

  const [mode, setMode] = useState<'all' | 'whitelist' | 'blacklist'>(agent.command_mode)
  const [commands, setCommands] = useState<string[]>(
    agent.allowed_commands?.length ? agent.allowed_commands : []
  )
  const [allowedIps, setAllowedIps] = useState(agent.allowed_ips || '')
  const [newCmd, setNewCmd] = useState('')

  const securityMutation = useMutation({
    mutationFn: (config: AgentSecurityConfig) => agentsApi.updateSecurity(agent.id, config),
    onSuccess: () => {
      message.success('Güvenlik politikası güncellendi')
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Güncelleme hatası'),
  })

  const rotateMutation = useMutation({
    mutationFn: () => agentsApi.rotateKey(agent.id),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      Modal.success({
        title: 'Key Rotasyonu Tamamlandı',
        width: 540,
        content: (
          <div>
            <Alert type="warning" showIcon style={{ marginBottom: 12 }}
              message="Bu key bir daha gösterilmeyecek. Şimdi kopyalayın." />
            <div style={{ background: '#0f172a', borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <code style={{ color: '#e2e8f0', wordBreak: 'break-all', flex: 1, fontSize: 12 }}>{data.new_key}</code>
              <Button size="small" icon={<CopyOutlined />}
                onClick={() => { navigator.clipboard.writeText(data.new_key); message.success('Kopyalandı') }}>
                Kopyala
              </Button>
            </div>
            {data.agent_notified
              ? <Alert type="success" showIcon style={{ marginTop: 12 }} message="Agent çevrimiçi — key otomatik güncellendi." />
              : <Alert type="warning" showIcon style={{ marginTop: 12 }} message="Agent çevrimdışı — agent.env dosyasını manuel güncelleyin." />
            }
          </div>
        ),
      })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Key rotasyonu başarısız'),
  })

  const unlockMutation = useMutation({
    mutationFn: () => agentsApi.unlock(agent.id),
    onSuccess: () => { message.success('Agent kilidi açıldı'); queryClient.invalidateQueries({ queryKey: ['agents'] }) },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Kilit açma başarısız'),
  })

  const addCmd = () => {
    const trimmed = newCmd.trim().toLowerCase()
    if (trimmed && !commands.includes(trimmed)) {
      setCommands([...commands, trimmed])
      setNewCmd('')
    }
  }

  const removeCmd = (cmd: string) => setCommands(commands.filter((c) => c !== cmd))

  const modeDesc: Record<string, string> = {
    all: 'Tüm komutlara izin verilir — kısıtlama yok',
    whitelist: 'Yalnızca listedeki komut öneklerine izin verilir',
    blacklist: 'Listedeki komut önekleri engellenir, geri kalan serbest',
  }

  const isLocked = agent.failed_auth_count >= 10

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Lock warning */}
      {isLocked && (
        <Alert
          type="error" showIcon
          icon={<LockOutlined />}
          message="Agent Kilitli"
          description={`${agent.failed_auth_count} başarısız giriş denemesi nedeniyle bağlantı engelleniyor.`}
          action={
            <Popconfirm title="Agent kilidini aç?" onConfirm={() => unlockMutation.mutate()} okText="Evet" cancelText="İptal" disabled={!canUpdate}>
              <Button size="small" icon={<UnlockOutlined />} loading={unlockMutation.isPending}
                disabled={!canUpdate} aria-disabled={!canUpdate || undefined}
                data-testid="agent-unlock-button" data-perm="agents.update">Kilidi Aç</Button>
            </Popconfirm>
          }
        />
      )}
      {!isLocked && agent.failed_auth_count > 0 && (
        <Alert type="warning" showIcon
          message={`${agent.failed_auth_count} başarısız giriş denemesi (10'da kilitlenir)`}
          action={
            <Popconfirm title="Sayacı sıfırla?" onConfirm={() => unlockMutation.mutate()} okText="Evet" cancelText="İptal" disabled={!canUpdate}>
              <Button size="small"
                disabled={!canUpdate} aria-disabled={!canUpdate || undefined}
                data-testid="agent-reset-failed-count" data-perm="agents.update">Sıfırla</Button>
            </Popconfirm>
          }
        />
      )}

      {/* Command mode */}
      <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: C.text, marginBottom: 10 }}>
          <SafetyOutlined style={{ marginRight: 6, color: '#8b5cf6' }} />
          Komut Güvenlik Modu
        </div>
        <Select
          value={mode}
          onChange={(v) => setMode(v)}
          style={{ width: '100%', marginBottom: 8 }}
          options={[
            { value: 'all', label: 'Tüm Komutlar (Kısıtsız)' },
            { value: 'whitelist', label: 'Whitelist (Yalnızca İzin Verilenler)' },
            { value: 'blacklist', label: 'Blacklist (Engellenenler Hariç)' },
          ]}
        />
        <Text style={{ fontSize: 12, color: '#8b5cf6' }}>{modeDesc[mode]}</Text>
      </div>

      {/* Command list */}
      {mode !== 'all' && (
        <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: C.text, marginBottom: 10 }}>
            {mode === 'whitelist' ? 'İzin Verilen Komut Önekleri' : 'Engellenen Komut Önekleri'}
            <Text style={{ fontSize: 11, color: C.muted, fontWeight: 400, marginLeft: 8 }}>
              (ör: "show ", "conf t", "no ")
            </Text>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <Input
              placeholder="Komut öneki girin..."
              value={newCmd}
              onChange={(e) => setNewCmd(e.target.value)}
              onPressEnter={addCmd}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
            <Button icon={<PlusCircleOutlined />} onClick={addCmd} type="primary">Ekle</Button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {commands.length === 0 && (
              <Text style={{ fontSize: 12, color: C.muted }}>
                {mode === 'whitelist'
                  ? 'Liste boş — sadece salt-okunur (show/display/ping) komutlar izinli'
                  : 'Liste boş — tüm komutlar serbest'}
              </Text>
            )}
            {commands.map((cmd) => (
              <Tag
                key={cmd}
                closable
                onClose={() => removeCmd(cmd)}
                style={{
                  fontFamily: 'monospace', fontSize: 12,
                  color: mode === 'whitelist' ? '#22c55e' : '#ef4444',
                  borderColor: (mode === 'whitelist' ? '#22c55e' : '#ef4444') + '50',
                  background: (mode === 'whitelist' ? '#22c55e' : '#ef4444') + '12',
                }}
              >
                {cmd}
              </Tag>
            ))}
          </div>
        </div>
      )}

      {/* Allowed IPs */}
      <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: C.text, marginBottom: 8 }}>
          Güvenilir Kaynak IP'leri
          <Text style={{ fontSize: 11, color: C.muted, fontWeight: 400, marginLeft: 8 }}>(boş = tüm IP'ler kabul)</Text>
        </div>
        <Input
          placeholder="192.168.1.10, 10.0.0.0/24"
          value={allowedIps}
          onChange={(e) => setAllowedIps(e.target.value)}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
        <Text style={{ fontSize: 11, color: C.muted, marginTop: 4, display: 'block' }}>
          Virgülle ayrılmış IP adresleri. Agent yalnızca bu IP'lerden gelen komutları kabul eder.
        </Text>
      </div>

      <Button
        type="primary"
        icon={<SafetyOutlined />}
        loading={securityMutation.isPending}
        disabled={!canUpdate}
        aria-disabled={!canUpdate || undefined}
        onClick={canUpdate ? () => securityMutation.mutate({ command_mode: mode, allowed_commands: commands, allowed_ips: allowedIps }) : undefined}
        style={{ background: '#8b5cf6', borderColor: '#8b5cf6' }}
        data-testid="agent-save-security-button"
        data-perm="agents.update"
      >
        Güvenlik Politikasını Kaydet
      </Button>

      <Divider style={{ margin: '8px 0' }} />

      {/* Key rotation */}
      <div style={{ background: isDark ? '#1e0a0a' : '#fff5f5', border: `1px solid ${isDark ? '#7f1d1d40' : '#fca5a5'}`, borderRadius: 10, padding: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: '#ef4444', marginBottom: 6 }}>
          <KeyOutlined style={{ marginRight: 6 }} />
          Agent Key Rotasyonu
        </div>
        <Text style={{ fontSize: 12, color: C.muted, display: 'block', marginBottom: 10 }}>
          Mevcut key geçersiz kılınır, yeni key üretilir. Agent çevrimiçiyse otomatik güncellenir.
          Son rotasyon: {agent.key_last_rotated ? dayjs(agent.key_last_rotated).format('DD.MM.YYYY HH:mm') : 'Hiç yapılmadı'}
        </Text>
        <Popconfirm
          title="Key rotasyonu yap?"
          description="Bu işlem geri alınamaz. Yeni key kaydet!"
          onConfirm={() => rotateMutation.mutate()}
          okText="Evet, Rotasyon Yap"
          cancelText="İptal"
          okButtonProps={{ danger: true }}
          disabled={!canUpdate}
        >
          <Button danger icon={<KeyOutlined />} loading={rotateMutation.isPending}
            disabled={!canUpdate} aria-disabled={!canUpdate || undefined}
            data-testid="agent-rotate-key-button" data-perm="agents.update">
            Yeni Key Üret
          </Button>
        </Popconfirm>
      </div>
    </div>
  )
}

// ── CommandLogTab ─────────────────────────────────────────────────────────────

function CommandLogTab({ agentId }: { agentId: string }) {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const [blockedOnly, setBlockedOnly] = useState(false)
  const [page, setPage] = useState(1)
  const pageSize = 20

  const { data, isLoading } = useQuery({
    queryKey: ['agent-commands', agentId, blockedOnly, page],
    queryFn: () => agentsApi.getCommands(agentId, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
      blocked_only: blockedOnly,
    }),
    refetchInterval: 15000,
  })

  const cmdTypeColor: Record<string, string> = {
    ssh_command: '#3b82f6',
    ssh_config: '#f59e0b',
    ssh_test: '#64748b',
  }
  const cmdTypeLabel: Record<string, string> = {
    ssh_command: 'Komut',
    ssh_config: 'Config',
    ssh_test: 'Test',
  }

  const columns = [
    {
      title: 'Zaman',
      dataIndex: 'executed_at',
      width: 130,
      render: (v: string) => (
        <Tooltip title={dayjs(v).format('DD.MM.YYYY HH:mm:ss')}>
          <Text style={{ fontSize: 11, color: C.muted }}>{dayjs(v).fromNow()}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Tip',
      dataIndex: 'command_type',
      width: 80,
      render: (v: string) => (
        <Tag style={{ fontSize: 10, color: cmdTypeColor[v], borderColor: cmdTypeColor[v] + '50', background: cmdTypeColor[v] + '15' }}>
          {cmdTypeLabel[v] || v}
        </Tag>
      ),
    },
    {
      title: 'Komut',
      dataIndex: 'command',
      render: (v: string, r: AgentCommandLog) => (
        <div>
          <code style={{ fontSize: 11, color: r.blocked ? '#ef4444' : C.text, fontFamily: 'monospace' }}>
            {v || '—'}
          </code>
          {r.blocked && r.block_reason && (
            <div style={{ fontSize: 10, color: '#ef4444', marginTop: 2 }}>
              <WarningOutlined style={{ marginRight: 3 }} />{r.block_reason}
            </div>
          )}
        </div>
      ),
    },
    {
      title: 'Cihaz IP',
      dataIndex: 'device_ip',
      width: 120,
      render: (v: string) => v
        ? <code style={{ fontSize: 11, color: '#06b6d4' }}>{v}</code>
        : <span style={{ color: C.dim }}>—</span>,
    },
    {
      title: 'Durum',
      dataIndex: 'success',
      width: 90,
      render: (_: unknown, r: AgentCommandLog) => {
        if (r.blocked) return <Tag color="red" style={{ fontSize: 10 }}>Engellendi</Tag>
        if (r.success === true) return <Tag color="green" style={{ fontSize: 10 }}>Başarılı</Tag>
        if (r.success === false) return <Tag color="red" style={{ fontSize: 10 }}>Hata</Tag>
        return <Tag style={{ fontSize: 10 }}>—</Tag>
      },
    },
    {
      title: 'Süre',
      dataIndex: 'duration_ms',
      width: 70,
      render: (v: number) => v != null
        ? <Text style={{ fontSize: 11, color: C.muted }}>{v}ms</Text>
        : <span style={{ color: C.dim }}>—</span>,
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Space>
          <Switch
            size="small"
            checked={blockedOnly}
            onChange={(v) => { setBlockedOnly(v); setPage(1) }}
          />
          <Text style={{ fontSize: 12, color: C.text }}>Yalnızca engellenenler</Text>
        </Space>
        <Text style={{ fontSize: 11, color: C.muted }}>{data?.total ?? 0} kayıt</Text>
      </div>
      <Table<AgentCommandLog>
        dataSource={data?.items || []}
        rowKey="id"
        loading={isLoading}
        size="small"
        columns={columns}
        pagination={{
          current: page,
          pageSize,
          total: data?.total,
          size: 'small',
          onChange: setPage,
        }}
        onRow={(r: AgentCommandLog) => ({ style: r.blocked ? { background: isDark ? '#450a0a20' : '#fff5f5' } : {} })}
      />
    </div>
  )
}

// ── Subnet normalization ──────────────────────────────────────────────────────
// Accepts both CIDR (192.168.1.0/24) and dotted-mask (192.168.1.0/255.255.255.0)
// Returns normalized network CIDR or null if invalid
function normalizeSubnet(raw: string): string | null {
  const s = raw.trim()
  // Dotted-decimal mask: 10.2.16.1/255.255.255.0
  const dotted = s.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted) {
    const ip = dotted[1].split('.').map(Number)
    const mk = dotted[2].split('.').map(Number)
    if (ip.some(b => b > 255) || mk.some(b => b > 255)) return null
    let prefix = 0
    for (const b of mk) { let x = b; while (x) { prefix += x & 1; x >>= 1 } }
    const net = ip.map((b, i) => b & mk[i])
    return `${net.join('.')}/${prefix}`
  }
  // Standard CIDR
  const cidr = s.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/)
  if (cidr) {
    const parts = cidr[1].split('.').map(Number)
    const prefix = parseInt(cidr[2])
    if (parts.some(b => b > 255) || prefix > 32) return null
    const ipInt = (parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3]) >>> 0
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
    const net = (ipInt & mask) >>> 0
    return `${(net >>> 24) & 0xff}.${(net >>> 16) & 0xff}.${(net >>> 8) & 0xff}.${net & 0xff}/${prefix}`
  }
  return null
}

// ── DiscoveryTab ──────────────────────────────────────────────────────────────

function DiscoveryTab({ agent }: { agent: Agent }) {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  const [subnet, setSubnet] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [result, setResult] = useState<{hosts: any[]; scanned: number} | null>(null)
  const [addTarget, setAddTarget] = useState<{ip: string; port: number} | null>(null)
  const [addForm] = Form.useForm()

  const { data: history = [] } = useQuery({
    queryKey: ['agent-discovery-history', agent.id],
    queryFn: () => agentsApi.getDiscoveryHistory(agent.id),
  })

  const addDeviceMutation = useMutation({
    mutationFn: (values: any) =>
      devicesApi.create({
        hostname: values.hostname,
        ip_address: addTarget!.ip,
        vendor: values.vendor,
        os_type: values.os_type,
        device_type: 'switch',
        ssh_username: values.ssh_username || 'admin',
        ssh_port: addTarget!.port,
        agent_id: agent.id,
      }),
    onSuccess: () => {
      message.success(`${addTarget!.ip} envantere eklendi`)
      setAddTarget(null)
      addForm.resetFields()
      queryClient.invalidateQueries({ queryKey: ['devices'] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Cihaz eklenemedi'),
  })

  const run = async () => {
    if (!subnet.trim()) { message.warning('Subnet giriniz (örn: 192.168.1.0/24)'); return }
    const normalized = normalizeSubnet(subnet.trim())
    if (!normalized) {
      message.error('Geçersiz subnet formatı. Örnek: 192.168.1.0/24 veya 192.168.1.0/255.255.255.0')
      return
    }
    // Warn if too large (> /22 = 1024 IPs)
    const prefix = parseInt(normalized.split('/')[1])
    if (prefix < 22) {
      message.warning(`/${prefix} çok büyük (${Math.pow(2, 32 - prefix)} IP). Maksimum /22 önerilir.`)
      return
    }
    // Auto-correct display if format was normalized
    if (normalized !== subnet.trim()) setSubnet(normalized)
    setIsRunning(true)
    try {
      const res = await agentsApi.discover(agent.id, { subnet: normalized })
      setResult(res)
      message.success(`${res.hosts?.length ?? 0} cihaz keşfedildi (${res.scanned} IP tarandı)`)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'Keşif başarısız — agent yanıt vermedi veya bağlantı kesildi')
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 10 }}>Ağ Tarama</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Input
            value={subnet}
            onChange={e => setSubnet(e.target.value)}
            placeholder="192.168.1.0/24"
            onPressEnter={run}
            style={{ flex: 1 }}
          />
          <Button type="primary" loading={isRunning} onClick={run}>
            {isRunning ? 'Taranıyor...' : 'Tara'}
          </Button>
        </div>
        <Text style={{ fontSize: 11, color: C.muted }}>
          CIDR (192.168.1.0/24) veya maske (192.168.1.0/255.255.255.0) formatı desteklenir. Maks /22 (1024 IP). Tarama ~60-90s sürebilir.
        </Text>
      </div>

      {result && (
        <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 8 }}>
            Sonuçlar — {result.hosts.length} cihaz / {result.scanned} IP
          </div>
          <Table
            dataSource={result.hosts}
            rowKey="ip"
            size="small"
            pagination={{ pageSize: 10 }}
            columns={[
              { title: 'IP', dataIndex: 'ip', width: 130, render: (v: string) => <code style={{ fontSize: 11 }}>{v}</code> },
              {
                title: 'Açık Portlar', dataIndex: 'open_ports', width: 140,
                render: (ports: number[]) => (
                  <Space size={4} wrap>
                    {ports.map(p => <Tag key={p} color={p === 22 ? 'green' : p === 23 ? 'orange' : 'default'} style={{ fontSize: 10 }}>{p}</Tag>)}
                  </Space>
                )
              },
              { title: 'Banner', dataIndex: 'banner', ellipsis: true, render: (v: string | null) => v ? <Text type="secondary" style={{ fontSize: 11 }}>{v}</Text> : '—' },
              { title: 'Gecikme', dataIndex: 'response_time_ms', width: 72, render: (v: number) => `${v}ms` },
              {
                title: '', width: 60, dataIndex: 'ip',
                render: (ip: string, row: any) => (
                  <Button
                    size="small"
                    type="link"
                    style={{ fontSize: 11, padding: '0 4px' }}
                    onClick={() => {
                      const port = row.open_ports?.includes(22) ? 22 : (row.open_ports?.[0] ?? 22)
                      setAddTarget({ ip, port })
                      addForm.setFieldsValue({ hostname: ip, ssh_username: 'admin', vendor: 'cisco', os_type: 'cisco_ios' })
                    }}
                  >
                    + Ekle
                  </Button>
                ),
              },
            ]}
          />
          <Modal
            open={!!addTarget}
            title={`Envantere Ekle — ${addTarget?.ip}`}
            onCancel={() => { setAddTarget(null); addForm.resetFields() }}
            onOk={() => addForm.submit()}
            okText="Ekle"
            cancelText="İptal"
            confirmLoading={addDeviceMutation.isPending}
            styles={{ content: { background: C.bg }, header: { background: C.bg } }}
          >
            <Form form={addForm} layout="vertical" size="small" onFinish={v => addDeviceMutation.mutate(v)} style={{ marginTop: 12 }}>
              <Form.Item name="hostname" label="Hostname" rules={[{ required: true, message: 'Hostname giriniz' }]}>
                <Input placeholder={addTarget?.ip} />
              </Form.Item>
              <div style={{ display: 'flex', gap: 8 }}>
                <Form.Item name="ssh_username" label="SSH Kullanıcı" style={{ flex: 1 }}>
                  <Input placeholder="admin" />
                </Form.Item>
                <Form.Item name="vendor" label="Vendor" style={{ flex: 1 }}>
                  <Select options={[
                    { value: 'cisco', label: 'Cisco' },
                    { value: 'aruba', label: 'Aruba' },
                    { value: 'ruijie', label: 'Ruijie' },
                    { value: 'juniper', label: 'Juniper' },
                    { value: 'hp', label: 'HP' },
                    { value: 'huawei', label: 'Huawei' },
                  ]} />
                </Form.Item>
                <Form.Item name="os_type" label="OS Tipi" style={{ flex: 1 }}>
                  <Select options={[
                    { value: 'cisco_ios', label: 'IOS' },
                    { value: 'cisco_nxos', label: 'NX-OS' },
                    { value: 'cisco_xr', label: 'IOS-XR' },
                    { value: 'aruba_os', label: 'ArubaOS' },
                    { value: 'ruijie_os', label: 'RuijieOS' },
                    { value: 'junos', label: 'JunOS' },
                  ]} />
                </Form.Item>
              </div>
            </Form>
          </Modal>
        </div>
      )}

      {history.length > 0 && (
        <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 8 }}>Geçmiş Taramalar</div>
          {history.slice(0, 5).map(h => (
            <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0', borderBottom: `1px solid ${C.border}` }}>
              <span><code style={{ fontSize: 11 }}>{h.subnet}</code></span>
              <span><Tag color={h.status === 'completed' ? 'green' : 'red'} style={{ fontSize: 10 }}>{h.total_discovered} cihaz</Tag></span>
              <Text type="secondary" style={{ fontSize: 11 }}>{dayjs(h.triggered_at).fromNow()}</Text>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── SyslogTab ─────────────────────────────────────────────────────────────────

const SYSLOG_SEVERITY: Record<number, { label: string; color: string }> = {
  0: { label: 'Emergency', color: '#ef4444' },
  1: { label: 'Alert', color: '#f97316' },
  2: { label: 'Critical', color: '#ef4444' },
  3: { label: 'Error', color: '#f59e0b' },
  4: { label: 'Warning', color: '#f59e0b' },
  5: { label: 'Notice', color: '#3b82f6' },
  6: { label: 'Info', color: '#22c55e' },
  7: { label: 'Debug', color: '#94a3b8' },
}

function SyslogTab({ agent }: { agent: Agent }) {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const { message } = App.useApp()
  const [enabled, setEnabled] = useState(false)
  const [port, setPort] = useState(514)
  const [severityFilter, setSeverityFilter] = useState<number>(7)

  const { data: events } = useQuery({
    queryKey: ['agent-syslog', agent.id, severityFilter],
    queryFn: () => agentsApi.getSyslogEvents(agent.id, { limit: 100, severity_max: severityFilter }),
    refetchInterval: enabled ? 5000 : false,
  })

  const toggleMutation = useMutation({
    mutationFn: (en: boolean) => agentsApi.configureSyslog(agent.id, { enabled: en, bind_port: port }),
    onSuccess: (data) => {
      setEnabled(data.enabled)
      message.success(data.enabled ? `Syslog dinleniyor (UDP :${data.bind_port})` : 'Syslog durduruldu')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Syslog yapılandırma hatası'),
  })

  const items = events?.items || []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, fontSize: 12, color: C.text }}>
            <strong>Syslog Toplayıcı</strong>
            <div style={{ color: C.muted, fontSize: 11 }}>UDP syslog mesajlarını dinler ve kaydeder</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Text style={{ fontSize: 11, color: C.muted }}>Port:</Text>
            <Input
              type="number"
              value={port}
              onChange={e => setPort(Number(e.target.value))}
              style={{ width: 70 }}
              size="small"
              disabled={enabled}
            />
            <Select
              size="small"
              value={severityFilter}
              onChange={setSeverityFilter}
              style={{ width: 110 }}
              options={[
                { value: 7, label: 'Tümü' },
                { value: 6, label: '≤ Info' },
                { value: 5, label: '≤ Notice' },
                { value: 4, label: '≤ Warning' },
                { value: 3, label: '≤ Error' },
                { value: 2, label: '≤ Critical' },
                { value: 1, label: '≤ Alert' },
                { value: 0, label: 'Emergency' },
              ]}
            />
            <Switch
              checked={enabled}
              onChange={val => toggleMutation.mutate(val)}
              loading={toggleMutation.isPending}
              checkedChildren="Açık"
              unCheckedChildren="Kapalı"
            />
          </div>
        </div>
      </div>

      {items.length > 0 ? (
        <Table
          dataSource={items}
          rowKey="id"
          size="small"
          pagination={{ pageSize: 20 }}
          columns={[
            {
              title: 'Seviye', dataIndex: 'severity', width: 90,
              render: (v: number) => {
                const s = SYSLOG_SEVERITY[v] || SYSLOG_SEVERITY[7]
                return <Tag style={{ fontSize: 10, color: s.color, borderColor: s.color + '50', background: s.color + '15' }}>{s.label}</Tag>
              }
            },
            { title: 'Kaynak IP', dataIndex: 'source_ip', width: 130, render: (v: string) => <code style={{ fontSize: 11 }}>{v}</code> },
            { title: 'Mesaj', dataIndex: 'message', ellipsis: true, render: (v: string) => <Text style={{ fontSize: 11 }}>{v}</Text> },
            { title: 'Zaman', dataIndex: 'received_at', width: 120, render: (v: string) => <Text type="secondary" style={{ fontSize: 11 }}>{dayjs(v).fromNow()}</Text> },
          ]}
        />
      ) : (
        <div style={{ textAlign: 'center', padding: '24px 0', color: C.muted, fontSize: 12 }}>
          {enabled ? 'Henüz syslog mesajı alınmadı' : 'Syslog toplayıcıyı etkinleştirin'}
        </div>
      )}
    </div>
  )
}

// ── StreamingTab ──────────────────────────────────────────────────────────────

const STREAM_HISTORY_KEY = (agentId: string) => `nm_stream_history_${agentId}`
const MAX_HISTORY = 20

function StreamingTab({ agent }: { agent: Agent }) {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const { message } = App.useApp()
  const [deviceId, setDeviceId] = useState('')
  const [command, setCommand] = useState('')
  const [output, setOutput] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [cmdHistory, setCmdHistory] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(STREAM_HISTORY_KEY(agent.id)) || '[]') } catch { return [] }
  })

  const saveToHistory = (cmd: string) => {
    const next = [cmd, ...cmdHistory.filter(c => c !== cmd)].slice(0, MAX_HISTORY)
    setCmdHistory(next)
    localStorage.setItem(STREAM_HISTORY_KEY(agent.id), JSON.stringify(next))
  }

  const run = async () => {
    if (!deviceId || !command.trim()) { message.warning('Cihaz ID ve komut giriniz'); return }
    setOutput('')
    setIsRunning(true)
    const cmd = command.trim()
    try {
      const res = await agentsApi.startStreamCommand(agent.id, { device_id: Number(deviceId), command: cmd })
      saveToHistory(cmd)
      const apiBase = (window as any).__VITE_API_URL__ || ''
      const evtSource = new EventSource(`${apiBase}/api/v1/stream/${res.request_id}`)
      evtSource.onmessage = (e) => {
        const data = JSON.parse(e.data)
        if (data.chunk) setOutput(prev => prev + data.chunk)
        if (data.done) {
          evtSource.close()
          setIsRunning(false)
        }
      }
      evtSource.onerror = () => {
        evtSource.close()
        setIsRunning(false)
      }
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'Komut başlatılamadı')
      setIsRunning(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <Input
            value={deviceId}
            onChange={e => setDeviceId(e.target.value)}
            placeholder="Cihaz ID"
            style={{ width: 110 }}
            type="number"
          />
          <AutoComplete
            value={command}
            onChange={setCommand}
            onSelect={setCommand}
            options={cmdHistory.map(c => ({ value: c, label: <Text style={{ fontSize: 11 }}>{c}</Text> }))}
            style={{ flex: 1 }}
            filterOption={(input, opt) => (opt?.value as string)?.toLowerCase().includes(input.toLowerCase())}
          >
            <Input placeholder="show running-config" onPressEnter={run} />
          </AutoComplete>
          <Button type="primary" onClick={run} loading={isRunning} disabled={!agent.status || agent.status !== 'online'}>
            Çalıştır
          </Button>
        </div>
        <Text style={{ fontSize: 11, color: C.muted }}>Uzun çıktılı komutlar için canlı akış modunu kullanın</Text>
      </div>

      {(output || isRunning) && (
        <div style={{
          background: '#0f172a', border: '1px solid #334155', borderRadius: 8,
          padding: 12, maxHeight: 360, overflowY: 'auto', fontFamily: 'monospace',
        }}>
          <pre style={{ margin: 0, fontSize: 11, color: '#e2e8f0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {output || ' '}
            {isRunning && <span style={{ color: '#3b82f6', animation: 'blink 1s infinite' }}>▋</span>}
          </pre>
        </div>
      )}
    </div>
  )
}

// ── SnmpTab ───────────────────────────────────────────────────────────────────

const SNMP_PRESETS = [
  { label: 'sysDescr',    oid: '1.3.6.1.2.1.1.1.0' },
  { label: 'sysUpTime',   oid: '1.3.6.1.2.1.1.3.0' },
  { label: 'sysName',     oid: '1.3.6.1.2.1.1.5.0' },
  { label: 'sysLocation', oid: '1.3.6.1.2.1.1.6.0' },
  { label: 'ifTable',     oid: '1.3.6.1.2.1.2.2' },
  { label: 'ifOperStatus',oid: '1.3.6.1.2.1.2.2.1.8' },
  { label: 'ifInOctets',  oid: '1.3.6.1.2.1.2.2.1.10' },
  { label: 'ifOutOctets', oid: '1.3.6.1.2.1.2.2.1.16' },
]

function SnmpTab({ agent }: { agent: Agent }) {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const { message } = App.useApp()
  const [mode, setMode] = useState<'get' | 'walk'>('get')
  const [deviceId, setDeviceId] = useState('')
  const [oids, setOids] = useState('1.3.6.1.2.1.1.1.0,1.3.6.1.2.1.1.5.0,1.3.6.1.2.1.1.3.0')
  const [oidPrefix, setOidPrefix] = useState('1.3.6.1.2.1.1')
  const [isRunning, setIsRunning] = useState(false)
  const [getResult, setGetResult] = useState<SnmpGetResult | null>(null)
  const [walkResult, setWalkResult] = useState<SnmpWalkResult | null>(null)
  const isOnline = agent.status === 'online'

  const applyPreset = (oid: string) => {
    if (mode === 'get') {
      setOids(prev => prev ? `${prev},${oid}` : oid)
    } else {
      setOidPrefix(oid)
    }
  }

  const run = async () => {
    if (!deviceId) { message.warning('Cihaz ID giriniz'); return }
    setIsRunning(true)
    setGetResult(null)
    setWalkResult(null)
    try {
      if (mode === 'get') {
        const oidList = oids.split(',').map(o => o.trim()).filter(Boolean)
        if (!oidList.length) { message.warning('En az bir OID giriniz'); setIsRunning(false); return }
        const res = await agentsApi.snmpGet(agent.id, { device_id: Number(deviceId), oids: oidList })
        setGetResult(res)
        if (!res.success) message.error(`SNMP GET başarısız: ${res.error || 'Bilinmeyen hata'}`)
      } else {
        if (!oidPrefix.trim()) { message.warning('OID prefix giriniz'); setIsRunning(false); return }
        const res = await agentsApi.snmpWalk(agent.id, { device_id: Number(deviceId), oid_prefix: oidPrefix.trim() })
        setWalkResult(res)
        if (!res.success) message.error(`SNMP WALK başarısız: ${res.error || 'Bilinmeyen hata'}`)
      }
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'SNMP sorgusu başarısız')
    } finally {
      setIsRunning(false)
    }
  }

  const getRows = getResult?.results
    ? Object.entries(getResult.results).map(([oid, value], i) => ({ key: i, oid, value: String(value ?? '') }))
    : []

  const walkRows = (walkResult?.results || []).map((r, i) => ({ key: i, oid: r.oid, value: String(r.value ?? '') }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Select
            value={mode}
            onChange={setMode}
            style={{ width: 100 }}
            size="small"
            options={[{ value: 'get', label: 'GET' }, { value: 'walk', label: 'WALK' }]}
          />
          <Input
            value={deviceId}
            onChange={e => setDeviceId(e.target.value)}
            placeholder="Cihaz ID"
            style={{ width: 100 }}
            type="number"
            size="small"
          />
          {mode === 'get' ? (
            <Input
              value={oids}
              onChange={e => setOids(e.target.value)}
              placeholder="1.3.6.1.2.1.1.1.0,1.3.6.1.2.1.1.5.0"
              style={{ flex: 1 }}
              size="small"
            />
          ) : (
            <Input
              value={oidPrefix}
              onChange={e => setOidPrefix(e.target.value)}
              placeholder="1.3.6.1.2.1.2.2"
              style={{ flex: 1 }}
              size="small"
            />
          )}
          <Button type="primary" size="small" onClick={run} loading={isRunning} disabled={!isOnline}>
            Sorgula
          </Button>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {SNMP_PRESETS.map(p => (
            <Tag
              key={p.oid}
              style={{ cursor: 'pointer', fontSize: 10, userSelect: 'none' }}
              onClick={() => applyPreset(p.oid)}
            >
              {p.label}
            </Tag>
          ))}
        </div>
        {mode === 'get' && (
          <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>Birden fazla OID için virgülle ayırın</div>
        )}
      </div>

      {!isOnline && (
        <div style={{ textAlign: 'center', padding: '16px 0', color: C.muted, fontSize: 12 }}>
          Agent çevrimdışı — SNMP sorgusu yapılamaz
        </div>
      )}

      {getResult?.success && getRows.length > 0 && (
        <Table
          dataSource={getRows}
          rowKey="key"
          size="small"
          pagination={false}
          columns={[
            { title: 'OID', dataIndex: 'oid', width: '40%', render: (v: string) => <code style={{ fontSize: 10 }}>{v}</code> },
            { title: 'Değer', dataIndex: 'value', render: (v: string) => <Text style={{ fontSize: 11 }}>{v}</Text> },
          ]}
        />
      )}

      {walkResult?.success && walkRows.length > 0 && (
        <Table
          dataSource={walkRows}
          rowKey="key"
          size="small"
          pagination={{ pageSize: 20 }}
          columns={[
            { title: 'OID', dataIndex: 'oid', width: '55%', render: (v: string) => <code style={{ fontSize: 10 }}>{v}</code> },
            { title: 'Değer', dataIndex: 'value', render: (v: string) => <Text style={{ fontSize: 11 }}>{v}</Text> },
          ]}
        />
      )}

      {(getResult && !getResult.success) || (walkResult && !walkResult.success) ? (
        <div style={{ background: '#450a0a20', border: '1px solid #ef444430', borderRadius: 8, padding: 10, fontSize: 12, color: '#f87171' }}>
          {getResult?.error || walkResult?.error || 'SNMP sorgusu başarısız'}
        </div>
      ) : null}
    </div>
  )
}

// ── VaultTab ──────────────────────────────────────────────────────────────────

function VaultTab({ agent, liveData }: { agent: Agent; liveData: any }) {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const { message } = App.useApp()
  const isOnline = agent.status === 'online'
  const vaultActive = liveData?.vault_active || false
  const credCount = liveData?.vault_credential_count || 0

  const refreshMutation = useMutation({
    mutationFn: () => agentsApi.refreshVault(agent.id),
    onSuccess: (data) => {
      message.success(`Vault güncellendi — ${data.credential_count} credential${data.encrypted ? ' (AES-256 şifreli)' : ''}`)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Vault güncelleme başarısız'),
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 4 }}>
              Credential Vault
            </div>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
              SSH şifreleri backend'den her komutta gönderilmek yerine agent'ta AES-256-GCM ile şifreli tutulur.
              Bağlantı kesildiğinde hafızadan silinir.
            </div>
          </div>
          <Tag
            style={{
              fontSize: 11, padding: '2px 10px', flexShrink: 0,
              color: vaultActive ? '#22c55e' : C.muted,
              borderColor: vaultActive ? '#22c55e50' : C.border,
              background: vaultActive ? '#22c55e15' : 'transparent',
            }}
          >
            {vaultActive ? `Aktif (${credCount})` : 'Pasif'}
          </Tag>
        </div>
      </div>

      {!vaultActive && isOnline && (
        <Alert type="info" showIcon
          message="Agent v1.3+ bağlandığında vault otomatik yüklenir"
          description="vault_support=True ile bağlanan agent'lar credential'ları otomatik alır." />
      )}

      {!isOnline && (
        <Alert type="warning" showIcon
          message="Agent çevrimdışı"
          description="Vault, agent yeniden bağlandığında otomatik yenilenir." />
      )}

      <Button
        type="primary"
        onClick={() => refreshMutation.mutate()}
        loading={refreshMutation.isPending}
        disabled={!isOnline}
        icon={<ReloadOutlined />}
      >
        Vault'u Yenile
      </Button>

      <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
        <strong>Güvenlik notu:</strong> AES key her yenilemede değişir. Key yalnızca TLS WS üzerinden aktarılır ve disk'e yazılmaz.
        Agent hafızasında plaintext olarak tutulur — agent process'ini koruyun.
      </div>
    </div>
  )
}

// ── AgentDetailModal ──────────────────────────────────────────────────────────

export default function AgentDetailModal({ agent, onClose, initialTab }: { agent: Agent; onClose: () => void; initialTab?: string }) {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  const isOnline = agent.status === 'online'
  const isLocked = agent.failed_auth_count >= 10

  const { data: liveData, isLoading: liveLoading } = useQuery({
    queryKey: ['agent-live-metrics', agent.id],
    queryFn: () => agentsApi.getLiveMetrics(agent.id),
    refetchInterval: isOnline ? 15000 : false,
    enabled: isOnline,
  })

  const restartMutation = useMutation({
    mutationFn: () => agentsApi.restart(agent.id),
    onSuccess: () => {
      message.success('Yeniden başlatma isteği gönderildi.')
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Yeniden başlatma başarısız'),
  })

  const metrics = liveData?.metrics || {}
  const totalCmds = (metrics.cmd_success ?? 0) + (metrics.cmd_fail ?? 0)
  const successRate = totalCmds > 0 ? ((metrics.cmd_success ?? 0) / totalCmds * 100) : null
  const avgLatency = totalCmds > 0 && metrics.cmd_total_ms
    ? Math.round(metrics.cmd_total_ms / totalCmds)
    : null
  const blockedCmds = metrics.cmd_blocked ?? 0

  const statusHex = isOnline ? '#22c55e' : '#ef4444'

  const modeTag: Record<string, { label: string; color: string }> = {
    all: { label: 'Tüm Komutlar', color: '#22c55e' },
    whitelist: { label: 'Whitelist', color: '#3b82f6' },
    blacklist: { label: 'Blacklist', color: '#f59e0b' },
  }
  const modeInfo = modeTag[agent.command_mode] || modeTag.all

  return (
    <Modal
      open onCancel={onClose}
      footer={
        isOnline ? (
          <Popconfirm
            title="Agent'ı yeniden başlat?"
            description="Bu işlem birkaç saniye bağlantı kesintisine neden olacak."
            onConfirm={() => restartMutation.mutate()}
            okText="Yeniden Başlat"
            cancelText="İptal"
            okButtonProps={{ danger: true }}
          >
            <Button danger icon={<PoweroffOutlined />} loading={restartMutation.isPending}>
              Yeniden Başlat
            </Button>
          </Popconfirm>
        ) : null
      }
      title={
        <Space>
          <RobotOutlined style={{ color: '#8b5cf6' }} />
          <span style={{ color: C.text }}>{agent.name}</span>
          {isLocked && <Tag color="red" icon={<LockOutlined />}>Kilitli</Tag>}
        </Space>
      }
      width={960}
      styles={{
        content: { background: C.bg, border: `1px solid ${C.border}` },
        header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
      }}
    >
      <Tabs
        size="small"
        defaultActiveKey={initialTab}
        tabBarStyle={{ flexWrap: 'nowrap', overflowX: 'auto', overflowY: 'hidden', marginBottom: 12 }}
        items={[
          {
            key: 'info',
            label: <Space size={4}><DashboardOutlined />Durum</Space>,
            children: (
              <div>
                <Descriptions column={2} bordered size="small" style={{ marginBottom: 14 }}>
                  <Descriptions.Item label="Durum" span={2}>
                    <Space>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusHex, display: 'inline-block' }} />
                      <span style={{ color: statusHex, fontWeight: 600 }}>{isOnline ? 'Çevrimiçi' : 'Çevrimdışı'}</span>
                      <Tag style={{ fontSize: 10, color: modeInfo.color, borderColor: modeInfo.color + '50', background: modeInfo.color + '15' }}>
                        <SafetyOutlined style={{ marginRight: 3 }} />{modeInfo.label}
                      </Tag>
                    </Space>
                  </Descriptions.Item>
                  <Descriptions.Item label="Agent ID" span={2}>
                    <code style={{ background: isDark ? '#0f172a' : '#f5f5f5', padding: '1px 6px', borderRadius: 3 }}>{agent.id}</code>
                  </Descriptions.Item>
                  <Descriptions.Item label="Platform">
                    {agent.platform
                      ? <Tag style={{ color: agent.platform === 'windows' ? '#3b82f6' : '#f97316', borderColor: (agent.platform === 'windows' ? '#3b82f6' : '#f97316') + '50', background: (agent.platform === 'windows' ? '#3b82f6' : '#f97316') + '18' }}>{agent.platform}</Tag>
                      : '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="Makine">{agent.machine_hostname || '—'}</Descriptions.Item>
                  <Descriptions.Item label="Versiyon">
                    {agent.version ? <Tag style={{ fontSize: 11 }}>v{agent.version}</Tag> : '—'}
                    {metrics.python_version && <Tag style={{ marginLeft: 4, fontSize: 10, color: C.muted }}>Python {metrics.python_version}</Tag>}
                  </Descriptions.Item>
                  <Descriptions.Item label="WAN IP">{agent.last_ip || '—'}</Descriptions.Item>
                  {agent.local_ip && agent.local_ip !== agent.last_ip && (
                    <Descriptions.Item label="LAN IP">
                      <code style={{ fontSize: 12 }}>{agent.local_ip}</code>
                      <Text style={{ fontSize: 11, color: C.muted, marginLeft: 8 }}>(yerel ağ)</Text>
                    </Descriptions.Item>
                  )}
                  <Descriptions.Item label="Son heartbeat">
                    {agent.last_heartbeat ? dayjs(agent.last_heartbeat).fromNow() : '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="Toplam bağlantı">
                    <span style={{ fontWeight: 600 }}>{agent.total_connections}</span>
                  </Descriptions.Item>
                  <Descriptions.Item label="Son bağlanma">
                    {agent.last_connected_at ? dayjs(agent.last_connected_at).format('DD.MM.YY HH:mm') : '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="Son kopma">
                    {agent.last_disconnected_at ? dayjs(agent.last_disconnected_at).format('DD.MM.YY HH:mm') : '—'}
                  </Descriptions.Item>
                </Descriptions>

                {isOnline && (
                  <>
                    {(metrics.cpu_percent !== undefined || metrics.memory_percent !== undefined) && (
                      <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 8 }}>Kaynak Kullanımı</div>
                        {metrics.cpu_percent !== undefined && <MetricBar label="CPU" value={metrics.cpu_percent} color="#3b82f6" />}
                        {metrics.memory_percent !== undefined && (
                          <MetricBar
                            label={`RAM${metrics.memory_used_mb ? ` (${metrics.memory_used_mb}/${metrics.memory_total_mb} MB)` : ''}`}
                            value={metrics.memory_percent}
                            color="#8b5cf6"
                          />
                        )}
                      </div>
                    )}

                    {(totalCmds > 0 || blockedCmds > 0) && (
                      <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 8 }}>Komut İstatistikleri (Bu Oturum)</div>
                        <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                          {[
                            { label: 'Toplam', value: totalCmds, color: C.text },
                            { label: 'Başarı', value: successRate !== null ? `${successRate.toFixed(0)}%` : '—', color: successRate !== null && successRate >= 90 ? '#22c55e' : '#f59e0b' },
                            { label: 'Ort. Gecikme', value: avgLatency !== null ? `${avgLatency}ms` : '—', color: C.text },
                            { label: 'Engellenen', value: blockedCmds, color: blockedCmds > 0 ? '#ef4444' : C.muted },
                          ].map((s) => (
                            <div key={s.label} style={{ flex: 1 }}>
                              <div style={{ color: s.color, fontSize: 18, fontWeight: 700 }}>{s.value}</div>
                              <div style={{ fontSize: 10, color: C.muted }}>{s.label}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
                          <span style={{ color: '#22c55e' }}><CheckCircleOutlined /> {metrics.cmd_success ?? 0} başarılı</span>
                          <span style={{ color: '#ef4444' }}><CloseCircleOutlined /> {metrics.cmd_fail ?? 0} başarısız</span>
                          {blockedCmds > 0 && <span style={{ color: '#f59e0b' }}><WarningOutlined /> {blockedCmds} engellendi</span>}
                        </div>
                      </div>
                    )}

                    {(metrics.pool_size ?? 0) > 0 && (
                      <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 6 }}>SSH Bağlantı Havuzu</div>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                          <div>
                            <span style={{ fontSize: 18, fontWeight: 700, color: '#22c55e' }}>{metrics.pool_size}</span>
                            <div style={{ fontSize: 10, color: C.muted }}>Aktif bağlantı</div>
                          </div>
                          <div style={{ flex: 1 }}>
                            {(Array.isArray(metrics.pool_active_hosts) ? metrics.pool_active_hosts : []).map((h: string) => (
                              <Tag key={h} style={{ fontSize: 10, marginBottom: 2 }}>{h}</Tag>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    {(metrics.queue_size ?? 0) > 0 && (
                      <div style={{ background: '#451a0320', border: '1px solid #f59e0b50', borderRadius: 8, padding: '10px 14px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
                        <WarningOutlined style={{ color: '#f59e0b', fontSize: 16 }} />
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: '#f59e0b' }}>
                            Çevrimdışı Kuyruk: {metrics.queue_size} komut bekliyor
                          </div>
                          <div style={{ fontSize: 11, color: C.muted }}>
                            Agent bağlandığında otomatik gönderilecek
                          </div>
                        </div>
                      </div>
                    )}

                    {!liveLoading && metrics.cpu_percent === undefined && totalCmds === 0 && (
                      <Alert type="info" showIcon style={{ fontSize: 12 }}
                        message="Agent v1.2+ bağlandığında detaylı metrikler görünür."
                        description="psutil kurulu değilse CPU/RAM verileri gösterilmez. pip install psutil ile kurabilirsiniz." />
                    )}
                  </>
                )}
              </div>
            ),
          },
          {
            key: 'security',
            label: (
              <Space size={4}>
                <SafetyOutlined />
                Güvenlik
                {isLocked && <Badge dot status="error" />}
                {!isLocked && agent.failed_auth_count > 0 && <Badge dot status="warning" />}
              </Space>
            ),
            children: <SecurityTab agent={agent} onClose={onClose} />,
          },
          {
            key: 'log',
            label: <Space size={4}><HistoryOutlined />Komut Logu</Space>,
            children: <CommandLogTab agentId={agent.id} />,
          },
          {
            key: 'discovery',
            label: <Space size={4}><SearchOutlined />Keşif</Space>,
            children: <DiscoveryTab agent={agent} />,
          },
          {
            key: 'syslog',
            label: <Space size={4}><WifiOutlined />Syslog</Space>,
            children: <SyslogTab agent={agent} />,
          },
          {
            key: 'stream',
            label: <Space size={4}><ThunderboltOutlined />Akış</Space>,
            children: <StreamingTab agent={agent} />,
          },
          {
            key: 'snmp',
            label: <Space size={4}><DatabaseOutlined />SNMP</Space>,
            children: <SnmpTab agent={agent} />,
          },
          {
            key: 'vault',
            label: <Space size={4}><SafetyCertificateOutlined />Vault</Space>,
            children: <VaultTab agent={agent} liveData={liveData} />,
          },
        ]}
      />
    </Modal>
  )
}

