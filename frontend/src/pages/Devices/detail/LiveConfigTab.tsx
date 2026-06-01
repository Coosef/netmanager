/**
 * T10 C7 Dalga 1 — Device Detail > Backup > Canlı Config alt-modu.
 *
 * BackupTab içinde "Canlı / Yedekler" alt-tab'ından çağrılır. Cihazın canlı
 * running-config'ini SSH ile çeker, kopyalama + Güvenlik Tarama (policy check)
 * sunar. Eski DeviceDetail modal "Canlı Config" sekmesinin port edilmiş hâli.
 *
 * RBAC: canConnect (devices.connect) — viewer için butonlar gizli ama config
 * yine de görünür (okuma yetkisi backend tarafından kontrol).
 */
import { useState } from 'react'
import {
  Alert, Button, Space, Typography, Spin, Modal, Tag, Table, Progress, App, Tooltip,
} from 'antd'
import {
  ReloadOutlined, CopyOutlined, SafetyCertificateOutlined, WarningOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Device } from '@/types'
import { devicesApi } from '@/api/devices'
import { useAuthStore } from '@/store/auth'
import { apiErr } from '@/utils/apiError'

const { Text } = Typography

export default function LiveConfigTab({ device }: { device: Device }) {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const canConnect = useAuthStore((s) => s.can('devices', 'connect'))
  const [policyOpen, setPolicyOpen] = useState(false)

  const q = useQuery({
    queryKey: ['device-config', device.id],
    queryFn: () => devicesApi.getConfig(device.id),
    enabled: device.id > 0,
    staleTime: 60_000,
  })

  const checkPolicyMut = useMutation({
    mutationFn: () => devicesApi.checkConfigPolicy(device.id),
    onSuccess: () => setPolicyOpen(true),
    onError: (e: any) => message.error(apiErr(e, 'Politika kontrolü başarısız')),
  })

  const success = q.data?.success !== false
  const config = q.data?.config || ''

  const copyConfig = async () => {
    if (!config) return
    try {
      await navigator.clipboard.writeText(config)
      message.success('Config panoya kopyalandı')
    } catch {
      message.error('Kopyalama başarısız (tarayıcı izni?)')
    }
  }

  const refresh = () => qc.invalidateQueries({ queryKey: ['device-config', device.id] })

  return (
    <div style={{ padding: '8px 0 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <Text strong>Canlı running-config</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {q.isFetching ? 'çekiliyor…' : success && config ? `${config.split('\n').length} satır` : ''}
        </Text>
        <Space style={{ marginLeft: 'auto' }}>
          <Button icon={<ReloadOutlined />} onClick={refresh} loading={q.isLoading || q.isFetching}>
            Yenile
          </Button>
          <Button icon={<CopyOutlined />} onClick={copyConfig} disabled={!config}>
            Kopyala
          </Button>
          {canConnect && (
            <Tooltip title={!config && !q.isLoading
              ? 'Cihaz canlı config çekemedi; yine de tetiklerseniz backend SSH ile yeniden dener.'
              : 'Politika kurallarına göre running-config taraması yapar.'}>
              <Button
                type="primary"
                icon={<SafetyCertificateOutlined />}
                loading={checkPolicyMut.isPending}
                onClick={() => checkPolicyMut.mutate()}
              >
                Güvenlik Tarama
              </Button>
            </Tooltip>
          )}
        </Space>
      </div>

      {!q.isLoading && !success && (
        <Alert
          type="warning" showIcon style={{ marginBottom: 12 }}
          message="Cihaz erişilemez (running-config çekilemedi)"
          description={q.data?.error || 'SSH yanıt vermedi.'}
        />
      )}

      <Spin spinning={q.isLoading}>
        {config ? (
          <pre style={{
            background: 'var(--bg-1, #0d1117)',
            color: 'var(--fg-0, #c9d1d9)',
            border: '1px solid var(--line-soft, #1e2a3a)',
            borderRadius: 6,
            padding: 12,
            fontSize: 12,
            fontFamily: 'var(--font-mono, ui-monospace, "JetBrains Mono", monospace)',
            maxHeight: 'calc(100vh - 320px)',
            overflow: 'auto',
            margin: 0,
            whiteSpace: 'pre',
          }}>{config}</pre>
        ) : !q.isLoading && success ? (
          <Text type="secondary">Boş config döndü.</Text>
        ) : null}
      </Spin>

      {/* Security Policy Check Modal — eski DeviceDetail.tsx:1812-1865 port */}
      <Modal
        title={<Space><SafetyCertificateOutlined /> Güvenlik Politika Kontrolü — {device.hostname}</Space>}
        open={policyOpen}
        onCancel={() => setPolicyOpen(false)}
        footer={<Button onClick={() => setPolicyOpen(false)}>Kapat</Button>}
        width={640}
      >
        {checkPolicyMut.data && (() => {
          const d = checkPolicyMut.data
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
    </div>
  )
}
