import { useState } from 'react'
import { App, Modal, Select, Input, Typography, Alert } from 'antd'
import { useMutation, useQueryClient } from '@tanstack/react-query'
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
  const { locations } = useSite()
  const [target, setTarget] = useState<number | null>(null)
  const [reason, setReason] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      devicesApi.moveLocation(device.id, target as number, reason.trim() || undefined),
    onSuccess: () => {
      message.success('Cihaz yeni lokasyona taşındı')
      qc.invalidateQueries({ queryKey: ['devices'] })
      qc.invalidateQueries({ queryKey: ['devices-stats'] })
      onClose()
    },
    onError: (e: any) =>
      message.error(e?.response?.data?.detail || 'Taşıma işlemi başarısız'),
  })

  return (
    <Modal
      open
      title={`Cihazı Taşı — ${device.hostname}`}
      okText="Taşı"
      okButtonProps={{ disabled: target == null, loading: mutation.isPending }}
      onOk={() => mutation.mutate()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12, fontSize: 12 }}
        message="Cihazın lokasyon sahipliği yalnızca bu işlemle değişir."
        description="İşlem denetim kaydına yazılır; cihazın geçmiş verisi de yeni lokasyona taşınır."
      />
      <Typography.Text style={{ fontSize: 12 }}>Hedef lokasyon</Typography.Text>
      <Select
        style={{ width: '100%', margin: '4px 0 12px' }}
        placeholder="Hedef lokasyon seçin"
        value={target ?? undefined}
        onChange={setTarget}
        options={locations.map((l) => ({ value: l.id, label: l.name }))}
      />
      <Typography.Text style={{ fontSize: 12 }}>Sebep (opsiyonel)</Typography.Text>
      <Input.TextArea
        style={{ marginTop: 4 }}
        placeholder="Taşıma sebebi"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        maxLength={500}
      />
    </Modal>
  )
}
