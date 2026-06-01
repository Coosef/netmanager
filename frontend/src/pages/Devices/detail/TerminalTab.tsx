/**
 * T10 C7 Dalga 1 — Device Detail > Terminal sekmesi (HİBRİT: REPL + Canlı SSH).
 *
 * Üstte Radio.Group ile iki mod:
 *  - "Komut" (REPL, default) — eski DeviceDetail.tsx:702-820 pattern'ı:
 *    · devicesApi.runCommand HTTP komut-by-komut
 *    · history (cmd/output/ok renkli)
 *    · readonly toggle (devicesApi.setReadonly)
 *    · approval toggle (devicesApi.update {approval_required})
 *    · needs_confirm modal flow + needs_approval mesajı (audit trail)
 *  - "Canlı SSH" (xterm) — components/SshTerminal.tsx embed:
 *    · /api/v1/ws/ssh/:id WebSocket, escape sequences + color
 *    · readonly/approval YOK — ham SSH (use case: vim/htop/interactive)
 *
 * Mode değişiminde SshTerminal unmount → useEffect cleanup WS dispose + term.dispose
 * (component zaten doğru kodlu, ek state guard gerekmez).
 *
 * RBAC: canConnect (devices.connect) — viewer için sekme içeriği "Yetki yok" Alert'i.
 * Detail Page _tabs.ts'de RoleRoute viewer+ ile sarılı; her durumda tab görünür ama
 * içerik canConnect false ise gizlenir.
 */
import { useEffect, useState } from 'react'
import {
  Radio, Input, Button, Space, Tooltip, Modal, Alert, App, Typography,
} from 'antd'
import {
  CodeOutlined, SendOutlined, SafetyCertificateOutlined, WarningOutlined,
  DesktopOutlined,
} from '@ant-design/icons'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Device } from '@/types'
import { devicesApi } from '@/api/devices'
import { useAuthStore } from '@/store/auth'
import { useTheme } from '@/contexts/ThemeContext'
import { apiErr } from '@/utils/apiError'
import SshTerminal from '@/components/SshTerminal'

const { Text } = Typography

interface HistoryEntry {
  cmd: string
  output: string
  ok: boolean
  approval?: boolean
}

type Mode = 'repl' | 'ssh'

