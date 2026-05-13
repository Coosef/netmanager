import { useState, useMemo } from 'react'
import {
  Tabs, Descriptions, Button, Table, Typography, Space, Tag, Spin, message,
  Modal, Form, Input, InputNumber, Select, Popconfirm, Badge, Progress, Tooltip, Alert,
} from 'antd'
import {
  CopyOutlined, ReloadOutlined, DatabaseOutlined,
  PoweroffOutlined, CheckCircleOutlined, DeleteOutlined, PlusOutlined,
  CodeOutlined, SendOutlined, SaveOutlined, RobotOutlined, DownloadOutlined,
  SwapOutlined, SafetyCertificateOutlined, WarningOutlined,
  ApartmentOutlined, AlertOutlined, HistoryOutlined, ApiOutlined, ScanOutlined,
  ClockCircleOutlined, LineChartOutlined, FireOutlined, CalendarOutlined,
  HeartOutlined, InfoCircleOutlined,
} from '@ant-design/icons'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { devicesApi } from '@/api/devices'
import { agentsApi } from '@/api/agents'
import { topologyApi } from '@/api/topology'
import { snmpApi } from '@/api/snmp'
import { intelligenceApi } from '@/api/intelligence'
import { servicesApi } from '@/api/services'
import type { Device, ConfigBackup, NetworkInterface, Vlan } from '@/types'
import SwitchPortPanel, { type PortUtil } from '@/components/SwitchPortPanel'
import dayjs from 'dayjs'

interface Props {
  device: Device
  onUpdated?: (d: Device) => void
}

