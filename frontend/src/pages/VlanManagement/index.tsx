import { useState, useMemo } from 'react'
import {
  Typography, Table, Tag, Button, Space, Input, Modal, Form,
  InputNumber, Spin, Alert, Tooltip, Popconfirm, App, Checkbox,
  Segmented, Progress, Select, Collapse,
} from 'antd'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
dayjs.extend(relativeTime)
import {
  PlusOutlined, DeleteOutlined, ReloadOutlined, SearchOutlined,
  SyncOutlined, CheckCircleOutlined, WarningOutlined,
  AppstoreOutlined, UnorderedListOutlined, DownOutlined, RightOutlined,
  ApiOutlined, SaveOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'
import { useAuthStore } from '@/store/auth'
import { devicesApi } from '@/api/devices'
import type { Device, NetworkInterface } from '@/types'

const { Text } = Typography

const VLAN_CSS = `
@keyframes vlanRowIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
.vlan-row-full td { background: rgba(34,197,94,0.04) !important; }
.vlan-row-low  td { background: rgba(239,68,68,0.04) !important; }
.port-row-down td { opacity: 0.55; }
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

interface DeviceVlanRow {
  deviceId: number
  hostname: string
  ipAddress: string
  vlanId: number
  vlanName: string
  status: string
  ports: string[]
}

interface VlanSummaryRow {
  vlanId: number
  vlanName: string
  status: string
  devices: Array<{ deviceId: number; hostname: string; ports: string[] }>
  deviceCount: number
  coverage: number
}

interface DeviceSummaryRow {
  device: Device
  vlans: Array<{ id: number; name: string; status: string; ports: string[] }>
  loading: boolean
  error: string | null
}

/**
 * T8.4 v2 — DB snapshot read. Eski v1 her sayfa açılışında SSH atıyordu
 * (60+ cihaz, switch'lere gereksiz yük). v2: backend device_vlan_snapshots
 * tablosundan okur (SSH yok, anlık). SSH yalnız kullanıcı "Tümünü Yenile"
 * dediğinde tetiklenir (refreshVlansBatch). staleTime: Infinity →
 * sayfa içinde re-fetch yok, refetch on window focus kapalı.
 */
function useAllDeviceVlans(devices: Device[]) {
  const qc = useQueryClient()
  const ids = useMemo(() => devices.map((d) => d.id).sort((a, b) => a - b), [devices])
  const cacheKey = ids.join(',')

  const { data, isFetching } = useQuery({
    queryKey: ['device-vlans-batch', cacheKey],
    queryFn: async () => {
      if (ids.length === 0) return {
        items: {}, from_snapshot: 0, missing: 0,
        newest_fetched_at: null, oldest_fetched_at: null,
      }
      const res = await devicesApi.getVlansBatch(ids)
      // Per-device cache'i de doldur (port-assignment tab tek-cihaz
      // /vlans çağrısı yapmasın).
      for (const [didStr, payload] of Object.entries(res.items)) {
        qc.setQueryData(['device-vlans', Number(didStr)], payload)
      }
      return res
    },
    staleTime: Infinity,           // sayfa içinde re-fetch yok
    refetchOnWindowFocus: false,   // sekme dönüşünde de yok
    retry: 0,
  })

  const rows = devices.map((d) => {
    const item = data?.items?.[String(d.id)]
    return {
      device: d,
      vlans: item?.vlans || [],
      loading: isFetching && !item,
      error: item?.error || (!item && !isFetching && data ? 'Yanıt yok' : null),
      noSnapshot: Boolean(item?.no_snapshot),
      fetchedAt: item?.fetched_at,
    }
  })
  return {
    rows,
    meta: {
      newestFetchedAt: data?.newest_fetched_at ?? null,
      oldestFetchedAt: data?.oldest_fetched_at ?? null,
      missing: data?.missing ?? 0,
      fromSnapshot: data?.from_snapshot ?? 0,
      isFetching,
    },
  }
}

export default function VlanManagementPage() {
  const { message } = App.useApp()
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const C = mkC(isDark)
  const qc = useQueryClient()

  // RBAC — VLAN write = SSH config push to switches; gate on device:connect.
  // Viewer sees the list (read-only matrix) but can't bulk-add/remove VLANs
  // or commit port assignments. Backend re-enforces.
  const canMutate = useAuthStore((s) => s.can('devices', 'connect'))

  const [viewMode, setViewMode] = useState<'vlan' | 'device' | 'port'>('vlan')
  const [search, setSearch] = useState('')
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<number[]>([])
  const [bulkModalOpen, setBulkModalOpen] = useState(false)
  const [bulkAction, setBulkAction] = useState<'add' | 'delete'>('add')
  const [bulkForm] = Form.useForm()
  const [devicePanelOpen, setDevicePanelOpen] = useState(false)
  const [deviceSearch, setDeviceSearch] = useState('')
  // Port assignment view state
  const [portDevice, setPortDevice] = useState<number | undefined>()
  const [portEdits, setPortEdits] = useState<Record<string, {
    vlan_id?: number | number[]
    native_vlan_id?: number
    mode?: 'access' | 'trunk'
  }>>({})
  const [portSaving, setPortSaving] = useState<Record<string, boolean>>({})

  const { data: devicesData, isLoading: devicesLoading } = useQuery({
    queryKey: ['devices-all', activeSite],
    queryFn: () => devicesApi.list({ limit: 500, site: activeSite || undefined }),
  })

  const allDevices: Device[] = devicesData?.items || []
  const { rows: deviceVlans, meta: vlanMeta } = useAllDeviceVlans(allDevices)

  // T8.4 v2 — "Tümünü Yenile" STREAMING. Backend NDJSON gönderir; her
  // cihaz tamamlandıkça progress bar + son cihaz + diff state güncellenir.
  const [lastDiff, setLastDiff] = useState<{
    summary: { added: number; removed: number; added_devices: number; removed_devices: number; errors: number }
    items: Record<string, { hostname?: string; added: number[]; removed: number[]; error?: string }>
    fetched_at: string
  } | null>(null)
  const [diffBannerOpen, setDiffBannerOpen] = useState(false)
  const [refreshProgress, setRefreshProgress] = useState<{
    running: boolean
    completed: number
    total: number
    lastHostname: string
    lastStatus: 'ok' | 'error' | null
    okCount: number
    errCount: number
  } | null>(null)

  const runRefresh = async () => {
    if (allDevices.length === 0) return
    setRefreshProgress({
      running: true, completed: 0, total: allDevices.length,
      lastHostname: '', lastStatus: null, okCount: 0, errCount: 0,
    })
    setDiffBannerOpen(false)
    try {
      const final = await devicesApi.refreshVlansBatchStream(
        allDevices.map((d) => d.id),
        (ev) => {
          if (ev.type === 'start') {
            setRefreshProgress((p) => p && { ...p, total: ev.total })
          } else if (ev.type === 'device') {
            setRefreshProgress((p) => p && {
              ...p,
              completed: ev.completed,
              total: ev.total,
              lastHostname: ev.hostname || '?',
              lastStatus: ev.status,
              okCount: p.okCount + (ev.status === 'ok' ? 1 : 0),
              errCount: p.errCount + (ev.status === 'error' ? 1 : 0),
            })
          }
        },
      )
      setLastDiff({ summary: final.diff_summary, items: final.items, fetched_at: final.fetched_at })
      setDiffBannerOpen(true)
      qc.invalidateQueries({ queryKey: ['device-vlans-batch'] })
      allDevices.forEach((d) => qc.invalidateQueries({ queryKey: ['device-vlans', d.id] }))
      const { added, removed, added_devices, removed_devices, errors } = final.diff_summary
      if (added === 0 && removed === 0 && errors === 0) {
        message.success(`Tarama tamam — değişiklik yok (${allDevices.length} cihaz)`)
      } else {
        message.info(
          `Tarama tamam — ${added_devices} cihazda ${added} VLAN eklendi, ${removed_devices} cihazda ${removed} silindi` +
          (errors > 0 ? ` · ${errors} cihazda erişilemedi` : '')
        )
      }
    } catch (e: any) {
      message.error(e?.message || 'Yenileme başarısız')
    } finally {
      // Progress'i 1 sn sonra kapat (kullanıcı 100%'i görsün)
      setTimeout(() => setRefreshProgress(null), 1200)
    }
  }
  const refreshRunning = !!refreshProgress?.running

  // Port assignment tab queries
  const { data: portIfaceData, isLoading: portIfaceLoading } = useQuery({
    queryKey: ['device-interfaces', portDevice],
    queryFn: () => devicesApi.getInterfaces(portDevice!),
    enabled: !!portDevice,
    staleTime: 30_000,
  })
  const { data: portVlanData } = useQuery({
    queryKey: ['device-vlans', portDevice],
    queryFn: () => devicesApi.getVlans(portDevice!),
    enabled: !!portDevice,
    staleTime: 60_000,
  })

  const handlePortSave = async (ifaceName: string) => {
    if (!portDevice) return
    const edit = portEdits[ifaceName]
    const isTrunk = edit?.mode === 'trunk'
    const hasVlan = isTrunk
      ? Array.isArray(edit?.vlan_id) && (edit.vlan_id as number[]).length > 0
      : !!edit?.vlan_id
    if (!hasVlan || !edit?.mode) {
      message.warning(isTrunk ? 'En az bir VLAN seçiniz' : 'VLAN ID ve mod seçiniz')
      return
    }
    setPortSaving((s) => ({ ...s, [ifaceName]: true }))
    try {
      await devicesApi.assignVlan(portDevice, ifaceName, edit.vlan_id!, edit.mode, edit.native_vlan_id)
      const vlanDisplay = Array.isArray(edit.vlan_id)
        ? `${(edit.vlan_id as number[]).join(', ')} (trunk)`
        : `${edit.vlan_id} (${edit.mode})`
      message.success(`${ifaceName} → VLAN ${vlanDisplay} atandı`)
      qc.invalidateQueries({ queryKey: ['device-interfaces', portDevice] })
      qc.invalidateQueries({ queryKey: ['device-vlans', portDevice] })
      setPortEdits((e) => { const n = { ...e }; delete n[ifaceName]; return n })
    } catch {
      message.error('VLAN ataması başarısız')
    }
    setPortSaving((s) => ({ ...s, [ifaceName]: false }))
  }

  const deleteMutation = useMutation({
    mutationFn: ({ deviceId, vlanId }: { deviceId: number; vlanId: number }) =>
      devicesApi.deleteVlan(deviceId, vlanId),
    onSuccess: (_, { deviceId }) => {
      qc.invalidateQueries({ queryKey: ['device-vlans', deviceId] })
      qc.invalidateQueries({ queryKey: ['device-vlans-batch'] })
    },
  })

  // Flatten rows
  const allRows: DeviceVlanRow[] = useMemo(() => {
    const rows: DeviceVlanRow[] = []
    for (const dv of deviceVlans) {
      for (const v of dv.vlans) {
        rows.push({
          deviceId: dv.device.id,
          hostname: dv.device.hostname,
          ipAddress: dv.device.ip_address,
          vlanId: v.id,
          vlanName: v.name,
          status: v.status,
          ports: v.ports,
        })
      }
    }
    return rows
  }, [deviceVlans])

  // VLAN-centric aggregation
  const vlanSummaries: VlanSummaryRow[] = useMemo(() => {
    const map = new Map<number, VlanSummaryRow>()
    for (const r of allRows) {
      if (!map.has(r.vlanId)) {
        map.set(r.vlanId, { vlanId: r.vlanId, vlanName: r.vlanName, status: r.status, devices: [], deviceCount: 0, coverage: 0 })
      }
      const row = map.get(r.vlanId)!
      row.devices.push({ deviceId: r.deviceId, hostname: r.hostname, ports: r.ports })
      row.deviceCount++
    }
    const total = allDevices.filter(d => !deviceVlans.find(dv => dv.device.id === d.id)?.loading).length
    return Array.from(map.values())
      .map((r) => ({ ...r, coverage: total > 0 ? Math.round(r.deviceCount / total * 100) : 0 }))
      .sort((a, b) => a.vlanId - b.vlanId)
  }, [allRows, allDevices, deviceVlans])

  // Filtered VLAN summaries
  const filteredVlanSummaries = useMemo(() => {
    if (!search) return vlanSummaries
    const s = search.toLowerCase()
    return vlanSummaries.filter((r) =>
      String(r.vlanId).includes(s) ||
      r.vlanName.toLowerCase().includes(s) ||
      r.devices.some((d) => d.hostname.toLowerCase().includes(s))
    )
  }, [vlanSummaries, search])

  // Device-centric view
  const deviceSummaries: DeviceSummaryRow[] = useMemo(() => {
    return deviceVlans.map((dv) => ({
      device: dv.device,
      vlans: dv.vlans,
      loading: dv.loading,
      error: dv.error,
    }))
  }, [deviceVlans])

  const filteredDeviceSummaries = useMemo(() => {
    if (!search) return deviceSummaries
    const s = search.toLowerCase()
    return deviceSummaries.filter((r) =>
      r.device.hostname.toLowerCase().includes(s) ||
      r.vlans.some((v) => String(v.id).includes(s) || v.name.toLowerCase().includes(s))
    )
  }, [deviceSummaries, search])

  const filteredDevicesForSelector = useMemo(() => {
    if (!deviceSearch) return allDevices
    const s = deviceSearch.toLowerCase()
    return allDevices.filter((d) => d.hostname.toLowerCase().includes(s))
  }, [allDevices, deviceSearch])

  const loadingCount = deviceVlans.filter((d) => d.loading).length
  const errorCount = deviceVlans.filter((d) => d.error).length
  const uniqueVlanCount = vlanSummaries.length
  const fullyConsistentCount = vlanSummaries.filter((v) => v.coverage === 100).length
  const partialCount = vlanSummaries.filter((v) => v.coverage > 0 && v.coverage < 100).length

  const openBulkWithVlan = (vlanId: number, name: string, action: 'add' | 'delete') => {
    bulkForm.setFieldsValue({ vlan_id: vlanId, name })
    setBulkAction(action)
    setBulkModalOpen(true)
  }

  const handleBulkSubmit = async (values: { vlan_id: number; name?: string }) => {
    if (selectedDeviceIds.length === 0) {
      message.warning('Lütfen cihaz seçin')
      return
    }
    let ok = 0, fail = 0
    for (const deviceId of selectedDeviceIds) {
      try {
        if (bulkAction === 'add') {
          await devicesApi.createVlan(deviceId, values.vlan_id, values.name || `VLAN${values.vlan_id}`)
        } else {
          await devicesApi.deleteVlan(deviceId, values.vlan_id)
        }
        qc.invalidateQueries({ queryKey: ['device-vlans', deviceId] })
        qc.invalidateQueries({ queryKey: ['device-vlans-batch'] })
        ok++
      } catch {
        fail++
      }
    }
    message.success(`${ok} cihazda ${bulkAction === 'add' ? 'eklendi' : 'silindi'}${fail > 0 ? `, ${fail} hata` : ''}`)
    setBulkModalOpen(false)
    bulkForm.resetFields()
  }

  // VLAN-centric table columns
  const vlanColumns = [
    {
      title: 'VLAN',
      width: 80,
      sorter: (a: VlanSummaryRow, b: VlanSummaryRow) => a.vlanId - b.vlanId,
      defaultSortOrder: 'ascend' as const,
      render: (_: unknown, r: VlanSummaryRow) => (
        <Tag color="blue" style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 13, margin: 0 }}>
          {r.vlanId}
        </Tag>
      ),
    },
    {
      title: 'İsim',
      dataIndex: 'vlanName',
      width: 160,
      ellipsis: true,
      render: (v: string) => <Text style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 500 }}>{v}</Text>,
    },
    {
      title: 'Durum',
      dataIndex: 'status',
      width: 80,
      render: (v: string) => <Tag color={v === 'active' ? 'green' : 'default'}>{v || '—'}</Tag>,
    },
    {
      title: 'Kapsam',
      width: 180,
      sorter: (a: VlanSummaryRow, b: VlanSummaryRow) => a.coverage - b.coverage,
      render: (_: unknown, r: VlanSummaryRow) => {
        const color = r.coverage === 100 ? '#22c55e' : r.coverage >= 50 ? '#f59e0b' : '#ef4444'
        return (
          <div style={{ minWidth: 140 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <Text style={{ fontSize: 11, color: '#64748b' }}>{r.deviceCount}/{allDevices.length} switch</Text>
              <Text style={{ fontSize: 11, color, fontWeight: 600 }}>{r.coverage}%</Text>
            </div>
            <Progress percent={r.coverage} size="small" showInfo={false} strokeColor={color} trailColor="#e2e8f0" />
          </div>
        )
      },
    },
    {
      title: 'Switchler',
      render: (_: unknown, r: VlanSummaryRow) => (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, maxWidth: 400 }}>
          {r.devices.slice(0, 6).map((d) => (
            <Tag key={d.deviceId} style={{ fontSize: 10, margin: 0, padding: '0 5px' }}>
              {d.hostname}
            </Tag>
          ))}
          {r.devices.length > 6 && (
            <Tooltip title={r.devices.slice(6).map((d) => d.hostname).join(', ')}>
              <Tag style={{ fontSize: 10, margin: 0, padding: '0 5px', cursor: 'pointer', background: '#f1f5f9' }}>
                +{r.devices.length - 6} daha
              </Tag>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 90,
      render: (_: unknown, r: VlanSummaryRow) => (
        <Space size={4}>
          <Tooltip title={selectedDeviceIds.length > 0 ? `${selectedDeviceIds.length} cihaza ekle` : 'Önce cihaz seç'}>
            <Button
              size="small"
              icon={<PlusOutlined />}
              disabled={selectedDeviceIds.length === 0}
              onClick={() => openBulkWithVlan(r.vlanId, r.vlanName, 'add')}
            />
          </Tooltip>
          <Tooltip title={selectedDeviceIds.length > 0 ? `${selectedDeviceIds.length} cihazdan sil` : 'Önce cihaz seç'}>
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              disabled={selectedDeviceIds.length === 0}
              onClick={() => openBulkWithVlan(r.vlanId, r.vlanName, 'delete')}
            />
          </Tooltip>
        </Space>
      ),
    },
  ]

  // Device-centric table columns
  const deviceColumns = [
    {
      title: 'Switch',
      width: 220,
      render: (_: unknown, r: DeviceSummaryRow) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {r.loading && <SyncOutlined spin style={{ color: '#f59e0b', fontSize: 12 }} />}
          {r.error && !r.loading && <WarningOutlined style={{ color: '#ef4444', fontSize: 12 }} />}
          {!r.loading && !r.error && <CheckCircleOutlined style={{ color: '#22c55e', fontSize: 12 }} />}
          <div>
            <Text style={{ fontWeight: 600, fontSize: 13 }}>{r.device.hostname}</Text>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>{r.device.ip_address}</div>
          </div>
        </div>
      ),
    },
    {
      title: 'VLAN Sayısı',
      width: 110,
      render: (_: unknown, r: DeviceSummaryRow) => (
        r.loading
          ? <Text type="secondary" style={{ fontSize: 12 }}>Yükleniyor…</Text>
          : r.error
            ? <Tag color="error">Hata</Tag>
            : <Tag color="blue" style={{ fontWeight: 600 }}>{r.vlans.length} VLAN</Tag>
      ),
    },
    {
      title: 'VLANlar',
      render: (_: unknown, r: DeviceSummaryRow) => {
        if (r.loading) return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>
        if (r.error) return <Text type="danger" style={{ fontSize: 11 }}>{r.error}</Text>
        return (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {r.vlans.slice(0, 12).map((v) => (
              <Tooltip key={v.id} title={v.name}>
                <Tag
                  color="geekblue"
                  style={{ fontFamily: 'monospace', fontSize: 11, margin: 0, padding: '0 5px' }}
                >
                  {v.id}
                </Tag>
              </Tooltip>
            ))}
            {r.vlans.length > 12 && (
              <Tag style={{ fontSize: 11, margin: 0, color: '#64748b' }}>+{r.vlans.length - 12}</Tag>
            )}
          </div>
        )
      },
    },
    {
      title: '',
      width: 60,
      render: (_: unknown, r: DeviceSummaryRow) => (
        <Checkbox
          checked={selectedDeviceIds.includes(r.device.id)}
          onChange={(e) =>
            setSelectedDeviceIds((prev) =>
              e.target.checked ? [...prev, r.device.id] : prev.filter((id) => id !== r.device.id)
            )
          }
        >
          <Text style={{ fontSize: 11, color: '#64748b' }}>Seç</Text>
        </Checkbox>
      ),
    },
  ]

  if (devicesLoading) return <Spin />

  // ── Computed KPIs for the NOC stat bar ─────────────────────────────────────
  const inconsistencyCount = partialCount  // alias for clarity in the tile

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <style>{VLAN_CSS}</style>

      {/* NOC header */}
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>Ağ Operasyonları</span><span>VLAN</span></div>
          <h1 className="nm-page-title">
            VLAN Yönetimi
            <span className="nm-pill mono">{uniqueVlanCount} VLAN</span>
            <span className="nm-pill mono">{allDevices.length} switch</span>
            {/* T8.4 v2 — Snapshot zaman damgası pill. DB'den okuyor; SSH yok.
                Tarama eski olursa kullanıcı "Tümünü Yenile"yi tetikleyebilir. */}
            {vlanMeta.newestFetchedAt && (
              <Tooltip title={`En son: ${dayjs(vlanMeta.newestFetchedAt).format('DD.MM.YYYY HH:mm')}${vlanMeta.oldestFetchedAt && vlanMeta.oldestFetchedAt !== vlanMeta.newestFetchedAt ? ` · en eski: ${dayjs(vlanMeta.oldestFetchedAt).format('DD.MM HH:mm')}` : ''}`}>
                <span className="nm-pill mono" style={{ color: 'var(--fg-2)' }}>
                  Snapshot: {dayjs(vlanMeta.newestFetchedAt).fromNow()}
                </span>
              </Tooltip>
            )}
            {vlanMeta.missing > 0 && (
              <Tooltip title="Bu cihazlar için henüz hiç VLAN taraması yapılmadı. 'Tümünü Yenile' ile tara.">
                <span className="nm-pill warn">{vlanMeta.missing} cihaz taranmadı</span>
              </Tooltip>
            )}
          </h1>
          <div className="nm-page-sub">
            T&#xFC;m switchlerin VLAN da&#x11F;&#x131;l&#x131;m&#x131; &#xB7; bo&#x15F;luklar&#x131; renkle yakala &#xB7;
            toplu VLAN ekle/sil &#xB7; port atamas&#x131; tek panelden.
          </div>
        </div>
        <Space>
          <Tooltip title="Tüm switch'lere SSH ile bağlanıp VLAN listesini tazeler, eklenen/silinen VLAN'ları raporlar. DB snapshot güncellenir.">
            <Button
              icon={<SyncOutlined spin={refreshRunning} />}
              type={vlanMeta.missing > 0 ? 'primary' : 'default'}
              loading={refreshRunning}
              onClick={runRefresh}
            >
              {refreshRunning
                ? `Tarıyor… ${refreshProgress?.completed ?? 0}/${refreshProgress?.total ?? allDevices.length}`
                : 'Tümünü Yenile'}
            </Button>
          </Tooltip>
          {canMutate && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={selectedDeviceIds.length === 0}
              onClick={() => { setBulkAction('add'); bulkForm.resetFields(); setBulkModalOpen(true) }}
            >
              VLAN Ekle {selectedDeviceIds.length > 0 && `(${selectedDeviceIds.length})`}
            </Button>
          )}
          {canMutate && (
            <Button
              danger
              icon={<DeleteOutlined />}
              disabled={selectedDeviceIds.length === 0}
              onClick={() => { setBulkAction('delete'); bulkForm.resetFields(); setBulkModalOpen(true) }}
            >
              VLAN Sil
            </Button>
          )}
        </Space>
      </div>

      {/* T8.4 v2 — Streaming refresh progress bar. Backend NDJSON gönderir;
          her cihaz tamamlandıkça completed sayısı + son cihaz adı + status
          (ok/error) güncellenir. Kullanıcı kara delik beklemez. */}
      {refreshProgress && (
        <div className="nm-card" style={{ marginBottom: 12, padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <SyncOutlined spin={refreshProgress.running} style={{ color: 'var(--accent)', fontSize: 16 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                VLAN taraması ({refreshProgress.completed} / {refreshProgress.total})
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-2)' }}>
                Son cihaz: <span style={{ fontFamily: 'monospace', color: 'var(--fg-0)' }}>
                  {refreshProgress.lastHostname || '—'}
                </span>
                {refreshProgress.lastStatus === 'ok' && (
                  <Tag color="green" style={{ marginLeft: 6, fontSize: 10 }}>OK</Tag>
                )}
                {refreshProgress.lastStatus === 'error' && (
                  <Tag color="red" style={{ marginLeft: 6, fontSize: 10 }}>HATA</Tag>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, fontSize: 11, color: 'var(--fg-2)' }}>
              <span>✓ <strong style={{ color: 'var(--ok)' }}>{refreshProgress.okCount}</strong></span>
              <span>✗ <strong style={{ color: 'var(--crit)' }}>{refreshProgress.errCount}</strong></span>
            </div>
          </div>
          <Progress
            percent={refreshProgress.total > 0 ? Math.round((refreshProgress.completed / refreshProgress.total) * 100) : 0}
            status={refreshProgress.running ? 'active' : 'success'}
            strokeColor={refreshProgress.errCount > 0 ? { from: '#3b82f6', to: '#f59e0b' } : { from: '#3b82f6', to: '#22c55e' }}
            showInfo={true}
            format={(pct) => `${pct}%`}
          />
        </div>
      )}

      {/* T8.4 v2 — Refresh sonrası diff banner. "Tümünü Yenile" çağrısı
          tamamlandığında: değişiklik varsa ekle/sil ozeti + hangi cihazlarda
          olduğunu collapse içinde göster. Kapanabilir. */}
      {diffBannerOpen && lastDiff && (
        (lastDiff.summary.added > 0 || lastDiff.summary.removed > 0 || lastDiff.summary.errors > 0) ? (
          <Alert
            type={lastDiff.summary.errors > 0 ? 'warning' : 'info'}
            showIcon
            closable
            onClose={() => setDiffBannerOpen(false)}
            style={{ marginBottom: 12 }}
            message={
              <Space>
                <strong>Tarama tamamlandı</strong>
                <Tag color="green">+{lastDiff.summary.added} VLAN ({lastDiff.summary.added_devices} cihaz)</Tag>
                <Tag color="red">−{lastDiff.summary.removed} VLAN ({lastDiff.summary.removed_devices} cihaz)</Tag>
                {lastDiff.summary.errors > 0 && (
                  <Tag color="orange">{lastDiff.summary.errors} cihaz erişilemedi</Tag>
                )}
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {dayjs(lastDiff.fetched_at).format('DD.MM.YYYY HH:mm:ss')}
                </Text>
              </Space>
            }
            description={
              <Collapse ghost size="small" style={{ marginTop: 4 }}>
                <Collapse.Panel key="d" header={<span style={{ fontSize: 12 }}>Cihaz detayı</span>}>
                  <div style={{ maxHeight: 200, overflowY: 'auto', fontSize: 12 }}>
                    {Object.entries(lastDiff.items)
                      .filter(([, v]) => v.added.length > 0 || v.removed.length > 0 || v.error)
                      .slice(0, 50)
                      .map(([did, v]) => (
                        <div key={did} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', borderBottom: '1px solid var(--line-soft)' }}>
                          <Text strong style={{ fontFamily: 'monospace', minWidth: 200 }}>{v.hostname || `#${did}`}</Text>
                          {v.error ? (
                            <Text type="danger" style={{ fontSize: 11 }}>{v.error}</Text>
                          ) : (
                            <>
                              {v.added.length > 0 && (
                                <Tag color="green" style={{ fontFamily: 'monospace', fontSize: 10 }}>
                                  +{v.added.join(', ')}
                                </Tag>
                              )}
                              {v.removed.length > 0 && (
                                <Tag color="red" style={{ fontFamily: 'monospace', fontSize: 10 }}>
                                  −{v.removed.join(', ')}
                                </Tag>
                              )}
                            </>
                          )}
                        </div>
                      ))}
                  </div>
                </Collapse.Panel>
              </Collapse>
            }
          />
        ) : (
          <Alert
            type="success"
            showIcon
            closable
            onClose={() => setDiffBannerOpen(false)}
            style={{ marginBottom: 12 }}
            message={`Tarama tamamlandı — ${allDevices.length} cihazda değişiklik yok`}
            description={`Snapshot güncellendi: ${dayjs(lastDiff.fetched_at).format('DD.MM.YYYY HH:mm:ss')}`}
          />
        )
      )}

      {/* NOC stat bar — 6 real KPIs */}
      <div className="nm-statbar">
        <div className="nm-stat">
          <div className="nm-stat-label">SWITCH</div>
          <div className="nm-stat-val">{allDevices.length}</div>
          <div className="nm-stat-delta">VLAN sorgulanan</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">BENZERSİZ VLAN</div>
          <div className="nm-stat-val">{uniqueVlanCount}</div>
          <div className="nm-stat-delta">fleet genelinde</div>
        </div>
        <div className={`nm-stat ${fullyConsistentCount > 0 ? 'ok' : ''}`}>
          <div className="nm-stat-label">TÜM SWITCHLERDE</div>
          <div className="nm-stat-val">{fullyConsistentCount}</div>
          <div className="nm-stat-delta">%100 kapsam VLAN</div>
        </div>
        <div className={`nm-stat ${inconsistencyCount > 0 ? 'warn' : ''}`}>
          <div className="nm-stat-label">KISMI DAĞITIM</div>
          <div className="nm-stat-val">{inconsistencyCount}</div>
          <div className="nm-stat-delta">tutarsız (bazı switch'lerde yok)</div>
        </div>
        <div className={`nm-stat ${errorCount > 0 ? 'crit' : 'ok'}`}>
          <div className="nm-stat-label">SSH HATA</div>
          <div className="nm-stat-val">{errorCount}</div>
          <div className="nm-stat-delta">VLAN bilgisi alınamadı</div>
        </div>
        <div className={`nm-stat ${loadingCount > 0 ? 'warn' : ''}`}>
          <div className="nm-stat-label">YÜKLENİYOR</div>
          <div className="nm-stat-val">{loadingCount}</div>
          <div className="nm-stat-delta">aktif SSH sorgu</div>
        </div>
      </div>

      {/* ── Error alert ── */}
      {errorCount > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`${errorCount} cihaza SSH bağlantısı kurulamadı. VLAN bilgileri eksik olabilir.`}
          description={deviceVlans.filter((d) => d.error).map((d) => d.device.hostname).join(', ')}
        />
      )}

      {/* ── Device selector (collapsible) ── */}
      <div className="nm-card" style={{ padding: '8px 12px' }}>
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
          onClick={() => setDevicePanelOpen((v) => !v)}
        >
          <Space>
            {devicePanelOpen ? <DownOutlined style={{ fontSize: 11, color: '#64748b' }} /> : <RightOutlined style={{ fontSize: 11, color: '#64748b' }} />}
            <Text style={{ fontWeight: 600, fontSize: 13 }}>
              Switch Seçimi
            </Text>
            {selectedDeviceIds.length > 0 ? (
              <Tag color="blue">{selectedDeviceIds.length} seçili</Tag>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>Toplu işlem için switch seç</Text>
            )}
          </Space>
          <Space onClick={(e) => e.stopPropagation()}>
            <Button size="small" onClick={() => setSelectedDeviceIds(allDevices.map((d) => d.id))}>
              Tümünü Seç
            </Button>
            <Button size="small" onClick={() => setSelectedDeviceIds([])}>
              Temizle
            </Button>
          </Space>
        </div>

        {devicePanelOpen && (
          <div style={{ marginTop: 10 }}>
            <Input
              prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
              placeholder="Switch ara..."
              value={deviceSearch}
              onChange={(e) => setDeviceSearch(e.target.value)}
              size="small"
              style={{ marginBottom: 8, width: 220 }}
              allowClear
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {filteredDevicesForSelector.map((d) => {
                const dv = deviceVlans.find((x) => x.device.id === d.id)
                const checked = selectedDeviceIds.includes(d.id)
                return (
                  <div
                    key={d.id}
                    onClick={() =>
                      setSelectedDeviceIds((prev) =>
                        prev.includes(d.id) ? prev.filter((id) => id !== d.id) : [...prev, d.id]
                      )
                    }
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 10px',
                      borderRadius: 6,
                      border: `1px solid ${checked ? '#3b82f6' : C.border}`,
                      background: checked ? (isDark ? '#3b82f625' : '#eff6ff') : 'transparent',
                      cursor: 'pointer',
                      fontSize: 12,
                      color: checked ? '#3b82f6' : C.muted,
                      transition: 'all 0.12s',
                    }}
                  >
                    {dv?.loading && <SyncOutlined spin style={{ fontSize: 10 }} />}
                    {dv?.error && !dv?.loading && <WarningOutlined style={{ fontSize: 10, color: '#ef4444' }} />}
                    {!dv?.loading && !dv?.error && checked && <CheckCircleOutlined style={{ fontSize: 10 }} />}
                    <span style={{ fontWeight: checked ? 600 : 400 }}>{d.hostname}</span>
                    {!dv?.loading && !dv?.error && (
                      <span style={{ fontSize: 10, color: checked ? '#3b82f6' : '#94a3b8' }}>
                        {dv?.vlans.length ?? 0}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── View toggle + search ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Segmented
          value={viewMode}
          onChange={(v) => setViewMode(v as 'vlan' | 'device' | 'port')}
          options={[
            { value: 'vlan', icon: <AppstoreOutlined />, label: 'VLAN Bazlı' },
            { value: 'device', icon: <UnorderedListOutlined />, label: 'Cihaz Bazlı' },
            { value: 'port', icon: <ApiOutlined />, label: 'Port Atama' },
          ]}
        />
        {viewMode !== 'port' && (
          <>
            <Input
              prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
              placeholder={viewMode === 'vlan' ? 'VLAN ID, isim veya switch ara…' : 'Switch adı veya VLAN ara…'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 300 }}
              allowClear
            />
            {search && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {viewMode === 'vlan' ? filteredVlanSummaries.length : filteredDeviceSummaries.length} sonuç
              </Text>
            )}
            <Button
              size="small"
              icon={<ReloadOutlined />}
              style={{ marginLeft: 'auto' }}
              onClick={() => setSearch('')}
            >
              Filtreyi Temizle
            </Button>
          </>
        )}
      </div>

      {viewMode === 'vlan' && (
        <div className="nm-card" style={{ padding: 0, overflow: 'hidden' }}>
        <Table<VlanSummaryRow>
          dataSource={filteredVlanSummaries}
          rowKey="vlanId"
          columns={vlanColumns}
          size="small"
          loading={loadingCount === allDevices.length && allRows.length === 0}
          pagination={{ pageSize: 50, showTotal: (n) => `${n} benzersiz VLAN`, showSizeChanger: false }}
          scroll={{ x: 900 }}
          rowClassName={(r) => {
            if (r.coverage === 100) return 'vlan-row-full'
            if (r.coverage < 50) return 'vlan-row-low'
            return ''
          }}
          expandable={{
            expandedRowRender: (r) => (
              <div style={{ padding: '8px 0 4px' }}>
                <Text type="secondary" style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, display: 'block' }}>
                  VLAN {r.vlanId} — Cihaz / Port Dağılımı
                </Text>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {r.devices.map((d) => (
                    <div key={d.deviceId} style={{
                      border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 10px',
                      background: C.bg2, minWidth: 160,
                    }}>
                      <Text style={{ fontWeight: 600, fontSize: 12 }}>{d.hostname}</Text>
                      {d.ports.length > 0 ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 4 }}>
                          {d.ports.map((p) => (
                            <Tag key={p} style={{ fontSize: 10, margin: 0, padding: '0 4px', fontFamily: 'monospace' }}>{p}</Tag>
                          ))}
                        </div>
                      ) : (
                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>Port bilgisi yok</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ),
            rowExpandable: (r) => r.devices.length > 0,
          }}
        />
        </div>
      )}

      {viewMode === 'device' && (
        <div className="nm-card" style={{ padding: 0, overflow: 'hidden' }}>
        <Table<DeviceSummaryRow>
          dataSource={filteredDeviceSummaries}
          rowKey={(r) => r.device.id}
          columns={deviceColumns}
          size="small"
          loading={loadingCount === allDevices.length && allRows.length === 0}
          pagination={{ pageSize: 30, showTotal: (n) => `${n} switch`, showSizeChanger: false }}
          expandable={{
            expandedRowRender: (r) => {
              if (r.loading) return <Spin size="small" />
              if (r.error) return <Alert type="error" message={r.error} showIcon />
              return (
                <div style={{ padding: '8px 0' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {r.vlans.map((v) => (
                      <div
                        key={v.id}
                        style={{
                          display: 'inline-flex', alignItems: 'flex-start', flexDirection: 'column', gap: 4,
                          border: `1px solid ${C.border}`, borderRadius: 6,
                          padding: '5px 8px', fontSize: 12, background: C.bg2, minWidth: 120,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <Tag color="blue" style={{ fontFamily: 'monospace', fontSize: 11, margin: 0, padding: '0 4px' }}>
                            {v.id}
                          </Tag>
                          <Text style={{ fontSize: 11, fontFamily: 'monospace' }}>{v.name}</Text>
                          <Tag color={v.status === 'active' ? 'green' : 'default'} style={{ fontSize: 10, margin: 0, padding: '0 4px' }}>
                            {v.status}
                          </Tag>
                          {v.id !== 1 && (
                            <Popconfirm
                              title={`VLAN ${v.id}'i ${r.device.hostname}'dan sil?`}
                              onConfirm={() => deleteMutation.mutate({ deviceId: r.device.id, vlanId: v.id })}
                            >
                              <Button size="small" type="text" danger icon={<DeleteOutlined />} style={{ padding: 0, height: 16, width: 16 }} />
                            </Popconfirm>
                          )}
                        </div>
                        {v.ports.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                            {v.ports.map((p) => (
                              <Tag key={p} style={{ fontSize: 10, margin: 0, padding: '0 3px', fontFamily: 'monospace', background: '#e0e7ff', borderColor: '#c7d2fe', color: '#4338ca' }}>{p}</Tag>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )
            },
            rowExpandable: (r) => !r.loading && !r.error,
          }}
        />
        </div>
      )}

      {/* ── Bulk modal ── */}
      <Modal
        title={
          <Space>
            {bulkAction === 'add' ? <PlusOutlined /> : <DeleteOutlined />}
            {bulkAction === 'add'
              ? `VLAN Ekle — ${selectedDeviceIds.length} Switch`
              : `VLAN Sil — ${selectedDeviceIds.length} Switch`}
          </Space>
        }
        open={bulkModalOpen}
        onCancel={() => { setBulkModalOpen(false); bulkForm.resetFields() }}
        onOk={() => bulkForm.submit()}
        okText={bulkAction === 'add' ? 'Ekle' : 'Sil'}
        okButtonProps={{ danger: bulkAction === 'delete' }}
      >
        <Alert
          type={bulkAction === 'add' ? 'info' : 'warning'}
          showIcon
          style={{ marginBottom: 16 }}
          message={
            bulkAction === 'add'
              ? `${selectedDeviceIds.length} switch'e VLAN eklenecek.`
              : `${selectedDeviceIds.length} switch'ten VLAN silinecek. Bu işlem geri alınamaz.`
          }
          description={
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 4 }}>
              {selectedDeviceIds.slice(0, 8).map((id) => {
                const d = allDevices.find((x) => x.id === id)
                return d ? <Tag key={id} style={{ fontSize: 11 }}>{d.hostname}</Tag> : null
              })}
              {selectedDeviceIds.length > 8 && (
                <Tag style={{ fontSize: 11, color: '#64748b' }}>+{selectedDeviceIds.length - 8} daha</Tag>
              )}
            </div>
          }
        />
        <Form form={bulkForm} layout="vertical" onFinish={handleBulkSubmit}>
          <Form.Item name="vlan_id" label="VLAN ID" rules={[{ required: true, message: 'VLAN ID gerekli' }]}>
            <InputNumber min={2} max={4094} style={{ width: '100%' }} placeholder="2–4094" />
          </Form.Item>
          {bulkAction === 'add' && (
            <Form.Item name="name" label="VLAN İsmi (opsiyonel)">
              <Input placeholder="ör. YONETIM, DATA, VOICE" />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* ── Port assignment view ── */}
      {viewMode === 'port' && (() => {
        const ifaces: NetworkInterface[] = portIfaceData?.interfaces || []
        const vlans = portVlanData?.vlans || []
        const vlanOptions = vlans.map((v) => ({ value: v.id, label: `VLAN ${v.id} — ${v.name}` }))
        const portError = portIfaceData?.error

        const portColumns = [
          {
            title: 'Port',
            dataIndex: 'name',
            width: 160,
            render: (v: string) => <Text style={{ fontFamily: 'monospace', fontWeight: 600 }}>{v}</Text>,
          },
          {
            title: 'Açıklama',
            dataIndex: 'description',
            ellipsis: true,
            render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{v || '—'}</Text>,
          },
          {
            title: 'Durum',
            dataIndex: 'status',
            width: 110,
            render: (v: string) => (
              <Tag color={v === 'connected' ? 'green' : v === 'disabled' ? 'default' : 'red'}>
                {v === 'connected' ? 'Bağlı' : v === 'disabled' ? 'Devre Dışı' : v || '—'}
              </Tag>
            ),
          },
          {
            title: 'Mevcut VLAN',
            dataIndex: 'vlan',
            width: 110,
            render: (v: string) => v ? (
              <Tag color="blue" style={{ fontFamily: 'monospace' }}>{v}</Tag>
            ) : <Text type="secondary">—</Text>,
          },
          {
            title: 'Yeni VLAN',
            width: 240,
            render: (_: unknown, r: NetworkInterface) => {
              const mode = portEdits[r.name]?.mode
              if (mode === 'trunk') {
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <Select
                      mode="multiple"
                      placeholder="İzin verilen VLANlar"
                      style={{ width: '100%' }}
                      size="small"
                      value={portEdits[r.name]?.vlan_id as number[] | undefined}
                      onChange={(v: number[]) => setPortEdits((e) => ({ ...e, [r.name]: { ...e[r.name], vlan_id: v } }))}
                      options={vlanOptions}
                      showSearch
                      filterOption={(input, opt) => String(opt?.label).toLowerCase().includes(input.toLowerCase())}
                      maxTagCount={2}
                      allowClear
                    />
                    <Select
                      placeholder="Native VLAN (isteğe bağlı)"
                      style={{ width: '100%' }}
                      size="small"
                      value={portEdits[r.name]?.native_vlan_id}
                      onChange={(v: number) => setPortEdits((e) => ({ ...e, [r.name]: { ...e[r.name], native_vlan_id: v } }))}
                      options={vlanOptions}
                      showSearch
                      filterOption={(input, opt) => String(opt?.label).toLowerCase().includes(input.toLowerCase())}
                      allowClear
                    />
                  </div>
                )
              }
              return (
                <Select
                  placeholder="VLAN seç"
                  style={{ width: '100%' }}
                  size="small"
                  value={portEdits[r.name]?.vlan_id as number | undefined}
                  onChange={(v: number) => setPortEdits((e) => ({ ...e, [r.name]: { ...e[r.name], vlan_id: v } }))}
                  options={vlanOptions}
                  showSearch
                  filterOption={(input, opt) => String(opt?.label).toLowerCase().includes(input.toLowerCase())}
                  allowClear
                />
              )
            },
          },
          {
            title: 'Mod',
            width: 120,
            render: (_: unknown, r: NetworkInterface) => (
              <Select
                placeholder="Mod"
                style={{ width: '100%' }}
                size="small"
                value={portEdits[r.name]?.mode}
                onChange={(v) => setPortEdits((e) => ({
                  ...e,
                  [r.name]: { ...e[r.name], mode: v, vlan_id: undefined, native_vlan_id: undefined },
                }))}
                options={[
                  { value: 'access', label: 'Access' },
                  { value: 'trunk', label: 'Trunk' },
                ]}
              />
            ),
          },
          {
            title: '',
            width: 80,
            render: (_: unknown, r: NetworkInterface) => {
              // Viewer cannot push VLAN-config to ports — backend rejects too.
              if (!canMutate) return <span style={{ color: 'var(--fg-3)' }}>—</span>
              const edit = portEdits[r.name]
              const hasEdit = edit?.mode && (
                edit.mode === 'trunk'
                  ? Array.isArray(edit.vlan_id) && (edit.vlan_id as number[]).length > 0
                  : !!edit.vlan_id
              )
              return (
                <Button
                  size="small"
                  type={hasEdit ? 'primary' : 'default'}
                  icon={<SaveOutlined />}
                  disabled={!hasEdit}
                  loading={portSaving[r.name]}
                  onClick={() => handlePortSave(r.name)}
                >
                  Ata
                </Button>
              )
            },
          },
        ]

        return (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <Select
                placeholder="Switch seçin"
                style={{ width: 300 }}
                value={portDevice}
                onChange={(v) => { setPortDevice(v); setPortEdits({}) }}
                options={allDevices.map((d) => ({ value: d.id, label: `${d.hostname} (${d.ip_address})` }))}
                showSearch
                filterOption={(input, opt) => String(opt?.label).toLowerCase().includes(input.toLowerCase())}
              />
              {portDevice && (
                <Button
                  icon={<SyncOutlined />}
                  onClick={() => {
                    qc.invalidateQueries({ queryKey: ['device-interfaces', portDevice] })
                    qc.invalidateQueries({ queryKey: ['device-vlans', portDevice] })
                  }}
                >
                  Yenile
                </Button>
              )}
              {ifaces.length > 0 && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {ifaces.length} port · {vlans.length} VLAN mevcut
                </Text>
              )}
            </div>

            {!portDevice && (
              <Alert
                type="info"
                showIcon
                message="Port VLAN Ataması"
                description="Yukarıdan bir switch seçin. O switch'in portları ve mevcut VLAN atamaları yüklenecek. Her port için yeni VLAN ve mod (access/trunk) seçip 'Ata' butonuyla uygulayabilirsiniz."
              />
            )}

            {portDevice && portIfaceLoading && (
              <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
            )}

            {portDevice && portError && !portIfaceLoading && (
              <Alert type="error" showIcon message="SSH bağlantı hatası" description={portError} />
            )}

            {portDevice && !portIfaceLoading && ifaces.length > 0 && (
              <Table<NetworkInterface>
                dataSource={ifaces}
                rowKey="name"
                columns={portColumns}
                size="small"
                pagination={{ pageSize: 30, showTotal: (n) => `${n} port`, showSizeChanger: false }}
                rowClassName={(r) => r.status === 'connected' ? '' : 'port-row-down'}
              />
            )}
          </div>
        )
      })()}

    </div>
  )
}