export default function TerminalTab({ device }: { device: Device }) {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const canConnect = useAuthStore((s) => s.can('devices', 'connect'))
  const { isDark } = useTheme()

  const [mode, setMode] = useState<Mode>('repl')
  const [terminalCmd, setTerminalCmd] = useState('')
  const [terminalHistory, setTerminalHistory] = useState<HistoryEntry[]>([])
  const [pendingConfirm, setPendingConfirm] = useState<{ cmd: string; warning: string } | null>(null)
  // Local optimistic copy of device flags so readonly/approval toggles render instantly
  // without waiting for parent invalidation round-trip.
  const [localDevice, setLocalDevice] = useState<Device>(device)
  useEffect(() => { setLocalDevice(device) }, [device])

  const runCmdMut = useMutation({
    mutationFn: ({ cmd, confirm }: { cmd: string; confirm?: boolean }) =>
      devicesApi.runCommand(device.id, cmd, confirm),
    onSuccess: (res, { cmd }) => {
      if (res.needs_confirm) {
        setPendingConfirm({ cmd, warning: res.warning || 'Bu komut yapılandırmayı değiştirir.' })
        return
      }
      if ((res as any).needs_approval) {
        const r = res as any
        setTerminalHistory((h) => [...h, {
          cmd,
          output: `[ONAY GEREKLİ] Talep #${r.request_id} oluşturuldu. Admin onayı bekleniyor.\nRisk: ${(r.risk_level || '').toUpperCase()}`,
          ok: false,
          approval: true,
        }])
        setTerminalCmd('')
        return
      }
      setTerminalHistory((h) => [...h, {
        cmd,
        output: res.output || res.error || '',
        ok: !!res.success,
      }])
      setTerminalCmd('')
    },
    onError: (e: any, { cmd }) => {
      setTerminalHistory((h) => [...h, {
        cmd,
        output: e?.response?.data?.detail || 'Hata',
        ok: false,
      }])
    },
  })

  const readonlyMut = useMutation({
    mutationFn: (is_readonly: boolean) => devicesApi.setReadonly(device.id, is_readonly),
    onSuccess: (updated) => {
      setLocalDevice(updated)
      qc.invalidateQueries({ queryKey: ['device', device.id] })
      message.success(updated.is_readonly ? 'Salt-okunur mod aktif' : 'Yazma modu aktif')
    },
    onError: (e: any) => message.error(apiErr(e, 'Değiştirilemedi')),
  })

  const approvalMut = useMutation({
    mutationFn: (approval_required: boolean) =>
      devicesApi.update(device.id, { approval_required }),
    onSuccess: (updated) => {
      setLocalDevice(updated)
      qc.invalidateQueries({ queryKey: ['device', device.id] })
      message.success(updated.approval_required ? 'Onay akışı aktif' : 'Onay akışı devre dışı')
    },
    onError: (e: any) => message.error(apiErr(e, 'Değiştirilemedi')),
  })

  const submitCmd = (cmd: string, confirm = false) => {
    if (!cmd.trim()) return
    runCmdMut.mutate({ cmd: cmd.trim(), confirm })
  }

  if (!canConnect) {
    return (
      <div style={{ padding: '16px 0' }}>
        <Alert
          type="warning" showIcon
          message="Terminal erişimi için yetki yok"
          description="Bu cihazda komut çalıştırmak veya canlı SSH oturumu açmak için 'devices.connect' yetkisi gerekir. org_admin+ rolü ile tekrar deneyin."
        />
      </div>
    )
  }

  return (
    <div style={{ padding: '8px 0 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <Radio.Group
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
          optionType="button"
          buttonStyle="solid"
        >
          <Radio.Button value="repl"><CodeOutlined /> Komut (REPL)</Radio.Button>
          <Radio.Button value="ssh"><DesktopOutlined /> Canlı SSH</Radio.Button>
        </Radio.Group>
        {mode === 'repl' && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            Audit-edilebilir komut akışı (onay + readonly + risk değerlendirme)
          </Text>
        )}
        {mode === 'ssh' && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            Tam interactive SSH (vim/htop). Onay/audit BU akışta YOK.
          </Text>
        )}
      </div>

      {mode === 'repl' ? (
        <>
          <Space style={{ marginBottom: 8, width: '100%', justifyContent: 'space-between' }} align="center" wrap>
            <Space.Compact style={{ flex: 1, minWidth: 320 }}>
              <Input
                placeholder={localDevice.is_readonly
                  ? 'show komut girin… (salt-okunur mod)'
                  : 'komut girin… (yazma modu aktif)'}
                value={terminalCmd}
                onChange={(e) => setTerminalCmd(e.target.value)}
                onPressEnter={() => submitCmd(terminalCmd)}
                prefix={<span style={{ color: '#888', fontFamily: 'monospace' }}>#</span>}
                disabled={runCmdMut.isPending}
              />
              <Button type="primary" icon={<SendOutlined />} loading={runCmdMut.isPending}
                onClick={() => submitCmd(terminalCmd)}>
                Çalıştır
              </Button>
              {terminalHistory.length > 0 && (
                <Button onClick={() => setTerminalHistory([])}>Temizle</Button>
              )}
            </Space.Compact>
            <Space size={8}>
              <Tooltip title={localDevice.is_readonly
                ? 'Salt-okunur: sadece show/ping komutları. Tıkla → yazma moduna geç.'
                : 'Yazma modu: config komutları aktif. Tıkla → salt-okunura dön.'}>
                <Button
                  size="small"
                  icon={localDevice.is_readonly ? <SafetyCertificateOutlined /> : <WarningOutlined />}
                  loading={readonlyMut.isPending}
                  onClick={() => readonlyMut.mutate(!localDevice.is_readonly)}
                  style={{
                    color: localDevice.is_readonly ? '#52c41a' : '#faad14',
                    borderColor: localDevice.is_readonly ? '#52c41a' : '#faad14',
                  }}
                >
                  {localDevice.is_readonly ? 'Salt-okunur' : 'Yazma Modu'}
                </Button>
              </Tooltip>
              <Tooltip title={(localDevice as any).approval_required
                ? 'Onay akışı: config komutları admin onayına gider. Tıkla → devre dışı bırak.'
                : 'Onay akışı devre dışı. Tıkla → config komutlarını admin onayına gönder.'}>
                <Button
                  size="small"
                  icon={<SafetyCertificateOutlined />}
                  loading={approvalMut.isPending}
                  onClick={() => approvalMut.mutate(!(localDevice as any).approval_required)}
                  style={{
                    color: (localDevice as any).approval_required ? '#3b82f6' : '#94a3b8',
                    borderColor: (localDevice as any).approval_required ? '#3b82f6' : '#94a3b8',
                  }}
                >
                  {(localDevice as any).approval_required ? '4-Göz' : 'Serbest'}
                </Button>
              </Tooltip>
            </Space>
          </Space>
          <div style={{
            background: '#1e1e1e', borderRadius: 6, padding: 12,
            minHeight: 280, maxHeight: 'calc(100vh - 360px)', overflow: 'auto',
            fontFamily: 'var(--font-mono, ui-monospace, "JetBrains Mono", monospace)',
            fontSize: 12,
          }}>
            {terminalHistory.length === 0 ? (
              <span style={{ color: '#666' }}>Komut girin ve Enter'a basın…</span>
            ) : (
              terminalHistory.map((entry, idx) => (
                <div key={idx} style={{ marginBottom: 12 }}>
                  <div style={{ color: '#4ec9b0' }}># {entry.cmd}</div>
                  <pre style={{
                    color: entry.approval ? '#f59e0b' : entry.ok ? '#d4d4d4' : '#f48771',
                    margin: 0, whiteSpace: 'pre-wrap',
                  }}>
                    {entry.output}
                  </pre>
                </div>
              ))
            )}
          </div>

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
        </>
      ) : (
        // Canlı SSH (xterm WS embed)
        <div style={{
          border: '1px solid var(--line-soft, #1e2a3a)',
          borderRadius: 8, overflow: 'hidden',
          height: 'calc(100vh - 280px)', minHeight: 360,
        }}>
          <SshTerminal deviceId={device.id} isDark={isDark} />
        </div>
      )}
    </div>
  )
}
