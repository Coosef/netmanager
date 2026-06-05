/**
 * T10 C7 Dalga 1 — İki backup arası side-by-side Config Diff Drawer.
 *
 * BackupTab "Yedekler" alt-tab'ında multi-select + "Diff" butonundan açılır.
 * Lazy-load: caller `React.lazy()` ile import eder; react-diff-viewer-continued
 * (~30KB gzip) yalnız Drawer açılınca chunk indirilir, ana bundle'a girmez.
 *
 * Veri kaynakları:
 *  - devicesApi.getBackupContent(deviceId, fromId/toId) → split-view feed (2 paralel)
 *  - devicesApi.getConfigDiff(deviceId, fromId, toId)   → unified diff string + +/− sayıları
 *
 * Kullanıcı notu #3: Drawer header'ında "Kopyala" + "İndir (.diff)" butonları.
 */
import { useMemo } from 'react'
import {
  Drawer, Button, Tag, Space, Typography, Spin, Alert, App,
} from 'antd'
import { CopyOutlined, DownloadOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import type { Device, ConfigBackup } from '@/types'
import { devicesApi } from '@/api/devices'
import dayjs from 'dayjs'

const { Text } = Typography

interface Props {
  open: boolean
  onClose: () => void
  device: Device
  fromBackup: ConfigBackup | null
  toBackup: ConfigBackup | null
}

export default function DiffViewerDrawer({ open, onClose, device, fromBackup, toBackup }: Props) {
  const { message } = App.useApp()
  const { t } = useTranslation()
  const ready = open && !!fromBackup && !!toBackup

  const fromQ = useQuery({
    queryKey: ['backup-content', device.id, fromBackup?.id],
    queryFn: () => devicesApi.getBackupContent(device.id, fromBackup!.id),
    enabled: ready,
    staleTime: 5 * 60_000,
  })
  const toQ = useQuery({
    queryKey: ['backup-content', device.id, toBackup?.id],
    queryFn: () => devicesApi.getBackupContent(device.id, toBackup!.id),
    enabled: ready,
    staleTime: 5 * 60_000,
  })
  const diffQ = useQuery({
    queryKey: ['backup-diff', device.id, fromBackup?.id, toBackup?.id],
    queryFn: () => devicesApi.getConfigDiff(device.id, fromBackup!.id, toBackup!.id),
    enabled: ready,
    staleTime: 5 * 60_000,
  })

  const loading = fromQ.isLoading || toQ.isLoading || diffQ.isLoading
  const errored = fromQ.error || toQ.error || diffQ.error
  const oldValue = fromQ.data?.config || ''
  const newValue = toQ.data?.config || ''
  const unified = diffQ.data?.diff || ''
  const added = diffQ.data?.added ?? 0
  const removed = diffQ.data?.removed ?? 0
  const hasChanges = diffQ.data?.has_changes ?? false

  const filename = useMemo(() => {
    if (!fromBackup || !toBackup) return 'config.diff'
    const f = dayjs(fromBackup.created_at).format('YYYYMMDD_HHmm')
    const t = dayjs(toBackup.created_at).format('YYYYMMDD_HHmm')
    return `${device.hostname || 'device'}_${f}__to__${t}.diff`
  }, [fromBackup, toBackup, device.hostname])

  const copyDiff = async () => {
    if (!unified) return
    try {
      await navigator.clipboard.writeText(unified)
      message.success(t('devices.detail.diff.toast.copied'))
    } catch {
      message.error(t('devices.detail.live_config.toast.copy_failed'))
    }
  }

  const downloadDiff = () => {
    if (!unified) return
    const blob = new Blob([unified], { type: 'text/plain;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <Drawer
      title={
        <Space size={8} wrap>
          <span>{t('devices.detail.diff.title')}</span>
          {fromBackup && toBackup && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {dayjs(fromBackup.created_at).format('YYYY-MM-DD HH:mm')} → {dayjs(toBackup.created_at).format('YYYY-MM-DD HH:mm')}
            </Text>
          )}
          {hasChanges && (
            <>
              <Tag color="green">{t('devices.detail.backup.lines_added', { count: added })}</Tag>
              <Tag color="red">{t('devices.detail.backup.lines_removed', { count: removed })}</Tag>
            </>
          )}
          {!loading && !hasChanges && diffQ.data && <Tag>{t('devices.detail.diff.no_changes_tag')}</Tag>}
        </Space>
      }
      open={open}
      onClose={onClose}
      width={Math.min(1200, typeof window !== 'undefined' ? window.innerWidth - 60 : 1100)}
      extra={
        <Space>
          <Button icon={<CopyOutlined />} onClick={copyDiff} disabled={!unified}>
            {t('devices.detail.diff.copy_btn')}
          </Button>
          <Button icon={<DownloadOutlined />} onClick={downloadDiff} disabled={!unified}>
            {t('devices.detail.diff.download_btn')}
          </Button>
        </Space>
      }
    >
      {errored && (
        <Alert
          type="error" showIcon style={{ marginBottom: 12 }}
          message={t('devices.detail.diff.error_title')}
          description={(errored as any)?.message || t('devices.detail.diff.backend_no_response')}
        />
      )}

      <Spin spinning={loading}>
        {!loading && !errored && (
          hasChanges ? (
            <div style={{ fontSize: 12 }}>
              <ReactDiffViewer
                oldValue={oldValue}
                newValue={newValue}
                splitView
                compareMethod={DiffMethod.LINES}
                useDarkTheme
                leftTitle={fromBackup ? `#${fromBackup.id} · ${dayjs(fromBackup.created_at).format('YYYY-MM-DD HH:mm')}` : t('devices.detail.diff.left_default')}
                rightTitle={toBackup ? `#${toBackup.id} · ${dayjs(toBackup.created_at).format('YYYY-MM-DD HH:mm')}` : t('devices.detail.diff.right_default')}
              />
            </div>
          ) : (
            <Alert
              type="success" showIcon
              message={t('devices.detail.diff.no_changes_title')}
              description={t('devices.detail.diff.no_changes_desc')}
            />
          )
        )}
      </Spin>
    </Drawer>
  )
}
