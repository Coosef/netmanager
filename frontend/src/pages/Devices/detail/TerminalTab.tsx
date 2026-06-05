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
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
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
        setPendingConfirm({ cmd, warning: res.warning || t('devices.detail.terminal.default_confirm_warning') })
        return
      }
      if ((res as any).needs_approval) {
        const r = res as any
        setTerminalHistory((h) => [...h, {
          cmd,
          output: t('devices.detail.terminal.approval_message', { id: r.request_id, risk: (r.risk_level || '').toUpperCase() }),
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
        output: e?.response?.data?.detail || t('common.error'),
        ok: false,
      }])
    },
  })

  const readonlyMut = useMutation({
    mutationFn: (is_readonly: boolean) => devicesApi.setReadonly(device.id, is_readonly),
    onSuccess: (updated) => {
      setLocalDevice(updated)
      qc.invalidateQueries({ queryKey: ['device', device.id] })
      message.success(updated.is_readonly
        ? t('devices.detail.terminal.toast.readonly_on')
        : t('devices.detail.terminal.toast.write_on'))
    },
    onError: (e: any) => message.error(apiErr(e, t('devices.detail.terminal.toast.toggle_failed'))),
  })

  const approvalMut = useMutation({
    mutationFn: (approval_required: boolean) =>
      devicesApi.update(device.id, { approval_required }),
    onSuccess: (updated) => {
      setLocalDevice(updated)
      qc.invalidateQueries({ queryKey: ['device', device.id] })
      message.success(updated.approval_required
        ? t('devices.detail.terminal.toast.approval_on')
        : t('devices.detail.terminal.toast.approval_off'))
    },
    onError: (e: any) => message.error(apiErr(e, t('devices.detail.terminal.toast.toggle_failed'))),
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
          message={t('devices.detail.terminal.no_access_title')}
          description={t('devices.detail.terminal.no_access_desc')}
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
          <Radio.Button value="repl"><CodeOutlined /> {t('devices.detail.terminal.mode_repl')}</Radio.Button>
          <Radio.Button value="ssh"><DesktopOutlined /> {t('devices.detail.terminal.mode_ssh')}</Radio.Button>
        </Radio.Group>
        {mode === 'repl' && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('devices.detail.terminal.mode_repl_desc')}
          </Text>
        )}
        {mode === 'ssh' && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('devices.detail.terminal.mode_ssh_desc')}
          </Text>
        )}
      </div>

      {mode === 'repl' ? (
        <>
          <Space style={{ marginBottom: 8, width: '100%', justifyContent: 'space-between' }} align="center" wrap>
            <Space.Compact style={{ flex: 1, minWidth: 320 }}>
              <Input
                placeholder={localDevice.is_readonly
                  ? t('devices.detail.terminal.input_placeholder_readonly')
                  : t('devices.detail.terminal.input_placeholder_write')}
                value={terminalCmd}
                onChange={(e) => setTerminalCmd(e.target.value)}
                onPressEnter={() => submitCmd(terminalCmd)}
                prefix={<span style={{ color: '#888', fontFamily: 'monospace' }}>#</span>}
                disabled={runCmdMut.isPending}
              />
              <Button type="primary" icon={<SendOutlined />} loading={runCmdMut.isPending}
                onClick={() => submitCmd(terminalCmd)}>
                {t('devices.detail.terminal.run_btn')}
              </Button>
              {terminalHistory.length > 0 && (
                <Button onClick={() => setTerminalHistory([])}>{t('devices.detail.terminal.clear_btn')}</Button>
              )}
            </Space.Compact>
            <Space size={8}>
              <Tooltip title={localDevice.is_readonly
                ? t('devices.detail.terminal.readonly_tooltip_on')
                : t('devices.detail.terminal.readonly_tooltip_off')}>
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
                  {localDevice.is_readonly ? t('devices.form.readonly_on') : t('devices.detail.terminal.btn_write_mode')}
                </Button>
              </Tooltip>
              <Tooltip title={(localDevice as any).approval_required
                ? t('devices.detail.terminal.approval_tooltip_on')
                : t('devices.detail.terminal.approval_tooltip_off')}>
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
                  {(localDevice as any).approval_required ? t('devices.detail.terminal.btn_four_eyes') : t('devices.form.approval_off')}
                </Button>
              </Tooltip>
            </Space>
          </Space>
          {/* KURAL-E2: Terminal komutları + çıktıları çevrilmez (CLI literal). */}
          <div style={{
            background: '#1e1e1e', borderRadius: 6, padding: 12,
            minHeight: 280, maxHeight: 'calc(100vh - 360px)', overflow: 'auto',
            fontFamily: 'var(--font-mono, ui-monospace, "JetBrains Mono", monospace)',
            fontSize: 12,
          }}>
            {terminalHistory.length === 0 ? (
              <span style={{ color: '#666' }}>{t('devices.detail.terminal.empty_hint')}</span>
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
            title={<Space><WarningOutlined style={{ color: '#faad14' }} /> {t('devices.detail.terminal.confirm_modal_title')}</Space>}
            open={!!pendingConfirm}
            onOk={() => {
              if (pendingConfirm) {
                submitCmd(pendingConfirm.cmd, true)
                setPendingConfirm(null)
              }
            }}
            onCancel={() => setPendingConfirm(null)}
            okText={t('devices.detail.terminal.confirm_ok')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
          >
            <p>{pendingConfirm?.warning}</p>
            <p>{t('devices.detail.terminal.command_label')}: <code style={{ background: '#1e1e1e', color: '#4ec9b0', padding: '2px 6px', borderRadius: 4 }}>{pendingConfirm?.cmd}</code></p>
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
