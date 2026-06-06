/**
 * T10 C7.D — Device Detail > Aksiyonlar sekmesi.
 *
 * Cihaz seviyesi aksiyonlar: bağlantı testi, bilgi çek, yaşam döngüsü, lokasyon
 * taşı, arşive al, sil. W3.3 hotfix (2026-06-01): disabled "Port Shutdown /
 * Quarantine" placeholder kaldırıldı — gerçek aksiyonlar W3.4 ActionsTab
 * restructure ile gelecek.
 * Viewer: read-only — bilgi banner. org_admin+ aksiyon yapabilir.
 */
import { useMemo, useState } from 'react'
import { Card, Button, Space, Tag, Popconfirm, message, Tooltip, Alert, Select } from 'antd'
import {
  ApiOutlined, ReloadOutlined, EnvironmentOutlined, InboxOutlined,
  DeleteOutlined, SyncOutlined, HeartOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Device } from '@/types'
import { devicesApi } from '@/api/devices'
import { useAuthStore } from '@/store/auth'

// KURAL-E1: LIFECYCLE_OPTIONS hook scope'unda useMemo + t() ile çözülür.
// Backend enum (production/passive/stock/archived) sabit kalır.
export default function ActionsTab({ device }: { device: Device }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { isOrgAdmin } = useAuthStore()
  const canWrite = isOrgAdmin()

  const LIFECYCLE_OPTIONS = useMemo(() => [
    { value: 'production', label: t('devices.detail.actions_tab.lifecycle.production') },
    { value: 'passive',    label: t('devices.detail.actions_tab.lifecycle.passive') },
    { value: 'stock',      label: t('devices.detail.actions_tab.lifecycle.stock') },
    { value: 'archived',   label: t('devices.detail.actions_tab.lifecycle.archived') },
  ], [t])

  const [nextLifecycle, setNextLifecycle] = useState<string>((device as any).lifecycle_status || 'production')

  const refresh = () => qc.invalidateQueries({ queryKey: ['device', device.id] })

  const testMut = useMutation({
    mutationFn: () => devicesApi.testConnection(device.id),
    onSuccess: (d: any) => message.success(
      d?.success
        ? t('devices.detail.actions_tab.toast.test_ok', { ms: d?.latency_ms ?? '?' })
        : t('devices.detail.actions_tab.toast.test_error', { error: d?.message || d?.error })
    ),
    onError: (e: any) => message.error(e?.response?.data?.detail || t('devices.detail.actions_tab.toast.test_failed')),
  })
  const infoMut = useMutation({
    mutationFn: () => devicesApi.fetchInfo(device.id),
    onSuccess: () => { message.success(t('devices.detail.actions_tab.toast.info_updated')); refresh() },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('devices.detail.actions_tab.toast.info_failed')),
  })
  const lifecycleMut = useMutation({
    mutationFn: (state: string) => devicesApi.updateLifecycle(device.id, state),
    onSuccess: () => { message.success(t('devices.detail.actions_tab.toast.lifecycle_updated')); refresh() },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('common.error')),
  })
  const deleteMut = useMutation({
    mutationFn: () => devicesApi.delete(device.id),
    onSuccess: () => {
      message.success(t('devices.deleted'))
      qc.invalidateQueries({ queryKey: ['devices'] })
      navigate('/devices')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('common.delete_failed')),
  })

  const ident = (
    <Space size={4}>
      <Tag color="blue" style={{ fontFamily: 'var(--font-mono, monospace)' }}>{device.hostname}</Tag>
      <code style={{ fontSize: 11 }}>{device.ip_address}</code>
    </Space>
  )

  return (
    <div style={{ padding: '8px 0 16px', maxWidth: 880 }}>
      {!canWrite && (
        <Alert
          type="info" showIcon style={{ marginBottom: 16, fontSize: 12 }}
          message={t('devices.detail.actions_tab.readonly_alert')}
        />
      )}

      <Card size="small" title={t('devices.detail.actions_tab.exec_title')} style={{ marginBottom: 16 }}>
        <Space wrap>
          <Tooltip title={t('devices.detail.actions_tab.tooltip_test')}>
            <Button icon={<ApiOutlined />} loading={testMut.isPending} onClick={() => testMut.mutate()}>
              {t('devices.test_connection')}
            </Button>
          </Tooltip>
          <Tooltip title={t('devices.detail.actions_tab.tooltip_info')}>
            <Button icon={<SyncOutlined />} disabled={!canWrite} loading={infoMut.isPending} onClick={() => infoMut.mutate()}>
              {t('devices.detail.actions_tab.btn_fetch_info')}
            </Button>
          </Tooltip>
          <Tooltip title={t('devices.detail.actions_tab.tooltip_backup_tab')}>
            <Button icon={<HeartOutlined />} onClick={() => navigate(`?tab=backup`)}>
              {t('devices.detail.actions_tab.btn_backup_tab')}
            </Button>
          </Tooltip>
        </Space>
      </Card>

      <Card size="small" title={t('devices.detail.overview.lifecycle')} style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select
            value={nextLifecycle}
            onChange={(v) => setNextLifecycle(v)}
            options={LIFECYCLE_OPTIONS}
            style={{ width: 280 }}
            disabled={!canWrite}
          />
          <Popconfirm
            title={<span>{ident} → <strong>{nextLifecycle}</strong> {t('devices.detail.actions_tab.lifecycle_confirm_suffix')}</span>}
            okText={t('devices.detail.actions_tab.update_ok')} onConfirm={() => lifecycleMut.mutate(nextLifecycle)}
            disabled={!canWrite || nextLifecycle === (device as any).lifecycle_status}
          >
            <Button type="primary" disabled={!canWrite || nextLifecycle === (device as any).lifecycle_status} loading={lifecycleMut.isPending}>
              {t('common.apply')}
            </Button>
          </Popconfirm>
        </Space>
      </Card>

      <Card size="small" title={t('devices.detail.actions_tab.place_archive_title')} style={{ marginBottom: 16 }}>
        <Space wrap>
          <Tooltip title={t('devices.detail.actions_tab.tooltip_move_location')}>
            <Button icon={<EnvironmentOutlined />} disabled={!canWrite}
              onClick={() => message.info(t('devices.detail.actions_tab.move_info'))}>
              {t('devices.row.move_location')}
            </Button>
          </Tooltip>
          <Popconfirm
            title={<span>{ident} {t('devices.detail.actions_tab.archive_confirm_suffix')}</span>}
            okText={t('devices.card.archive_ok')} onConfirm={() => lifecycleMut.mutate('archived')}
            disabled={!canWrite}
          >
            <Button icon={<InboxOutlined />} disabled={!canWrite}>{t('devices.card.archive_ok')}</Button>
          </Popconfirm>
        </Space>
      </Card>

      <Card size="small" title={<span style={{ color: '#cf1322' }}>{t('devices.detail.actions_tab.danger_zone')}</span>}
        styles={{ header: { background: '#fff1f0' } }} style={{ marginBottom: 16 }}>
        <Space wrap>
          <Popconfirm
            title={<span>{ident} <strong>{t('devices.detail.actions_tab.delete_strong')}</strong> {t('devices.detail.actions_tab.delete_confirm_suffix')}</span>}
            okText={t('common.delete')} okButtonProps={{ danger: true }}
            onConfirm={() => deleteMut.mutate()}
            disabled={!canWrite}
          >
            <Button icon={<DeleteOutlined />} danger disabled={!canWrite} loading={deleteMut.isPending}>
              {t('devices.detail.actions_tab.btn_delete_device')}
            </Button>
          </Popconfirm>
          <Button icon={<ReloadOutlined />} onClick={refresh}>
            {t('devices.detail.actions_tab.btn_refresh_page')}
          </Button>
        </Space>
      </Card>
    </div>
  )
}
