import { useState } from 'react'
import { App, Modal, Select, Input, Typography, Alert } from 'antd'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { devicesApi } from '@/api/devices'
import { useSite } from '@/contexts/SiteContext'
import type { Device } from '@/types'

/**
 * Faz 8 Phase G — the audited device-location move dialog.
 *
 * A device's location ownership changes ONLY through this action (the
 * generic edit form can no longer touch it). The target options are the
 * caller's own accessible locations (user_locations, via SiteContext);
 * the backend re-validates source + target authorization and writes a
 * structured audit log. A reason is optional.
 */
export default function MoveDeviceModal({
  device,
  onClose,
}: {
  device: Device
  onClose: () => void
}) {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const { t } = useTranslation()
  const { locations } = useSite()
  const [target, setTarget] = useState<number | null>(null)
  const [reason, setReason] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      devicesApi.moveLocation(device.id, target as number, reason.trim() || undefined),
    onSuccess: () => {
      message.success(t('devices.move.toast_success'))
      qc.invalidateQueries({ queryKey: ['devices'] })
      qc.invalidateQueries({ queryKey: ['devices-stats'] })
      onClose()
    },
    onError: (e: any) =>
      message.error(e?.response?.data?.detail || t('devices.move.toast_failed')),
  })

  return (
    <Modal
      open
      title={t('devices.move.title', { hostname: device.hostname })}
      okText={t('devices.move.ok')}
      okButtonProps={{ disabled: target == null, loading: mutation.isPending }}
      onOk={() => mutation.mutate()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12, fontSize: 12 }}
        message={t('devices.move.warning_title')}
        description={t('devices.move.warning_desc')}
      />
      <Typography.Text style={{ fontSize: 12 }}>{t('devices.move.target_label')}</Typography.Text>
      <Select
        style={{ width: '100%', margin: '4px 0 12px' }}
        placeholder={t('devices.move.target_placeholder')}
        value={target ?? undefined}
        onChange={setTarget}
        options={locations.map((l) => ({ value: l.id, label: l.name }))}
      />
      <Typography.Text style={{ fontSize: 12 }}>{t('devices.move.reason_label')}</Typography.Text>
      <Input.TextArea
        style={{ marginTop: 4 }}
        placeholder={t('devices.move.reason_placeholder')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        maxLength={500}
      />
    </Modal>
  )
}