// ── Utilization History Chart ────────────────────────────────────────────────
function UtilizationChart({ deviceId, ifIndex, ifName }: { deviceId: number; ifIndex: number | string; ifName: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['snmp-util-history', deviceId, ifIndex],
    queryFn: () => snmpApi.getUtilizationHistory(deviceId, ifIndex, 48),
    staleTime: 60_000,
  })

  if (isLoading) return <Spin size="small" style={{ display: 'block', margin: '12px auto' }} />
  if (!data?.history?.length) {
    return (
      <div style={{ textAlign: 'center', padding: '12px 0', opacity: 0.4, fontSize: 12 }}>
        Geçmiş veri yok — SNMP polling başladıktan sonra görünecek
      </div>
    )
  }

  const chartData = data.history.map((p) => ({
    time: dayjs(p.ts).format('HH:mm'),
    'Giriş %': p.in_pct !== null ? +p.in_pct.toFixed(1) : null,
    'Çıkış %': p.out_pct !== null ? +p.out_pct.toFixed(1) : null,
  }))

  return (
    <div style={{ padding: '8px 16px 4px' }}>
      <Typography.Text style={{ fontSize: 11, opacity: 0.5 }}>
        Son {data.history.length} poll — {ifName} utilization geçmişi
      </Typography.Text>
      <ResponsiveContainer width="100%" height={140}>
        <AreaChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="colorIn" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#38bdf8" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="colorOut" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.1)" />
          <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} unit="%" width={36} />
          <ReTooltip
            contentStyle={{ fontSize: 11 }}
            formatter={(v: unknown) => `${v}%`}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Area type="monotone" dataKey="Giriş %" stroke="#38bdf8" fill="url(#colorIn)" dot={false} strokeWidth={1.5} connectNulls />
          <Area type="monotone" dataKey="Çıkış %" stroke="#f97316" fill="url(#colorOut)" dot={false} strokeWidth={1.5} connectNulls />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function DeviceDetail({ device, onUpdated }: Props) {
  const [activeTab, setActiveTab] = useState('info')

  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: agentsApi.list })
  const [selectedBackup, setSelectedBackup] = useState<ConfigBackup | null>(null)
  const [currentDevice, setCurrentDevice] = useState<Device>(device)
  const [vlanModalOpen, setVlanModalOpen] = useState(false)
  const [assignVlanModal, setAssignVlanModal] = useState<{ iface: NetworkInterface } | null>(null)
  const [vlanForm] = Form.useForm()
  const [assignForm] = Form.useForm()
  const [terminalCmd, setTerminalCmd] = useState('')
  const [terminalHistory, setTerminalHistory] = useState<{ cmd: string; output: string; ok: boolean }[]>([])
  const [pendingConfirm, setPendingConfirm] = useState<{ cmd: string; warning: string } | null>(null)
  const [diffFrom, setDiffFrom] = useState<ConfigBackup | null>(null)
  const [diffTo, setDiffTo] = useState<ConfigBackup | null>(null)
  const [diffModalOpen, setDiffModalOpen] = useState(false)
  const [policyModalOpen, setPolicyModalOpen] = useState(false)
  const [snmpConfigOpen, setSnmpConfigOpen] = useState(false)
  const [snmpForm] = Form.useForm()
  const [snmpVersion, setSnmpVersion] = useState<'v2c' | 'v3'>('v2c')
  const [snmpSkipSsh, setSnmpSkipSsh] = useState(false)
  const [trapConfigOpen, setTrapConfigOpen] = useState(false)
  const [trapForm] = Form.useForm()
  const [ifaceView, setIfaceView] = useState<'visual' | 'table'>('visual')
  const [ifaceRefreshKey, setIfaceRefreshKey] = useState(0)
  const [vlanRefreshKey, setVlanRefreshKey] = useState(0)
  const queryClient = useQueryClient()

  // ── fetch-info ────────────────────────────────────────────────────────────
  const fetchInfoMutation = useMutation({
    mutationFn: () => devicesApi.fetchInfo(currentDevice.id),
    onSuccess: (updated) => {
      setCurrentDevice(updated)
      queryClient.invalidateQueries({ queryKey: ['devices'] })
      message.success('Cihaz bilgileri güncellendi')
      onUpdated?.(updated)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Bilgi alınamadı'),
  })

  // ── configure SNMP ───────────────────────────────────────────────────────
  const configureSnmpMutation = useMutation({
    mutationFn: (payload: Parameters<typeof devicesApi.configureSnmp>[1]) =>
      devicesApi.configureSnmp(currentDevice.id, payload),
    onSuccess: (data, variables) => {
      const msg = variables.skip_ssh
        ? 'SNMP bilgileri kaydedildi'
        : `SNMP yapılandırıldı — ${data.commands_applied.length} komut uygulandı`
      message.success(msg)
      setSnmpConfigOpen(false)
      setSnmpSkipSsh(false)
      snmpForm.resetFields()
      queryClient.invalidateQueries({ queryKey: ['devices'] })
      queryClient.invalidateQueries({ queryKey: ['device', currentDevice.id] })
      // Update all SNMP fields immediately so they render without waiting for refetch
      setCurrentDevice({
        ...currentDevice,
        snmp_enabled: true,
        snmp_version: variables.snmp_version,
        snmp_port: variables.snmp_port ?? currentDevice.snmp_port,
        snmp_community_set: variables.snmp_community != null ? true : currentDevice.snmp_community_set,
        snmp_v3_username: variables.snmp_v3_username ?? currentDevice.snmp_v3_username,
        snmp_v3_auth_protocol: variables.snmp_v3_auth_protocol ?? currentDevice.snmp_v3_auth_protocol,
        snmp_v3_priv_protocol: variables.snmp_v3_priv_protocol ?? currentDevice.snmp_v3_priv_protocol,
      })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'SNMP yapılandırılamadı'),
  })

  // ── configure SNMP Trap Forwarding ───────────────────────────────────────
  const configureTrapMutation = useMutation({
    mutationFn: (payload: Parameters<typeof devicesApi.configureTrapForwarding>[1]) =>
      devicesApi.configureTrapForwarding(currentDevice.id, payload),
    onSuccess: (data) => {
      message.success(
        `Trap yönlendirme yapılandırıldı — cihaz ${data.agent_ip}:${data.port} adresine trap gönderecek`
      )
      setTrapConfigOpen(false)
      trapForm.resetFields()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Trap yapılandırılamadı'),
  })

  // ── live config ───────────────────────────────────────────────────────────
  const { data: config, isLoading: configLoading, refetch: refetchConfig } = useQuery({
    queryKey: ['device-config', currentDevice.id],
    queryFn: () => devicesApi.getConfig(currentDevice.id),
    enabled: activeTab === 'config',
  })

  // ── backups ───────────────────────────────────────────────────────────────
  const { data: backups, isLoading: backupsLoading, refetch: refetchBackups } = useQuery({
    queryKey: ['device-backups', currentDevice.id],
    queryFn: () => devicesApi.getBackups(currentDevice.id),
    enabled: activeTab === 'backups',
  })

  const { data: backupContent, isLoading: backupContentLoading } = useQuery({
    queryKey: ['backup-content', currentDevice.id, selectedBackup?.id],
    queryFn: () => devicesApi.getBackupContent(currentDevice.id, selectedBackup!.id),
    enabled: !!selectedBackup,
  })

  const takeBackupMutation = useMutation({
    mutationFn: () => devicesApi.takeBackup(currentDevice.id),
    onSuccess: () => {
      message.success('Yedek alındı')
      refetchBackups()
      queryClient.invalidateQueries({ queryKey: ['devices'] })
      queryClient.invalidateQueries({ queryKey: ['config-drift', currentDevice.id] })
    },
    onError: (e: any) => {
      const detail = e?.response?.data?.detail || 'Yedek alınamadı'
      if (detail.includes('hasn\'t changed')) message.info('Config değişmemiş, yeni yedek alınmadı')
      else message.error(detail)
    },
  })

  const setGoldenMutation = useMutation({
    mutationFn: (backupId: number) => devicesApi.setGoldenBackup(currentDevice.id, backupId),
    onSuccess: () => {
      message.success('Altın yapılandırma olarak işaretlendi')
      refetchBackups()
      queryClient.invalidateQueries({ queryKey: ['config-drift', currentDevice.id] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'İşaretlenemedi'),
  })

  const { data: driftData } = useQuery({
    queryKey: ['config-drift', currentDevice.id],
    queryFn: () => devicesApi.getConfigDrift(currentDevice.id),
    enabled: activeTab === 'backups',
    staleTime: 60_000,
  })

  // ── interfaces ────────────────────────────────────────────────────────────
  const { data: ifaceData, isLoading: ifaceLoading, isFetching: ifaceFetching } = useQuery({
    queryKey: ['device-interfaces', currentDevice.id, ifaceRefreshKey],
    queryFn: () => devicesApi.getInterfaces(currentDevice.id, ifaceRefreshKey > 0),
    enabled: activeTab === 'interfaces',
    staleTime: 5 * 60 * 1000,
  })

  const toggleIfaceMutation = useMutation({
    mutationFn: ({ name, action }: { name: string; action: 'shutdown' | 'no-shutdown' }) =>
      devicesApi.toggleInterface(currentDevice.id, name, action),
    onSuccess: (res) => {
      if (res.success) { message.success('Port durumu değiştirildi'); setIfaceRefreshKey(k => k + 1) }
      else message.error(res.error || 'İşlem başarısız')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata oluştu'),
  })

  // ── vlans ─────────────────────────────────────────────────────────────────
  const { data: vlanData, isLoading: vlanLoading, isFetching: vlanFetching } = useQuery({
    queryKey: ['device-vlans', currentDevice.id, vlanRefreshKey],
    queryFn: () => devicesApi.getVlans(currentDevice.id, vlanRefreshKey > 0),
    enabled: activeTab === 'vlans',
    staleTime: 5 * 60 * 1000,
  })

  const createVlanMutation = useMutation({
    mutationFn: (vals: { vlan_id: number; name: string }) =>
      devicesApi.createVlan(currentDevice.id, vals.vlan_id, vals.name),
    onSuccess: (res) => {
      if (res.success) { message.success('VLAN oluşturuldu'); setVlanModalOpen(false); vlanForm.resetFields(); setVlanRefreshKey(k => k + 1) }
      else message.error(res.error || 'VLAN oluşturulamadı')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata oluştu'),
  })

  const deleteVlanMutation = useMutation({
    mutationFn: (vlan_id: number) => devicesApi.deleteVlan(currentDevice.id, vlan_id),
    onSuccess: (res) => {
      if (res.success) { message.success('VLAN silindi'); setVlanRefreshKey(k => k + 1) }
      else message.error(res.error || 'VLAN silinemedi')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata oluştu'),
  })

  const assignVlanMutation = useMutation({
    mutationFn: (vals: { vlan_id: number; mode: 'access' | 'trunk' }) =>
      devicesApi.assignVlan(currentDevice.id, assignVlanModal!.iface.name, vals.vlan_id, vals.mode),
    onSuccess: (res) => {
      if (res.success) { message.success('VLAN atandı'); setAssignVlanModal(null); assignForm.resetFields(); setIfaceRefreshKey(k => k + 1) }
      else message.error(res.error || 'VLAN atanamadı')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata oluştu'),
  })

  // ── config diff ───────────────────────────────────────────────────────────
  const diffMutation = useMutation({
    mutationFn: () => devicesApi.getConfigDiff(currentDevice.id, diffFrom!.id, diffTo!.id),
    onSuccess: () => setDiffModalOpen(true),
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Diff alınamadı'),
  })

  // ── security policy ───────────────────────────────────────────────────────
  const checkPolicyMutation = useMutation({
    mutationFn: () => devicesApi.checkConfigPolicy(currentDevice.id),
    onSuccess: () => setPolicyModalOpen(true),
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Politika kontrolü başarısız'),
  })

  // ── terminal ──────────────────────────────────────────────────────────────
  const runCmdMutation = useMutation({
    mutationFn: ({ cmd, confirm }: { cmd: string; confirm?: boolean }) =>
      devicesApi.runCommand(currentDevice.id, cmd, confirm),
    onSuccess: (res, { cmd }) => {
      if (res.needs_confirm) {
        setPendingConfirm({ cmd, warning: res.warning || 'Bu komut yapılandırmayı değiştirir.' })
        return
      }
      if ((res as any).needs_approval) {
        const r = res as any
        setTerminalHistory((h) => [...h, {
          cmd,
          output: `[ONAY GEREKLİ] Talep #${r.request_id} oluşturuldu. Admin onayı bekleniyor.\nRisk: ${r.risk_level?.toUpperCase()}`,
          ok: false,
          approval: true,
        }])
        setTerminalCmd('')
        return
      }
      setTerminalHistory((h) => [...h, { cmd, output: res.output || res.error || '', ok: !!res.success }])
      setTerminalCmd('')
    },
    onError: (e: any, { cmd }) => {
      setTerminalHistory((h) => [...h, { cmd, output: e?.response?.data?.detail || 'Hata', ok: false }])
    },
  })

  const readonlyMutation = useMutation({
    mutationFn: (is_readonly: boolean) => devicesApi.setReadonly(currentDevice.id, is_readonly),
    onSuccess: (updated) => {
      setCurrentDevice(updated)
      queryClient.invalidateQueries({ queryKey: ['devices'] })
      message.success(updated.is_readonly ? 'Salt-okunur mod aktif' : 'Yazma modu aktif')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Değiştirilemedi'),
  })

  const approvalMutation = useMutation({
    mutationFn: (approval_required: boolean) =>
      devicesApi.update(currentDevice.id, { approval_required }),
    onSuccess: (updated) => {
      setCurrentDevice(updated)
      queryClient.invalidateQueries({ queryKey: ['devices'] })
      message.success(updated.approval_required ? 'Onay akışı aktif' : 'Onay akışı devre dışı')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Değiştirilemedi'),
  })

  const submitCmd = (cmd: string, confirm = false) => {
    if (!cmd.trim()) return
    runCmdMutation.mutate({ cmd: cmd.trim(), confirm })
  }

  // ── neighbors ─────────────────────────────────────────────────────────────
  const { data: neighborsData, isLoading: neighborsLoading, refetch: refetchNeighbors } = useQuery({
    queryKey: ['device-neighbors', currentDevice.id],
    queryFn: () => devicesApi.getNeighbors(currentDevice.id),
    enabled: activeTab === 'neighbors',
  })

  const scanNeighborsMutation = useMutation({
    mutationFn: () => topologyApi.discoverSingle(currentDevice.id),
    onSuccess: (res) => {
      message.success(`${res.neighbor_count} komşu tarandı`)
      refetchNeighbors()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Tarama başarısız'),
  })

  // ── syslog (network events) ───────────────────────────────────────────────
  const { data: eventsData, isLoading: eventsLoading, refetch: refetchEvents } = useQuery({
    queryKey: ['device-events', currentDevice.id],
    queryFn: () => devicesApi.getEvents(currentDevice.id),
    enabled: activeTab === 'syslog',
  })

  // ── activity (audit log) ──────────────────────────────────────────────────
  const { data: activityData, isLoading: activityLoading, refetch: refetchActivity } = useQuery({
    queryKey: ['device-activity', currentDevice.id],
    queryFn: () => devicesApi.getActivity(currentDevice.id),
    enabled: activeTab === 'activity',
  })

  // ── SNMP health + interfaces ──────────────────────────────────────────────
  const { data: snmpHealth, isLoading: snmpHealthLoading, refetch: refetchSnmpHealth } = useQuery({
    queryKey: ['snmp-health', currentDevice.id],
    queryFn: () => snmpApi.getHealth(currentDevice.id),
    enabled: activeTab === 'health' && currentDevice.snmp_enabled,
    retry: false,
  })
  const { data: snmpIfaces, isLoading: snmpIfacesLoading, refetch: refetchSnmpIfaces } = useQuery({
    queryKey: ['snmp-interfaces', currentDevice.id],
    queryFn: () => snmpApi.getInterfaces(currentDevice.id),
    enabled: (activeTab === 'health' || activeTab === 'interfaces') && currentDevice.snmp_enabled,
    retry: false,
    staleTime: 120_000,
  })

  const snmpUtilMap = useMemo(() => {
    const m: Record<string, PortUtil> = {}
    if (!snmpIfaces?.interfaces) return m
    for (const iface of snmpIfaces.interfaces as any[]) {
      const in_pct: number = iface.in_utilization_pct ?? 0
      const out_pct: number = iface.out_utilization_pct ?? 0
      if (in_pct > 0 || out_pct > 0) {
        const key = (iface.name as string).toLowerCase().replace(/\s+/g, '')
        m[key] = { in_pct, out_pct, max_pct: Math.max(in_pct, out_pct) }
      }
    }
    return m
  }, [snmpIfaces])
  const { data: snmpCpuRam, isLoading: snmpCpuRamLoading, refetch: refetchSnmpCpuRam } = useQuery({
    queryKey: ['snmp-cpu-ram', currentDevice.id],
    queryFn: () => snmpApi.getCpuRam(currentDevice.id),
    enabled: activeTab === 'health' && currentDevice.snmp_enabled,
    retry: false,
  })

  // ── Intelligence: Risk + MTTR/MTBF + Timeline ────────────────────────────
  const { data: riskData } = useQuery({
    queryKey: ['device-risk', currentDevice.id],
    queryFn: () => intelligenceApi.getDeviceRisk(currentDevice.id),
    enabled: activeTab === 'intelligence',
    staleTime: 300_000,
  })
  const { data: mttrData } = useQuery({
    queryKey: ['device-mttr', currentDevice.id],
    queryFn: () => intelligenceApi.getMttrMtbf(currentDevice.id, 30),
    enabled: activeTab === 'intelligence',
    staleTime: 300_000,
  })
  const { data: timelineData, isLoading: timelineLoading } = useQuery({
    queryKey: ['device-timeline', currentDevice.id],
    queryFn: () => intelligenceApi.getTimeline(currentDevice.id, 30),
    enabled: activeTab === 'timeline',
    staleTime: 60_000,
  })
  const { data: availabilityData, isLoading: availLoading } = useQuery({
    queryKey: ['device-availability', currentDevice.id],
    queryFn: () => devicesApi.getAvailability(currentDevice.id, 30),
    enabled: activeTab === 'availability',
    staleTime: 300_000,
    refetchInterval: activeTab === 'availability' ? 300_000 : false,
  })
  const { data: allServices } = useQuery({
    queryKey: ['services'],
    queryFn: servicesApi.list,
    staleTime: 300_000,
  })
  const deviceServices = (allServices?.items || []).filter(s =>
    (s.device_ids || []).includes(currentDevice.id)
  )

  // ── ssh test quick action ─────────────────────────────────────────────────
  const sshTestMutation = useMutation({
    mutationFn: () => devicesApi.testConnection(currentDevice.id),
    onSuccess: (res) => {
      if (res.success) message.success(`SSH bağlantısı başarılı — ${res.latency_ms?.toFixed(0) ?? '?'}ms`)
      else message.error(`SSH bağlantısı başarısız: ${res.message}`)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'SSH testi başarısız'),
  })

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    message.success('Kopyalandı')
  }

  const statusColor = (s: string) => {
    if (s === 'connected' || s === 'up') return 'green'
    if (s === 'disabled' || s === 'err-disabled') return 'red'
    return 'orange'
  }

  // ── interface columns ─────────────────────────────────────────────────────
  const ifaceColumns = [
    { title: 'Port', dataIndex: 'name', width: 140 },
    {
      title: 'Durum', dataIndex: 'status', width: 120,
      render: (v: string) => <Badge color={statusColor(v)} text={v} />,
    },
    { title: 'VLAN', dataIndex: 'vlan', width: 70 },
    { title: 'Hız', dataIndex: 'speed', width: 80 },
    { title: 'Duplex', dataIndex: 'duplex', width: 80 },
    { title: 'Açıklama', dataIndex: 'description', ellipsis: true },
    {
      title: 'İşlemler', key: 'actions', width: 180,
      render: (_: unknown, row: NetworkInterface) => {
        const isDown = row.status === 'disabled' || row.status === 'notconnect'
        return (
          <Space size="small">
            <Popconfirm
              title={isDown ? 'Port açılsın mı?' : 'Port kapatılsın mı?'}
              onConfirm={() => toggleIfaceMutation.mutate({ name: row.name, action: isDown ? 'no-shutdown' : 'shutdown' })}
            >
              <Button size="small" icon={isDown ? <CheckCircleOutlined /> : <PoweroffOutlined />}
                danger={!isDown} loading={toggleIfaceMutation.isPending}>
                {isDown ? 'Aç' : 'Kapat'}
              </Button>
            </Popconfirm>
            <Button size="small" onClick={() => { setAssignVlanModal({ iface: row }); assignForm.resetFields() }}>
              VLAN Ata
            </Button>
          </Space>
        )
      },
    },
  ]

  // ── vlan columns ──────────────────────────────────────────────────────────
  const vlanColumns = [
    { title: 'ID', dataIndex: 'id', width: 80 },
    { title: 'Ad', dataIndex: 'name' },
    {
      title: 'Durum', dataIndex: 'status', width: 100,
      render: (v: string) => <Tag color={v === 'active' ? 'green' : 'orange'}>{v}</Tag>,
    },
    {
      title: 'Portlar', dataIndex: 'ports',
      render: (ports: string[]) => ports.length > 0
        ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{ports.join(', ')}</Typography.Text>
        : '—',
    },
    {
      title: '', key: 'del', width: 60,
      render: (_: unknown, row: Vlan) => row.id === 1 ? null : (
        <Popconfirm title={`VLAN ${row.id} silinsin mi?`} onConfirm={() => deleteVlanMutation.mutate(row.id)}>
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ]

  return (
    <>
      <Tabs activeKey={activeTab} onChange={setActiveTab}>

        {/* ── Bilgiler ─────────────────────────────────────────────────────── */}
        <Tabs.TabPane tab="Bilgiler" key="info">
          <Space style={{ marginBottom: 12 }} wrap>
            <Button icon={<DatabaseOutlined />} loading={fetchInfoMutation.isPending}
              onClick={() => fetchInfoMutation.mutate()}>
              SSH'tan Bilgileri Çek
            </Button>
            <Button
              icon={<ApiOutlined />}
              loading={sshTestMutation.isPending}
              onClick={() => sshTestMutation.mutate()}
            >
              SSH Test Et
            </Button>
            <Button
              icon={<ScanOutlined />}
              loading={scanNeighborsMutation.isPending}
              onClick={() => { scanNeighborsMutation.mutate(); setActiveTab('neighbors') }}
            >
              Komşuları Tara
            </Button>
          </Space>
          <Descriptions column={2} bordered size="small">
            <Descriptions.Item label="Hostname">{currentDevice.hostname}</Descriptions.Item>
            <Descriptions.Item label="IP Adresi">{currentDevice.ip_address}</Descriptions.Item>
            <Descriptions.Item label="Vendor">
              <Tag color="blue" style={{ textTransform: 'capitalize' }}>{currentDevice.vendor}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="OS Tipi">{currentDevice.os_type}</Descriptions.Item>
            <Descriptions.Item label="Model">{currentDevice.model || '—'}</Descriptions.Item>
            <Descriptions.Item label="Seri No">{currentDevice.serial_number || '—'}</Descriptions.Item>
            <Descriptions.Item label="Firmware">{currentDevice.firmware_version || '—'}</Descriptions.Item>
            <Descriptions.Item label="Konum">{currentDevice.location || '—'}</Descriptions.Item>
            <Descriptions.Item label="SSH Port">{currentDevice.ssh_port}</Descriptions.Item>
            <Descriptions.Item label="Proxy Agent">
              {(() => {
                if (!currentDevice.agent_id) return <Tag color="default">Direkt SSH</Tag>
                const ag = agents.find(a => a.id === currentDevice.agent_id)
                return ag
                  ? <Space size={4}><RobotOutlined /><span>{ag.name}</span><Tag color={ag.status === 'online' ? 'success' : 'error'}>{ag.status}</Tag></Space>
                  : <Tag color="warning">Agent bulunamadı ({currentDevice.agent_id})</Tag>
              })()}
            </Descriptions.Item>
            <Descriptions.Item label="Durum">
              <Tag color={currentDevice.status === 'online' ? 'green' : 'red'}>{currentDevice.status}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Son Görülme">
              {currentDevice.last_seen ? dayjs(currentDevice.last_seen).format('DD.MM.YYYY HH:mm') : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Son Yedek">
              {currentDevice.last_backup ? dayjs(currentDevice.last_backup).format('DD.MM.YYYY HH:mm') : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Etiketler" span={2}>
              {currentDevice.tags?.split(',').map((t) => <Tag key={t}>{t.trim()}</Tag>) || '—'}
            </Descriptions.Item>
          </Descriptions>
        </Tabs.TabPane>

        {/* ── Portlar ──────────────────────────────────────────────────────── */}
        <Tabs.TabPane tab="Portlar" key="interfaces">
          <Space style={{ marginBottom: 12 }} wrap>
            <Button
              icon={<ReloadOutlined spin={ifaceFetching} />}
              loading={ifaceFetching}
              onClick={() => setIfaceRefreshKey(k => k + 1)}
            >Yenile</Button>
            {ifaceData?.fetched_at && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Son güncelleme: {Math.round((Date.now() / 1000 - ifaceData.fetched_at) / 60)} dk önce
                {ifaceData.cached && <Tag color="blue" style={{ marginLeft: 6, fontSize: 11 }}>Önbellekten</Tag>}
              </Typography.Text>
            )}
            <Button
              type={ifaceView === 'visual' ? 'primary' : 'default'}
              size="small"
              onClick={() => setIfaceView('visual')}
            >
              Görsel Panel
            </Button>
            <Button
              type={ifaceView === 'table' ? 'primary' : 'default'}
              size="small"
              onClick={() => setIfaceView('table')}
            >
              Tablo
            </Button>
          </Space>

          {ifaceLoading ? <Spin /> : !ifaceData?.success ? (
            <Typography.Text type="danger">{ifaceData?.error || 'Portlar alınamadı'}</Typography.Text>
          ) : ifaceView === 'visual' ? (
            <SwitchPortPanel
              ports={ifaceData.interfaces}
              isPending={toggleIfaceMutation.isPending}
              deviceModel={currentDevice.model ?? undefined}
              deviceVendor={currentDevice.vendor}
              snmpUtil={Object.keys(snmpUtilMap).length > 0 ? snmpUtilMap : undefined}
              onTogglePort={(name, action) => toggleIfaceMutation.mutate({ name, action })}
              onAssignVlan={(iface) => { setAssignVlanModal({ iface }); assignForm.resetFields() }}
            />
          ) : (
            <Table<NetworkInterface> dataSource={ifaceData.interfaces} rowKey="name" columns={ifaceColumns}
              size="small" pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 800 }} />
          )}
        </Tabs.TabPane>

        {/* ── VLAN ─────────────────────────────────────────────────────────── */}
        <Tabs.TabPane tab="VLAN" key="vlans">
          <Space style={{ marginBottom: 8 }} wrap>
            <Button
              icon={<ReloadOutlined spin={vlanFetching} />}
              loading={vlanFetching}
              onClick={() => setVlanRefreshKey(k => k + 1)}
            >Yenile</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setVlanModalOpen(true)}>VLAN Ekle</Button>
            {vlanData?.fetched_at && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Son güncelleme: {Math.round((Date.now() / 1000 - vlanData.fetched_at) / 60)} dk önce
                {vlanData.cached && <Tag color="blue" style={{ marginLeft: 6, fontSize: 11 }}>Önbellekten</Tag>}
              </Typography.Text>
            )}
          </Space>
          {vlanLoading ? <Spin /> : !vlanData?.success ? (
            <Typography.Text type="danger">{vlanData?.error || 'VLAN listesi alınamadı'}</Typography.Text>
          ) : (
            <Table<Vlan> dataSource={vlanData.vlans} rowKey="id" columns={vlanColumns}
              size="small" pagination={{ pageSize: 20, showSizeChanger: false }} />
          )}
        </Tabs.TabPane>

        {/* ── SSH Terminal ─────────────────────────────────────────────────── */}
        <Tabs.TabPane tab={<span><CodeOutlined /> Terminal</span>} key="terminal">
          <Space style={{ marginBottom: 8, width: '100%', justifyContent: 'space-between' }} align="center">
            <Space.Compact style={{ flex: 1 }}>
              <Input
                placeholder={currentDevice.is_readonly
                  ? 'show komut girin... (salt-okunur mod)'
                  : 'komut girin... (yazma modu aktif)'}
                value={terminalCmd}
                onChange={(e) => setTerminalCmd(e.target.value)}
                onPressEnter={() => submitCmd(terminalCmd)}
                prefix={<span style={{ color: '#888', fontFamily: 'monospace' }}>#</span>}
              />
              <Button type="primary" icon={<SendOutlined />} loading={runCmdMutation.isPending}
                onClick={() => submitCmd(terminalCmd)}>
                Çalıştır
              </Button>
              {terminalHistory.length > 0 && (
                <Button onClick={() => setTerminalHistory([])}>Temizle</Button>
              )}
            </Space.Compact>
            <Tooltip title={currentDevice.is_readonly
              ? 'Salt-okunur: sadece show/ping komutları. Tıkla → yazma moduna geç.'
              : 'Yazma modu: config komutları aktif. Tıkla → salt-okunura dön.'}>
              <Button
                size="small"
                icon={currentDevice.is_readonly ? <SafetyCertificateOutlined /> : <WarningOutlined />}
                loading={readonlyMutation.isPending}
                onClick={() => readonlyMutation.mutate(!currentDevice.is_readonly)}
                style={{
                  color: currentDevice.is_readonly ? '#52c41a' : '#faad14',
                  borderColor: currentDevice.is_readonly ? '#52c41a' : '#faad14',
                }}
              >
                {currentDevice.is_readonly ? 'Salt-okunur' : 'Yazma Modu'}
              </Button>
            </Tooltip>
            <Tooltip title={currentDevice.approval_required
              ? 'Onay akışı: config komutları admin onayına gider. Tıkla → devre dışı bırak.'
              : 'Onay akışı devre dışı. Tıkla → config komutlarını admin onayına gönder.'}>
              <Button
                size="small"
                icon={<SafetyCertificateOutlined />}
                loading={approvalMutation.isPending}
                onClick={() => approvalMutation.mutate(!currentDevice.approval_required)}
                style={{
                  color: currentDevice.approval_required ? '#3b82f6' : '#94a3b8',
                  borderColor: currentDevice.approval_required ? '#3b82f6' : '#94a3b8',
                }}
              >
                {currentDevice.approval_required ? '4-Göz' : 'Serbest'}
              </Button>
            </Tooltip>
          </Space>
          <div style={{ background: '#1e1e1e', borderRadius: 6, padding: 12, minHeight: 200, maxHeight: 450, overflow: 'auto', fontFamily: 'monospace', fontSize: 12 }}>
            {terminalHistory.length === 0 ? (
              <span style={{ color: '#666' }}>Komut girin ve Enter'a basın...</span>
            ) : (
              terminalHistory.map((entry, idx) => (
                <div key={idx} style={{ marginBottom: 12 }}>
                  <div style={{ color: '#4ec9b0' }}># {entry.cmd}</div>
                  <pre style={{
                    color: (entry as any).approval ? '#f59e0b' : entry.ok ? '#d4d4d4' : '#f48771',
                    margin: 0, whiteSpace: 'pre-wrap',
                  }}>
                    {entry.output}
                  </pre>
                </div>
              ))
            )}
          </div>
          {/* Confirm modal for warn-level commands */}
          <Modal
            title={<Space><WarningOutlined style={{ color: '#faad14' }} /> Komut Onayı</Space>}
            open={!!pendingConfirm}
            onOk={() => {
              if (pendingConfirm) {
                submitCmd(pendingConfirm.cmd, true)
                setPendingConfirm(null)
              }
            }}
            onCancel={() => setPendingConfirm(null)}
            okText="Evet, Çalıştır"
            cancelText="İptal"
            okButtonProps={{ danger: true }}
          >
            <p>{pendingConfirm?.warning}</p>
            <p>Komut: <code style={{ background: '#1e1e1e', color: '#4ec9b0', padding: '2px 6px', borderRadius: 4 }}>{pendingConfirm?.cmd}</code></p>
          </Modal>
        </Tabs.TabPane>

        {/* ── Canlı Config ─────────────────────────────────────────────────── */}
        <Tabs.TabPane tab="Canlı Config" key="config">
          <Space style={{ marginBottom: 8 }}>
            <Button icon={<ReloadOutlined />} onClick={() => refetchConfig()}>Yenile</Button>
            {config?.config && (
              <Button icon={<CopyOutlined />} onClick={() => copyToClipboard(config.config)}>Kopyala</Button>
            )}
            <Button
              icon={<SafetyCertificateOutlined />}
              loading={checkPolicyMutation.isPending}
              onClick={() => checkPolicyMutation.mutate()}
            >
              Güvenlik Tarama
            </Button>
          </Space>
          {configLoading ? <Spin /> : config?.success ? (
            <pre style={{ background: '#1e1e1e', color: '#d4d4d4', padding: 16, borderRadius: 6, overflow: 'auto', maxHeight: 400, fontSize: 12 }}>
              {config.config}
            </pre>
          ) : (
            <Typography.Text type="danger">{config?.error || 'Config alınamadı'}</Typography.Text>
          )}
        </Tabs.TabPane>

        {/* ── Komşular ─────────────────────────────────────────────────────── */}
        <Tabs.TabPane tab={<span><ApartmentOutlined /> Komşular</span>} key="neighbors">
          <Space style={{ marginBottom: 8 }}>
            <Button icon={<ReloadOutlined />} onClick={() => refetchNeighbors()}>Yenile</Button>
            <Button
              type="primary"
              icon={<ScanOutlined />}
              loading={scanNeighborsMutation.isPending}
              onClick={() => scanNeighborsMutation.mutate()}
            >
              LLDP/CDP Tara
            </Button>
          </Space>
          {neighborsLoading ? <Spin /> : (
            <Table
              dataSource={neighborsData?.items ?? []}
              rowKey="id"
              size="small"
              pagination={{ pageSize: 20, showSizeChanger: false }}
              columns={[
                { title: 'Yerel Port', dataIndex: 'local_port', width: 140 },
                {
                  title: 'Komşu',
                  dataIndex: 'neighbor_hostname',
                  render: (v: string, row: any) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text strong>{v}</Typography.Text>
                      {row.neighbor_ip && <Typography.Text type="secondary" style={{ fontSize: 11 }}>{row.neighbor_ip}</Typography.Text>}
                    </Space>
                  ),
                },
                { title: 'Komşu Port', dataIndex: 'neighbor_port', width: 140 },
                {
                  title: 'Tür',
                  dataIndex: 'neighbor_type',
                  width: 100,
                  render: (v: string) => v ? <Tag>{v}</Tag> : '—',
                },
                {
                  title: 'Protokol',
                  dataIndex: 'protocol',
                  width: 80,
                  render: (v: string) => <Tag color="blue">{v.toUpperCase()}</Tag>,
                },
                {
                  title: 'Envanterde',
                  dataIndex: 'neighbor_device_id',
                  width: 100,
                  render: (v: number) => v
                    ? <Tag color="green">Evet</Tag>
                    : <Tag color="orange">Hayır</Tag>,
                },
                {
                  title: 'Son Görülme',
                  dataIndex: 'last_seen',
                  width: 140,
                  render: (v: string) => dayjs(v).format('DD.MM.YY HH:mm'),
                },
              ]}
            />
          )}
        </Tabs.TabPane>

        {/* ── Syslog ───────────────────────────────────────────────────────── */}
        <Tabs.TabPane tab={<span><AlertOutlined /> Syslog</span>} key="syslog">
          <Space style={{ marginBottom: 8 }}>
            <Button icon={<ReloadOutlined />} onClick={() => refetchEvents()}>Yenile</Button>
          </Space>
          {eventsLoading ? <Spin /> : (
            <Table
              dataSource={eventsData?.items ?? []}
              rowKey="id"
              size="small"
              pagination={{ pageSize: 20, showSizeChanger: false }}
              columns={[
                {
                  title: 'Seviye',
                  dataIndex: 'severity',
                  width: 90,
                  render: (v: string) => {
                    const color = v === 'critical' ? 'red' : v === 'warning' ? 'orange' : 'blue'
                    return <Tag color={color}>{v}</Tag>
                  },
                },
                {
                  title: 'Olay Tipi',
                  dataIndex: 'event_type',
                  width: 160,
                  render: (v: string) => <Tag>{v.replace(/_/g, ' ')}</Tag>,
                },
                { title: 'Başlık', dataIndex: 'title', ellipsis: true },
                {
                  title: 'Mesaj',
                  dataIndex: 'message',
                  ellipsis: true,
                  render: (v: string) => v || '—',
                },
                {
                  title: 'Onaylandı',
                  dataIndex: 'acknowledged',
                  width: 90,
                  render: (v: boolean) => v ? <Tag color="green">Evet</Tag> : <Tag color="default">Hayır</Tag>,
                },
                {
                  title: 'Tarih',
                  dataIndex: 'created_at',
                  width: 140,
                  render: (v: string) => dayjs(v).format('DD.MM.YY HH:mm'),
                },
              ]}
            />
          )}
        </Tabs.TabPane>

        {/* ── Değişiklik Zaman Çizelgesi ────────────────────────────────────── */}
        <Tabs.TabPane tab={<span><HistoryOutlined /> Değişiklikler</span>} key="activity">
          <Space style={{ marginBottom: 8 }}>
            <Button icon={<ReloadOutlined />} onClick={() => refetchActivity()}>Yenile</Button>
          </Space>
          {activityLoading ? <Spin /> : (
            <Table
              dataSource={activityData?.items ?? []}
              rowKey="id"
              size="small"
              pagination={{ pageSize: 20, showSizeChanger: false }}
              columns={[
                {
                  title: 'İşlem',
                  dataIndex: 'action',
                  width: 200,
                  render: (v: string) => <Tag color="geekblue">{v.replace(/_/g, ' ')}</Tag>,
                },
                { title: 'Kullanıcı', dataIndex: 'username', width: 130 },
                {
                  title: 'Durum',
                  dataIndex: 'status',
                  width: 90,
                  render: (v: string) => <Tag color={v === 'success' ? 'green' : 'red'}>{v}</Tag>,
                },
                {
                  title: 'Detay',
                  dataIndex: 'details',
                  ellipsis: true,
                  render: (v: Record<string, unknown>) => {
                    if (!v) return '—'
                    const cmd = (v as any).command
                    if (cmd) return <Typography.Text code style={{ fontSize: 11 }}>{cmd}</Typography.Text>
                    return <Typography.Text type="secondary" style={{ fontSize: 11 }}>{JSON.stringify(v).substring(0, 80)}</Typography.Text>
                  },
                },
                { title: 'IP', dataIndex: 'client_ip', width: 120, render: (v: string) => v || '—' },
                {
                  title: 'Tarih',
                  dataIndex: 'created_at',
                  width: 140,
                  render: (v: string) => dayjs(v).format('DD.MM.YY HH:mm'),
                },
              ]}
            />
          )}
        </Tabs.TabPane>

        {/* ── Yedekler ─────────────────────────────────────────────────────── */}
        <Tabs.TabPane tab="Yedekler" key="backups">
          <Space style={{ marginBottom: 8 }} wrap>
            <Button type="primary" icon={<SaveOutlined />} loading={takeBackupMutation.isPending}
              onClick={() => takeBackupMutation.mutate()}>
              Yedek Al
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => refetchBackups()}>Yenile</Button>
            <Tooltip title={!diffFrom || !diffTo ? 'Karşılaştırmak için "Başlangıç" ve "Bitiş" seçin' : undefined}>
              <Button
                icon={<SwapOutlined />}
                disabled={!diffFrom || !diffTo}
                loading={diffMutation.isPending}
                onClick={() => diffMutation.mutate()}
              >
                {diffFrom && diffTo
                  ? `Diff: ${dayjs(diffFrom.created_at).format('HH:mm')} → ${dayjs(diffTo.created_at).format('HH:mm')}`
                  : 'Diff Görüntüle'}
              </Button>
            </Tooltip>
            {(diffFrom || diffTo) && (
              <Button size="small" onClick={() => { setDiffFrom(null); setDiffTo(null) }}>Seçimi Temizle</Button>
            )}
          </Space>
          {/* Drift Status Panel */}
          {driftData && driftData.has_golden && (
            <Alert
              style={{ marginBottom: 8 }}
              type={driftData.drift_detected ? 'warning' : 'success'}
              showIcon
              message={
                driftData.drift_detected
                  ? `Config Sapması Tespit Edildi — Altın baseline'dan +${driftData.lines_added} / -${driftData.lines_removed} satır değişmiş`
                  : 'Config değişmemiş — Altın baseline ile eşleşiyor'
              }
              description={
                driftData.drift_detected
                  ? `Altın yedek: ${dayjs(driftData.golden_created_at).format('DD.MM.YYYY HH:mm')} · Son yedek: ${dayjs(driftData.latest_created_at).format('DD.MM.YYYY HH:mm')}`
                  : `Altın yedek: ${dayjs(driftData.golden_created_at).format('DD.MM.YYYY HH:mm')}`
              }
            />
          )}
          <Table<ConfigBackup>
            dataSource={backups || []} rowKey="id" loading={backupsLoading} size="small"
            pagination={{ pageSize: 10, showSizeChanger: false }}
            onRow={(r) => ({ onClick: () => setSelectedBackup(r), style: { cursor: 'pointer' } })}
            rowClassName={(r) => r.id === selectedBackup?.id ? 'ant-table-row-selected' : ''}
            columns={[
              {
                title: 'Tarih', dataIndex: 'created_at',
                render: (v, row: any) => (
                  <Space size={4}>
                    {dayjs(v).format('DD.MM.YYYY HH:mm')}
                    {row.is_golden && <Tag color="gold" style={{ margin: 0, fontSize: 10 }}>⭐ Altın</Tag>}
                  </Space>
                ),
              },
              { title: 'Boyut', dataIndex: 'size_bytes', render: (v) => `${(v / 1024).toFixed(1)} KB` },
              { title: 'Hash', dataIndex: 'config_hash', render: (v) => v.substring(0, 12) + '...' },
              {
                title: 'İşlemler', key: 'actions', width: 220,
                render: (_: unknown, row: ConfigBackup) => (
                  <Space size={4} onClick={(e) => e.stopPropagation()}>
                    <Button
                      size="small"
                      type={diffFrom?.id === row.id ? 'primary' : 'default'}
                      onClick={() => setDiffFrom(diffFrom?.id === row.id ? null : row)}
                    >
                      Başlangıç
                    </Button>
                    <Button
                      size="small"
                      type={diffTo?.id === row.id ? 'primary' : 'default'}
                      onClick={() => setDiffTo(diffTo?.id === row.id ? null : row)}
                    >
                      Bitiş
                    </Button>
                    <Tooltip title="Altın yapılandırma olarak işaretle (drift tespiti için baseline)">
                      <Button
                        size="small"
                        icon={<span>⭐</span>}
                        loading={setGoldenMutation.isPending && (setGoldenMutation.variables as any) === row.id}
                        onClick={() => setGoldenMutation.mutate(row.id)}
                      />
                    </Tooltip>
                  </Space>
                ),
              },
            ]}
          />
          {selectedBackup && (
            <div style={{ marginTop: 16 }}>
              <Space style={{ marginBottom: 8 }}>
                <Typography.Text strong>Yedek İçeriği — {dayjs(selectedBackup.created_at).format('DD.MM.YYYY HH:mm')}</Typography.Text>
                {backupContent?.config && (
                  <Button size="small" icon={<CopyOutlined />} onClick={() => copyToClipboard(backupContent.config)}>Kopyala</Button>
                )}
                <Button size="small" icon={<DownloadOutlined />} onClick={() => devicesApi.downloadBackup(currentDevice.id, selectedBackup.id)}>İndir</Button>
              </Space>
              {backupContentLoading ? <Spin /> : (
                <pre style={{ background: '#1e1e1e', color: '#d4d4d4', padding: 16, borderRadius: 6, overflow: 'auto', maxHeight: 300, fontSize: 12 }}>
                  {backupContent?.config}
                </pre>
              )}
            </div>
          )}
        </Tabs.TabPane>

        {/* ── SNMP Health ──────────────────────────────────────────────────── */}
        <Tabs.TabPane tab={<span><ApiOutlined /> Health</span>} key="health">
          {!currentDevice.snmp_enabled ? (
            <div style={{ padding: '32px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
              <ApiOutlined style={{ fontSize: 48, color: '#94a3b8' }} />
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontWeight: 600, fontSize: 15, color: '#475569', marginBottom: 4 }}>
                  SNMP Yapılandırılmamış
                </div>
                <div style={{ color: '#94a3b8', fontSize: 13, maxWidth: 360 }}>
                  Bu cihaz için SNMP polling aktif değil. Cihaza SSH ile bağlanarak SNMP yapılandırmak için aşağıdaki butonu kullanın.
                </div>
              </div>
              <Space wrap>
                <Button
                  type="primary"
                  icon={<ApiOutlined />}
                  onClick={() => { setSnmpSkipSsh(false); setSnmpConfigOpen(true) }}
                >
                  SNMP Yapılandır (SSH)
                </Button>
                <Button
                  icon={<SaveOutlined />}
                  onClick={() => { setSnmpSkipSsh(true); setSnmpConfigOpen(true) }}
                >
                  Zaten Yapılandırıldı — Bilgileri Kaydet
                </Button>
                <Button
                  icon={<SendOutlined />}
                  onClick={() => {
                    trapForm.setFieldsValue({
                      agent_id: currentDevice.agent_id || (agents.find(a => a.status === 'online')?.id ?? ''),
                      community: currentDevice.snmp_community_set ? 'public' : 'public',
                      version: 'v2c',
                    })
                    setTrapConfigOpen(true)
                  }}
                >
                  Trap Yönlendirmeyi Yapılandır
                </Button>
                <Button
                  icon={<SaveOutlined />}
                  onClick={() => window.open('/config-templates', '_blank')}
                >
                  Hazır Şablonlar
                </Button>
              </Space>
              <div style={{ color: '#cbd5e1', fontSize: 11 }}>
                SSH: cihaza bağlanıp snmp-server komutu ekler • Bilgileri Kaydet: sadece DB'ye yazar (cihaz zaten yapılandırılmışsa)
              </div>
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <Button icon={<ReloadOutlined />} size="small"
                  onClick={() => { refetchSnmpHealth(); refetchSnmpIfaces(); refetchSnmpCpuRam() }}
                  loading={snmpHealthLoading || snmpIfacesLoading || snmpCpuRamLoading}>
                  Yenile
                </Button>
                <Button icon={<ApiOutlined />} size="small"
                  onClick={() => { setSnmpSkipSsh(false); setSnmpConfigOpen(true) }}>
                  SNMP Güncelle
                </Button>
                <Button icon={<SendOutlined />} size="small"
                  onClick={() => {
                    trapForm.setFieldsValue({
                      agent_id: currentDevice.agent_id || (agents.find(a => a.status === 'online')?.id ?? ''),
                      community: 'public',
                      version: 'v2c',
                    })
                    setTrapConfigOpen(true)
                  }}>
                  Trap Yönlendirme
                </Button>
              </div>

              {/* CPU / RAM gauges */}
              {(snmpCpuRamLoading || snmpCpuRam) && (
                <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
                  {(['cpu', 'ram'] as const).map((metric) => {
                    const pct = metric === 'cpu' ? snmpCpuRam?.cpu_pct : snmpCpuRam?.ram_pct
                    const label = metric === 'cpu' ? 'CPU Kullanımı' : 'RAM Kullanımı'
                    const sub = metric === 'ram' && snmpCpuRam?.ram_total_mb
                      ? `${snmpCpuRam.ram_used_mb ?? 0} / ${snmpCpuRam.ram_total_mb} MB`
                      : snmpCpuRam?.source ? `kaynak: ${snmpCpuRam.source}` : undefined
                    const color = pct == null ? '#64748b' : pct >= 80 ? '#ef4444' : pct >= 60 ? '#f59e0b' : '#22c55e'
                    return (
                      <div key={metric} style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                        padding: '14px 20px', borderRadius: 12,
                        border: `1px solid ${color}33`, background: `${color}08`, minWidth: 140,
                      }}>
                        {snmpCpuRamLoading ? <Spin size="small" /> : (
                          <Progress
                            type="circle"
                            percent={pct != null ? Math.round(pct) : 0}
                            size={80}
                            strokeColor={color}
                            format={() => pct != null ? `${pct.toFixed(1)}%` : '—'}
                            strokeWidth={8}
                          />
                        )}
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#1e293b' }}>{label}</div>
                        {sub && <div style={{ fontSize: 10, color: '#64748b' }}>{sub}</div>}
                        {!snmpCpuRamLoading && pct == null && (
                          <div style={{ fontSize: 10, color: '#94a3b8' }}>veri yok</div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* SNMP config summary */}
              <Descriptions size="small" column={2} bordered style={{ marginBottom: 12 }}>
                <Descriptions.Item label="SNMP Versiyon">
                  <Tag color={currentDevice.snmp_version === 'v3' ? 'purple' : 'blue'}>
                    {currentDevice.snmp_version?.toUpperCase()}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="Port">{currentDevice.snmp_port}</Descriptions.Item>
                {currentDevice.snmp_version === 'v3' ? (
                  <>
                    <Descriptions.Item label="v3 Username">{currentDevice.snmp_v3_username ?? '—'}</Descriptions.Item>
                    <Descriptions.Item label="Güvenlik">
                      {currentDevice.snmp_v3_auth_protocol
                        ? (currentDevice.snmp_v3_priv_protocol
                          ? <Tag color="green">authPriv ({currentDevice.snmp_v3_auth_protocol?.toUpperCase()}/{currentDevice.snmp_v3_priv_protocol})</Tag>
                          : <Tag color="orange">authNoPriv ({currentDevice.snmp_v3_auth_protocol?.toUpperCase()})</Tag>)
                        : <Tag>noAuthNoPriv</Tag>}
                    </Descriptions.Item>
                  </>
                ) : (
                  <Descriptions.Item label="Community">
                    <span style={{ fontFamily: 'monospace' }}>{currentDevice.snmp_community_set ? '••••••••' : '—'}</span>
                  </Descriptions.Item>
                )}
              </Descriptions>

              {snmpHealthLoading ? <Spin /> : snmpHealth && (
                <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
                  <Descriptions.Item label="Uptime">{snmpHealth.uptime_human ?? '—'}</Descriptions.Item>
                  <Descriptions.Item label="sysName">{snmpHealth.sys_name ?? '—'}</Descriptions.Item>
                  <Descriptions.Item label="sysDescr" span={2}>
                    <span style={{ fontSize: 11, wordBreak: 'break-word' }}>{snmpHealth.sys_descr ?? '—'}</span>
                  </Descriptions.Item>
                  <Descriptions.Item label="sysLocation" span={2}>{snmpHealth.sys_location ?? '—'}</Descriptions.Item>
                </Descriptions>
              )}
              {snmpIfacesLoading ? <Spin /> : snmpIfaces && (
                <Table
                  dataSource={snmpIfaces.interfaces}
                  rowKey="if_index"
                  size="small"
                  pagination={{ pageSize: 20, size: 'small' }}
                  expandable={{
                    expandedRowRender: (r: any) => (
                      <UtilizationChart
                        deviceId={currentDevice.id}
                        ifIndex={r.if_index}
                        ifName={r.name}
                      />
                    ),
                    rowExpandable: (r: any) => r.oper_up === true,
                  }}
                  columns={[
                    {
                      title: 'Arayüz', dataIndex: 'name', width: 160,
                      render: (v: string, r: any) => (
                        <Tooltip title={r.alias || undefined}>
                          <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{v}</span>
                        </Tooltip>
                      ),
                    },
                    {
                      title: 'Durum', width: 90,
                      render: (_: any, r: any) => (
                        <Tag color={r.oper_up ? 'green' : 'red'} style={{ fontSize: 11 }}>
                          {r.oper_up ? 'UP' : 'DOWN'}
                        </Tag>
                      ),
                    },
                    {
                      title: 'Hız', dataIndex: 'speed_mbps', width: 90,
                      render: (v: number | null) => v ? `${v >= 1000 ? `${v / 1000}G` : `${v}M`}` : '—',
                    },
                    {
                      title: 'In (GB)', dataIndex: 'in_octets', width: 100,
                      render: (v: number | null) => v !== null ? (v / 1e9).toFixed(2) : '—',
                    },
                    {
                      title: 'Out (GB)', dataIndex: 'out_octets', width: 100,
                      render: (v: number | null) => v !== null ? (v / 1e9).toFixed(2) : '—',
                    },
                    {
                      title: 'Kullanım In', width: 130,
                      render: (_: any, r: any) => {
                        const pct = r.in_utilization_pct
                        if (pct === null || pct === undefined) return <span style={{ color: '#64748b', fontSize: 11 }}>—</span>
                        const color = pct >= 80 ? '#ef4444' : pct >= 50 ? '#f59e0b' : '#22c55e'
                        return (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Progress percent={Math.round(pct)} size="small" strokeColor={color}
                              style={{ flex: 1, margin: 0 }} showInfo={false} />
                            <span style={{ fontSize: 11, color, minWidth: 34, textAlign: 'right' }}>{pct.toFixed(1)}%</span>
                          </div>
                        )
                      },
                    },
                    {
                      title: 'Kullanım Out', width: 130,
                      render: (_: any, r: any) => {
                        const pct = r.out_utilization_pct
                        if (pct === null || pct === undefined) return <span style={{ color: '#64748b', fontSize: 11 }}>—</span>
                        const color = pct >= 80 ? '#ef4444' : pct >= 50 ? '#f59e0b' : '#22c55e'
                        return (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Progress percent={Math.round(pct)} size="small" strokeColor={color}
                              style={{ flex: 1, margin: 0 }} showInfo={false} />
                            <span style={{ fontSize: 11, color, minWidth: 34, textAlign: 'right' }}>{pct.toFixed(1)}%</span>
                          </div>
                        )
                      },
                    },
                    {
                      title: 'In Err', dataIndex: 'in_errors', width: 80,
                      render: (v: number | null) => (
                        <span style={{ color: v && v > 0 ? '#ef4444' : undefined }}>{v ?? '—'}</span>
                      ),
                    },
                    {
                      title: 'Out Err', dataIndex: 'out_errors', width: 80,
                      render: (v: number | null) => (
                        <span style={{ color: v && v > 0 ? '#ef4444' : undefined }}>{v ?? '—'}</span>
                      ),
                    },
                  ]}
                />
              )}
            </div>
          )}
        </Tabs.TabPane>

        {/* ── 12A+12B: Risk & MTTR/MTBF ───────────────────────────────────── */}
        <Tabs.TabPane tab={<span><FireOutlined /> Risk & SLA</span>} key="intelligence">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Risk Score */}
            {riskData && (
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  <div style={{
                    width: 60, height: 60, borderRadius: '50%',
                    background: riskData.level === 'critical' ? '#fee2e2' : riskData.level === 'high' ? '#fef3c7' : riskData.level === 'medium' ? '#ffedd5' : '#dcfce7',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    <span style={{
                      fontSize: 20, fontWeight: 800,
                      color: riskData.level === 'critical' ? '#dc2626' : riskData.level === 'high' ? '#d97706' : riskData.level === 'medium' ? '#ea580c' : '#16a34a',
                    }}>{riskData.risk_score}</span>
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>Risk Skoru</div>
                    <Tag color={riskData.level === 'critical' ? 'red' : riskData.level === 'high' ? 'orange' : riskData.level === 'medium' ? 'gold' : 'green'}>
                      {riskData.level === 'critical' ? 'Kritik' : riskData.level === 'high' ? 'Yüksek' : riskData.level === 'medium' ? 'Orta' : 'Düşük'}
                    </Tag>
                  </div>
                </div>
                <Descriptions size="small" column={2} bordered>
                  <Descriptions.Item label="Uyumluluk">
                    {riskData.breakdown.compliance.score !== null
                      ? <><Progress percent={riskData.breakdown.compliance.score} size="small" style={{ maxWidth: 160 }} /><span style={{ color: '#64748b', fontSize: 11 }}> +{riskData.breakdown.compliance.risk_contribution} risk</span></>
                      : <Tag color="orange">Taranmamış</Tag>
                    }
                  </Descriptions.Item>
                  <Descriptions.Item label="Uptime (7g)">
                    <Progress
                      percent={riskData.breakdown.uptime_7d.uptime_pct}
                      size="small"
                      strokeColor={riskData.breakdown.uptime_7d.uptime_pct >= 99 ? '#22c55e' : riskData.breakdown.uptime_7d.uptime_pct >= 95 ? '#f59e0b' : '#ef4444'}
                      style={{ maxWidth: 160 }}
                    />
                    <span style={{ color: '#64748b', fontSize: 11 }}> +{riskData.breakdown.uptime_7d.risk_contribution} risk</span>
                  </Descriptions.Item>
                  <Descriptions.Item label="Flapping (7g)">
                    {riskData.breakdown.flapping_7d.flap_count > 0
                      ? <Tag color="purple">{riskData.breakdown.flapping_7d.flap_count}× flap</Tag>
                      : <Tag color="green">Yok</Tag>
                    }
                  </Descriptions.Item>
                  <Descriptions.Item label="Son Yedek">
                    {riskData.breakdown.backup.last_backup
                      ? dayjs(riskData.breakdown.backup.last_backup).fromNow()
                      : <Tag color="red">Hiç alınmamış</Tag>
                    }
                  </Descriptions.Item>
                </Descriptions>
              </div>
            )}

            {/* MTTR / MTBF */}
            {mttrData && (
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 16 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <LineChartOutlined /> Arıza İstatistikleri — Son 30 Gün
                </div>
                {mttrData.currently_offline && (
                  <Alert type="warning" showIcon message="Cihaz şu an çevrimdışı" style={{ marginBottom: 8 }} />
                )}
                <Descriptions size="small" column={2} bordered>
                  <Descriptions.Item label="Toplam Arıza Sayısı">
                    <span style={{ fontWeight: 700, color: mttrData.failure_count > 0 ? '#ef4444' : '#22c55e' }}>
                      {mttrData.failure_count}
                    </span>
                  </Descriptions.Item>
                  <Descriptions.Item label="MTTR (Ort. Kurtarma)">
                    {mttrData.mttr_human
                      ? <><ClockCircleOutlined style={{ color: '#f59e0b' }} /> <strong>{mttrData.mttr_human}</strong></>
                      : <span style={{ color: '#94a3b8' }}>Veri yok</span>
                    }
                  </Descriptions.Item>
                  <Descriptions.Item label="MTBF (Ort. Çalışma)">
                    {mttrData.mtbf_human
                      ? <><CalendarOutlined style={{ color: '#22c55e' }} /> <strong>{mttrData.mtbf_human}</strong></>
                      : <span style={{ color: '#94a3b8' }}>Veri yok</span>
                    }
                  </Descriptions.Item>
                  <Descriptions.Item label="Pencere">
                    {mttrData.window_days} gün
                  </Descriptions.Item>
                </Descriptions>
              </div>
            )}

            {/* Service badges */}
            {deviceServices.length > 0 && (
              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: 14 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#15803d', marginBottom: 8 }}>
                  Bu Cihazın Dahil Olduğu Servisler
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {deviceServices.map(svc => {
                    const pc: Record<string, string> = { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e' }
                    const c = pc[svc.priority] || '#3b82f6'
                    return (
                      <Tag key={svc.id} style={{ color: c, borderColor: c + '40', background: c + '15', fontSize: 12, padding: '2px 8px' }}>
                        {svc.name}
                        {svc.priority === 'critical' && ' ⚠'}
                      </Tag>
                    )
                  })}
                </div>
              </div>
            )}

            {!riskData && !mttrData && (
              <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
                <FireOutlined style={{ fontSize: 32 }} />
                <div style={{ marginTop: 8 }}>Veri yükleniyor...</div>
              </div>
            )}
          </div>
        </Tabs.TabPane>

        {/* ── 12C: Zaman Çizelgesi ────────────────────────────────────────── */}
        {/* ── Availability ──────────────────────────────────────────────────── */}
        <Tabs.TabPane tab={<span><HeartOutlined /> Availability</span>} key="availability">
          {availLoading ? (
            <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>
          ) : !availabilityData ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>
              <InfoCircleOutlined style={{ fontSize: 28, marginBottom: 8, display: 'block' }} />
              Henüz veri yok — availability skoru günlük hesaplanır.
            </div>
          ) : (() => {
            const cur = availabilityData.current
            const history = availabilityData.history ?? []
            const chartData = history.map(p => ({
              date: dayjs(p.ts).format('DD/MM'),
              'Exp. Score': +(p.experience_score * 100).toFixed(1),
              'Avail. 7d': +(p.availability_7d * 100).toFixed(1),
            }))
            const fmtPct = (v: number | null | undefined) =>
              v != null ? `${(v * 100).toFixed(1)}%` : '—'
            const fmtHours = (v: number | null | undefined) =>
              v != null ? `${v.toFixed(1)} saat` : null

            return (
              <div style={{ padding: '8px 0' }}>
                {/* 4 stat boxes */}
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
                  {[
                    { label: '24h Uptime',     value: fmtPct(cur.availability_24h),  color: '#22c55e' },
                    { label: '7d Uptime',      value: fmtPct(cur.availability_7d),   color: '#3b82f6' },
                    { label: 'MTBF',           value: fmtHours(cur.mtbf_hours) ?? 'Yeterli veri yok', color: cur.mtbf_hours ? '#f97316' : '#888' },
                    { label: 'Exp. Score',     value: fmtPct(cur.experience_score),  color: '#a855f7' },
                  ].map(card => (
                    <div key={card.label} style={{
                      flex: '1 1 140px', minWidth: 120,
                      background: 'rgba(0,0,0,0.04)', border: '1px solid rgba(0,0,0,0.08)',
                      borderTop: `3px solid ${card.color}`,
                      borderRadius: 8, padding: '14px 16px',
                    }}>
                      <div style={{ fontSize: 11, color: '#888', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>{card.label}</div>
                      <div style={{ fontSize: 28, fontFamily: 'monospace', fontWeight: 800, color: card.color, lineHeight: 1 }}>{card.value}</div>
                    </div>
                  ))}
                </div>

                {/* 30-day trend chart */}
                {history.length === 0 ? (
                  <div style={{ padding: '24px 0', textAlign: 'center', color: '#888', fontSize: 13 }}>
                    Geçmiş veri yok — grafik ilk günlük hesaplamadan sonra görünür.
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#555' }}>30 Günlük Trend</div>
                    <ResponsiveContainer width="100%" height={180}>
                      <AreaChart data={chartData} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
                        <defs>
                          <linearGradient id="availExpGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#a855f7" stopOpacity={0.25} />
                            <stop offset="95%" stopColor="#a855f7" stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="availAvailGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#22c55e" stopOpacity={0.20} />
                            <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="2 2" stroke="rgba(0,0,0,0.06)" />
                        <XAxis dataKey="date" tick={{ fontSize: 9 }} interval={Math.max(0, Math.floor(chartData.length / 8))} />
                        <YAxis domain={[0, 100]} tick={{ fontSize: 9 }} tickFormatter={v => `${v}%`} />
                        <ReTooltip
                          contentStyle={{ fontSize: 12 }}
                          formatter={(v) => [`${(v as number).toFixed(1)}%`]}
                        />
                        <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                        <Area type="monotone" dataKey="Exp. Score" stroke="#a855f7" strokeWidth={1.5} fill="url(#availExpGrad)" dot={false} />
                        <Area type="monotone" dataKey="Avail. 7d"  stroke="#22c55e" strokeWidth={1.5} fill="url(#availAvailGrad)" dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </>
                )}
              </div>
            )
          })()}
        </Tabs.TabPane>

        <Tabs.TabPane tab={<span><HistoryOutlined /> Zaman Çizelgesi</span>} key="timeline">
          {timelineLoading ? (
            <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
          ) : !timelineData || timelineData.items.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
              <CalendarOutlined style={{ fontSize: 32 }} />
              <div style={{ marginTop: 8 }}>Son 30 günde kayıt yok</div>
            </div>
          ) : (
            <div style={{ maxHeight: 520, overflowY: 'auto', paddingRight: 4 }}>
              {timelineData.items.map((item) => {
                const sevColor = item.severity === 'critical' ? '#ef4444'
                  : item.severity === 'warning' ? '#f59e0b'
                  : item.severity === 'success' ? '#22c55e'
                  : '#3b82f6'
                const typeIcon = item.type === 'backup' ? <DatabaseOutlined style={{ color: '#22c55e' }} />
                  : item.type === 'audit' ? <SafetyCertificateOutlined style={{ color: '#3b82f6' }} />
                  : <AlertOutlined style={{ color: sevColor }} />
                return (
                  <div key={item.id} style={{
                    display: 'flex', gap: 12, padding: '8px 0',
                    borderBottom: '1px solid #f1f5f9',
                  }}>
                    <div style={{ paddingTop: 2 }}>{typeIcon}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>{item.title}</span>
                        {item.correlated_backup && (
                          <Tag color="orange" style={{ fontSize: 10 }}>{item.correlation_hint}</Tag>
                        )}
                      </div>
                      {item.message && (
                        <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>{item.message}</div>
                      )}
                    </div>
                    <div style={{ color: '#94a3b8', fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0 }}>
                      {dayjs(item.ts).format('DD.MM HH:mm')}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Tabs.TabPane>

      </Tabs>

      {/* ── SNMP Yapılandır Modal ────────────────────────────────────────────── */}
      <Modal
        title={<Space><ApiOutlined />{snmpSkipSsh ? 'SNMP Bilgilerini Kaydet' : 'SNMP Yapılandır'} — {currentDevice.hostname}</Space>}
        open={snmpConfigOpen}
        onCancel={() => { setSnmpConfigOpen(false); setSnmpSkipSsh(false); snmpForm.resetFields(); setSnmpVersion('v2c') }}
        onOk={() => snmpForm.submit()}
        confirmLoading={configureSnmpMutation.isPending}
        okText={snmpSkipSsh ? 'Kaydet' : 'Yapılandır (SSH)'}
        width={480}
      >
        {snmpSkipSsh ? (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: '#eff6ff', borderRadius: 6, fontSize: 12, color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
            SSH bağlantısı yapılmaz — bilgiler yalnızca sisteme kaydedilir. Cihazda SNMP zaten yapılandırılmışsa bu seçeneği kullanın.
          </div>
        ) : (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fef9c3', borderRadius: 6, fontSize: 12, color: '#92400e' }}>
            Bu işlem cihaza SSH ile bağlanarak SNMP konfigürasyon komutları gönderir.
            Yalnızca snmp-server satırı eklenir; mevcut konfigürasyon değiştirilmez.
          </div>
        )}
        <Form
          form={snmpForm}
          layout="vertical"
          initialValues={{ snmp_version: 'v2c', snmp_port: 161, snmp_community: 'netmanager',
                           snmp_v3_auth_protocol: 'sha', snmp_v3_priv_protocol: 'aes128' }}
          onFinish={(vals) => configureSnmpMutation.mutate({
            snmp_version: vals.snmp_version,
            snmp_community: vals.snmp_community,
            snmp_port: vals.snmp_port,
            snmp_v3_username: vals.snmp_v3_username,
            snmp_v3_auth_protocol: vals.snmp_v3_auth_protocol,
            snmp_v3_auth_passphrase: vals.snmp_v3_auth_passphrase,
            snmp_v3_priv_protocol: vals.snmp_v3_priv_protocol,
            snmp_v3_priv_passphrase: vals.snmp_v3_priv_passphrase,
            skip_ssh: snmpSkipSsh,
          })}
        >
          <Form.Item name="snmp_version" label="SNMP Versiyonu" rules={[{ required: true }]}>
            <Select onChange={(v) => setSnmpVersion(v)} options={[
              { label: 'SNMPv2c (Community)', value: 'v2c' },
              { label: 'SNMPv3 (Kullanıcı/Şifre)', value: 'v3' },
            ]} />
          </Form.Item>
          <Form.Item name="snmp_port" label="SNMP Port">
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
          {snmpVersion === 'v2c' && (
            <Form.Item name="snmp_community" label="Community String" rules={[{ required: true, message: 'Community string gerekli' }]}>
              <Input placeholder="netmanager" />
            </Form.Item>
          )}
          {snmpVersion === 'v3' && (
            <>
              <Form.Item name="snmp_v3_username" label="Kullanıcı Adı" rules={[{ required: true }]}>
                <Input placeholder="netmanager" />
              </Form.Item>
              <Form.Item name="snmp_v3_auth_protocol" label="Auth Protokolü">
                <Select options={[{ label: 'SHA', value: 'sha' }, { label: 'MD5', value: 'md5' }]} />
              </Form.Item>
              <Form.Item name="snmp_v3_auth_passphrase" label="Auth Parolası" rules={[{ required: true, min: 8, message: 'En az 8 karakter' }]}>
                <Input.Password />
              </Form.Item>
              <Form.Item name="snmp_v3_priv_protocol" label="Priv Protokolü">
                <Select options={[{ label: 'AES128', value: 'aes128' }, { label: 'DES', value: 'des' }]} />
              </Form.Item>
              <Form.Item name="snmp_v3_priv_passphrase" label="Priv Parolası" rules={[{ required: true, min: 8, message: 'En az 8 karakter' }]}>
                <Input.Password />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>

      {/* ── SNMP Trap Yönlendirme Modal ──────────────────────────────────────── */}
      <Modal
        title={<Space><SendOutlined />SNMP Trap Yönlendirmeyi Yapılandır — {currentDevice.hostname}</Space>}
        open={trapConfigOpen}
        onCancel={() => { setTrapConfigOpen(false); trapForm.resetFields() }}
        onOk={() => trapForm.submit()}
        confirmLoading={configureTrapMutation.isPending}
        okText="Uygula (SSH)"
        width={500}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Bu işlem cihaza SSH bağlanarak snmp-server host komutunu uygular. Cihaz bundan sonra trap'leri seçilen agent'a iletecek."
        />
        <Form
          form={trapForm}
          layout="vertical"
          onFinish={(vals) => configureTrapMutation.mutate({
            agent_id: vals.agent_id,
            community: vals.community,
            version: vals.version,
          })}
        >
          <Form.Item
            name="agent_id"
            label="Trap Hedefi — Agent"
            rules={[{ required: true, message: 'Agent seçin' }]}
            extra="Cihaz trap'lerini bu agent'ın IP adresine gönderecek (UDP 1620)"
          >
            <Select placeholder="Agent seçin">
              {agents.map(a => (
                <Select.Option key={a.id} value={a.id} disabled={!a.local_ip}>
                  <Space>
                    <Badge status={a.status === 'online' ? 'success' : 'default'} />
                    {a.name}
                    {a.local_ip
                      ? <Tag style={{ fontSize: 11 }}>{a.local_ip}</Tag>
                      : <Tag color="warning" style={{ fontSize: 11 }}>IP bilinmiyor</Tag>}
                  </Space>
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            name="community"
            label="Community String"
            rules={[{ required: true, message: 'Community string gerekli' }]}
            extra="Cihazda tanımlı SNMP community string'ini girin"
          >
            <Input placeholder="public" />
          </Form.Item>
          <Form.Item name="version" label="SNMP Versiyon" initialValue="v2c">
            <Select>
              <Select.Option value="v2c">SNMPv2c (önerilen)</Select.Option>
              <Select.Option value="v1">SNMPv1</Select.Option>
            </Select>
          </Form.Item>
          <div style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>
            Uygulanan komutlar cihaz türüne göre otomatik seçilir ({currentDevice.os_type || 'bilinmiyor'})
          </div>
        </Form>
      </Modal>

      {/* ── VLAN Ekle Modal ──────────────────────────────────────────────────── */}
      <Modal title="VLAN Ekle" open={vlanModalOpen}
        onCancel={() => { setVlanModalOpen(false); vlanForm.resetFields() }}
        onOk={() => vlanForm.submit()} confirmLoading={createVlanMutation.isPending}>
        <Form form={vlanForm} layout="vertical" onFinish={createVlanMutation.mutate}>
          <Form.Item name="vlan_id" label="VLAN ID" rules={[{ required: true }]}>
            <InputNumber min={2} max={4094} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="name" label="VLAN Adı" rules={[{ required: true }]}>
            <Input placeholder="örn: USERS" />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── VLAN Ata Modal ───────────────────────────────────────────────────── */}
      <Modal title={`VLAN Ata — ${assignVlanModal?.iface.name}`} open={!!assignVlanModal}
        onCancel={() => { setAssignVlanModal(null); assignForm.resetFields() }}
        onOk={() => assignForm.submit()} confirmLoading={assignVlanMutation.isPending}>
        <Form form={assignForm} layout="vertical" onFinish={assignVlanMutation.mutate} initialValues={{ mode: 'access' }}>
          <Form.Item name="vlan_id" label="VLAN ID" rules={[{ required: true }]}>
            <InputNumber min={1} max={4094} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="mode" label="Mod">
            <Select options={[{ label: 'Access', value: 'access' }, { label: 'Trunk', value: 'trunk' }]} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── Config Diff Modal ────────────────────────────────────────────────── */}
      <Modal
        title={
          <Space>
            <SwapOutlined />
            Config Farkı — {dayjs(diffFrom?.created_at).format('DD.MM HH:mm')} → {dayjs(diffTo?.created_at).format('DD.MM HH:mm')}
          </Space>
        }
        open={diffModalOpen}
        onCancel={() => setDiffModalOpen(false)}
        footer={null}
        width={820}
      >
        {diffMutation.data && (
          <>
            {!diffMutation.data.has_changes ? (
              <Alert
                type="info"
                showIcon
                message="İki yedek birebir aynı — değişiklik yok"
                description={
                  <span>
                    Seçili yedekler arasında hiçbir fark bulunamadı. Bu genellikle config
                    değiştirilmedi ya da yapılandırma denemesi cihaza uygulanamadı anlamına gelir.
                    Yeni backup alırken &ldquo;Config değişmemiş&rdquo; uyarısı çıktıysa,
                    SSH komutlarının cihaza gerçekten uygulanıp uygulanmadığını kontrol edin.
                  </span>
                }
              />
            ) : (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Tag color="green">+{diffMutation.data.added} eklendi</Tag>
                  <Tag color="red">-{diffMutation.data.removed} silindi</Tag>
                </Space>
                <div style={{ background: '#1e1e1e', borderRadius: 6, padding: 12, maxHeight: 480, overflow: 'auto' }}>
                  {diffMutation.data.diff
                    ? diffMutation.data.diff.split('\n').map((line, i) => {
                        let bg = 'transparent'
                        let color = '#d4d4d4'
                        if (line.startsWith('+') && !line.startsWith('+++')) { bg = 'rgba(78,201,176,0.15)'; color = '#4ec9b0' }
                        else if (line.startsWith('-') && !line.startsWith('---')) { bg = 'rgba(244,135,113,0.15)'; color = '#f48771' }
                        else if (line.startsWith('@')) color = '#569cd6'
                        return (
                          <div key={i} style={{ background: bg, color, fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>
                            {line || ' '}
                          </div>
                        )
                      })
                    : <span style={{ color: '#888' }}>Diff içeriği boş.</span>
                  }
                </div>
              </>
            )}
          </>
        )}
      </Modal>

      {/* ── Security Policy Modal ────────────────────────────────────────────── */}
      <Modal
        title={<Space><SafetyCertificateOutlined /> Güvenlik Politika Kontrolü — {currentDevice.hostname}</Space>}
        open={policyModalOpen}
        onCancel={() => setPolicyModalOpen(false)}
        footer={<Button onClick={() => setPolicyModalOpen(false)}>Kapat</Button>}
        width={640}
      >
        {checkPolicyMutation.data && (() => {
          const d = checkPolicyMutation.data
          const scoreColor = d.policy_score >= 80 ? '#52c41a' : d.policy_score >= 60 ? '#faad14' : '#ff4d4f'
          return (
            <>
              <div style={{ textAlign: 'center', marginBottom: 20 }}>
                <div style={{ fontSize: 48, fontWeight: 700, color: scoreColor, lineHeight: 1 }}>
                  {d.policy_score}
                </div>
                <div style={{ color: '#888', marginBottom: 8 }}>Politika Puanı / 100</div>
                <Progress
                  percent={d.policy_score}
                  strokeColor={scoreColor}
                  showInfo={false}
                  style={{ maxWidth: 300, margin: '0 auto' }}
                />
                <Space style={{ marginTop: 8 }}>
                  {d.critical_count > 0 && <Tag color="red">{d.critical_count} Kritik</Tag>}
                  {d.violation_count > 0 && <Tag color="orange">{d.violation_count} İhlal</Tag>}
                  {d.violation_count === 0 && <Tag color="green">Tüm kurallar geçti</Tag>}
                </Space>
              </div>
              {d.violations.length > 0 && (
                <Table
                  dataSource={d.violations}
                  rowKey="rule_id"
                  size="small"
                  pagination={false}
                  columns={[
                    {
                      title: 'Önem', dataIndex: 'severity', width: 90,
                      render: (v: string) => (
                        <Tag color={v === 'critical' ? 'red' : v === 'high' ? 'orange' : 'default'} icon={<WarningOutlined />}>
                          {v}
                        </Tag>
                      ),
                    },
                    { title: 'Kural', dataIndex: 'rule_id', width: 160 },
                    { title: 'Açıklama', dataIndex: 'description' },
                  ]}
                />
              )}
            </>
          )
        })()}
      </Modal>
    </>
  )
}
