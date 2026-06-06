// Settings → Çok Faktörlü Doğrulama tab.
//
// State machine on the page tracks the enrollment lifecycle:
//
//   idle      → MFA off, primary CTA "MFA'yı Aç" → triggers /enroll/totp
//   enrolling → server returned a pending secret + otpauth URI; QR + manual
//               setup key shown, user enters first 6-digit code → /confirm
//   showing   → confirm succeeded, server returned 10 plaintext recovery
//               codes ONCE; user must download/print before navigating off
//   enabled   → MFA on; status card + Disable / Regenerate actions
//
// We deliberately don't re-fetch the secret if the user navigates back to
// the page mid-enrollment — they'd see a different QR than the one in
// their authenticator, breaking setup. Insted "MFA'yı Aç" always starts
// a fresh enroll which overwrites pending_secret server-side.
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Alert, Button, Card, Input, Modal, QRCode, Space, Tag, Typography, message,
} from 'antd'
import {
  CheckCircleFilled, CopyOutlined, DownloadOutlined, KeyOutlined, LockOutlined,
  SafetyOutlined, SyncOutlined, WarningFilled,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { mfaApi } from '@/api/mfa'
import MfaEmailCard from '@/pages/Settings/MfaEmailCard'

const { Title, Text, Paragraph } = Typography

function chunkSecret(secret: string): string {
  // Authenticator apps accept whitespace; humans read 4-char groups easier.
  return secret.replace(/(.{4})/g, '$1 ').trim()
}

export default function MfaTab() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const { data: status, isLoading } = useQuery({
    queryKey: ['mfa-status'],
    queryFn: () => mfaApi.status(),
  })

  // Enrollment local state — never persisted; lost on page leave.
  const [enrollSecret, setEnrollSecret] = useState<string | null>(null)
  const [enrollUri, setEnrollUri] = useState<string | null>(null)
  const [confirmCode, setConfirmCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  // Disable + regenerate dialogs
  const [disableOpen, setDisableOpen] = useState(false)
  const [regenOpen, setRegenOpen] = useState(false)
  const [disablePwd, setDisablePwd] = useState('')
  const [disableCode, setDisableCode] = useState('')
  const [regenCode, setRegenCode] = useState('')

  const enrollM = useMutation({
    mutationFn: () => mfaApi.enrollTotp(),
    onSuccess: (r) => {
      setEnrollSecret(r.secret)
      setEnrollUri(r.otpauth_uri)
      setConfirmCode('')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('settings.mfa.toast.enroll_failed')),
  })

  const confirmM = useMutation({
    mutationFn: (code: string) => mfaApi.confirm(code),
    onSuccess: (r) => {
      setRecoveryCodes(r.recovery_codes)
      setEnrollSecret(null)
      setEnrollUri(null)
      setConfirmCode('')
      qc.invalidateQueries({ queryKey: ['mfa-status'] })
      message.success(t('settings.mfa.toast.enabled'))
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('settings.mfa.toast.invalid_code')),
  })

  const disableM = useMutation({
    mutationFn: () => mfaApi.disable(disablePwd, disableCode || undefined),
    onSuccess: () => {
      setDisableOpen(false); setDisablePwd(''); setDisableCode('')
      setRecoveryCodes(null)
      qc.invalidateQueries({ queryKey: ['mfa-status'] })
      message.success(t('settings.mfa.toast.disabled'))
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('settings.mfa.toast.disable_failed')),
  })

  const regenM = useMutation({
    mutationFn: () => mfaApi.regenerateRecoveryCodes(regenCode),
    onSuccess: (r) => {
      setRecoveryCodes(r.recovery_codes)
      setRegenOpen(false); setRegenCode('')
      qc.invalidateQueries({ queryKey: ['mfa-status'] })
      message.success(t('settings.mfa.toast.regen_ok'))
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('settings.mfa.toast.regen_failed')),
  })

  // Friendly setup-key form for manual entry into the authenticator app.
  const formattedSecret = useMemo(
    () => enrollSecret ? chunkSecret(enrollSecret) : '',
    [enrollSecret],
  )

  const copySecret = async () => {
    if (!enrollSecret) return
    await navigator.clipboard.writeText(enrollSecret)
    message.success(t('settings.mfa.toast.secret_copied'))
  }

  const downloadRecovery = () => {
    if (!recoveryCodes?.length) return
    // KURAL: marka adı "Charon" literal kalır
    const blob = new Blob(
      [`Charon — ${t('settings.mfa.recovery.file_title')}\n` +
       `${t('settings.mfa.recovery.file_created_at')}: ${new Date().toISOString()}\n` +
       `${t('settings.mfa.recovery.file_one_time_notice')}\n\n` +
       recoveryCodes.map((c, i) => `${String(i + 1).padStart(2, '0')}.  ${c}`).join('\n')],
      { type: 'text/plain;charset=utf-8' },
    )
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `charon-mfa-recovery-${Date.now()}.txt`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // Reset enrollment view if the user toggles MFA off elsewhere
  useEffect(() => {
    if (status?.mfa_enabled === false) { setEnrollSecret(null); setEnrollUri(null) }
  }, [status?.mfa_enabled])

  if (isLoading) return <Card loading />

  // ── ENABLED state ─────────────────────────────────────────────────────────
  if (status?.mfa_enabled) {
    return (
      <Card title={<Space><SafetyOutlined style={{ color: 'var(--ok)' }} /> {t('settings.mfa.section_title')}</Space>}>
        <Alert
          type="success"
          showIcon
          icon={<CheckCircleFilled />}
          message={t('settings.mfa.enabled_title')}
          description={
            <>
              {t('settings.mfa.enabled_desc')}
              {status.enrolled_at && (
                <> {t('settings.mfa.enrolled_at_label')}: <Text type="secondary">{new Date(status.enrolled_at).toLocaleString('tr-TR')}</Text></>
              )}
            </>
          }
          style={{ marginBottom: 16 }}
        />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 16 }}>
          <Card size="small">
            <Text type="secondary" style={{ fontSize: 11 }}>{t('settings.mfa.methods_label')}</Text>
            <div style={{ fontSize: 14, marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {status.methods.includes('totp') && <Tag color="green">{t('settings.mfa.method.authenticator')}</Tag>}
              {status.methods.includes('email') && <Tag color="cyan">Email</Tag>}
              {status.methods.includes('sms') && <Tag color="blue">SMS</Tag>}
            </div>
          </Card>
          <Card size="small">
            <Text type="secondary" style={{ fontSize: 11 }}>{t('settings.mfa.recovery_remaining_label')}</Text>
            <div style={{ fontSize: 22, marginTop: 4, fontWeight: 500 }}>
              {status.recovery_codes_remaining} / 10
              {status.recovery_codes_remaining <= 3 && (
                <Tag color="orange" style={{ marginLeft: 8 }}>{t('settings.mfa.tag_running_out')}</Tag>
              )}
            </div>
          </Card>
        </div>

        {/* T9 Tur 2 #2b — Email MFA kanalı */}
        <div style={{ marginBottom: 16 }}>
          <MfaEmailCard
            methods={status.methods}
            onRecoveryCodes={(codes) => setRecoveryCodes(codes)}
          />
        </div>

        {recoveryCodes && (
          <RecoveryCodesPanel codes={recoveryCodes} onDownload={downloadRecovery} onClose={() => setRecoveryCodes(null)} />
        )}

        <Space>
          <Button icon={<SyncOutlined />} onClick={() => setRegenOpen(true)}>
            {t('settings.mfa.btn_regen_recovery')}
          </Button>
          <Button danger icon={<LockOutlined />} onClick={() => setDisableOpen(true)}>
            {t('settings.mfa.btn_disable')}
          </Button>
        </Space>

        <Modal
          title={<Space><LockOutlined /> {t('settings.mfa.btn_disable')}</Space>}
          open={disableOpen}
          onCancel={() => setDisableOpen(false)}
          onOk={() => disableM.mutate()}
          okText={t('common.close')} okButtonProps={{ danger: true, loading: disableM.isPending,
            disabled: !disablePwd }}
          cancelText={t('common.cancel')}
        >
          <Alert type="warning" showIcon message={t('settings.mfa.disable_warning')}
            style={{ marginBottom: 12 }} />
          <Space direction="vertical" style={{ width: '100%' }}>
            <Input.Password placeholder={t('common.password')} value={disablePwd}
              onChange={(e) => setDisablePwd(e.target.value)} autoFocus />
            <Input placeholder={t('settings.mfa.disable_code_placeholder')} value={disableCode}
              onChange={(e) => setDisableCode(e.target.value)} />
          </Space>
        </Modal>

        <Modal
          title={<Space><SyncOutlined /> {t('settings.mfa.btn_regen_recovery')}</Space>}
          open={regenOpen}
          onCancel={() => setRegenOpen(false)}
          onOk={() => regenM.mutate()}
          okText={t('settings.mfa.btn_regen_short')} okButtonProps={{ loading: regenM.isPending, disabled: regenCode.length !== 6 }}
          cancelText={t('common.cancel')}
        >
          <Alert type="info" showIcon message={t('settings.mfa.regen_warning')}
            style={{ marginBottom: 12 }} />
          <Input placeholder={t('settings.mfa.regen_code_placeholder')} value={regenCode} maxLength={6}
            onChange={(e) => setRegenCode(e.target.value.replace(/\D/g, ''))} />
        </Modal>
      </Card>
    )
  }

  // ── ENROLLING state (we have a pending secret) ────────────────────────────
  if (enrollSecret && enrollUri) {
    return (
      <Card title={<Space><KeyOutlined /> {t('settings.mfa.setup_title')}</Space>}>
        <Paragraph type="secondary">
          {t('settings.mfa.setup_intro_prefix')}<Text strong>Google Authenticator · Microsoft Authenticator · Authy · 1Password</Text>{t('settings.mfa.setup_intro_suffix')}
        </Paragraph>

        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 24, alignItems: 'center', marginBottom: 20 }}>
          <div style={{ background: '#fff', padding: 10, borderRadius: 6, display: 'inline-block' }}>
            <QRCode value={enrollUri} size={184} bordered={false} />
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 11, letterSpacing: 1 }}>{t('settings.mfa.setup_key_label')}</Text>
            <div className="mono" style={{
              fontSize: 16, letterSpacing: 1.5, padding: '10px 12px',
              background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 4,
              marginTop: 6, fontFamily: 'IBM Plex Mono, monospace', wordBreak: 'break-all',
            }}>{formattedSecret}</div>
            <Button type="text" icon={<CopyOutlined />} size="small" onClick={copySecret} style={{ marginTop: 4 }}>
              {t('settings.mfa.btn_copy_secret')}
            </Button>
            <Paragraph type="secondary" style={{ fontSize: 11, marginTop: 10, marginBottom: 0 }}>
              {t('settings.mfa.setup_qr_fallback_hint')}
            </Paragraph>
          </div>
        </div>

        <Title level={5} style={{ marginTop: 0 }}>{t('settings.mfa.setup_step2_title')}</Title>
        <Space>
          <Input
            value={confirmCode}
            onChange={(e) => setConfirmCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder={t('settings.mfa.code_6_placeholder')}
            maxLength={6}
            style={{ width: 180, fontSize: 18, letterSpacing: 4, textAlign: 'center', fontFamily: 'IBM Plex Mono, monospace' }}
            autoFocus
            onPressEnter={() => confirmCode.length === 6 && confirmM.mutate(confirmCode)}
          />
          <Button type="primary" loading={confirmM.isPending}
            disabled={confirmCode.length !== 6}
            onClick={() => confirmM.mutate(confirmCode)}>
            {t('settings.mfa.btn_confirm_enable')}
          </Button>
          <Button onClick={() => { setEnrollSecret(null); setEnrollUri(null); setConfirmCode('') }}>
            {t('common.cancel')}
          </Button>
        </Space>
      </Card>
    )
  }

  // ── IDLE state ────────────────────────────────────────────────────────────
  return (
    <Card title={<Space><SafetyOutlined /> {t('settings.mfa.section_title')}</Space>}>
      <Alert
        type="warning"
        showIcon
        icon={<WarningFilled />}
        message={t('settings.mfa.idle_title')}
        description={t('settings.mfa.idle_desc')}
        style={{ marginBottom: 16 }}
      />

      {recoveryCodes && (
        <RecoveryCodesPanel codes={recoveryCodes} onDownload={downloadRecovery} onClose={() => setRecoveryCodes(null)} />
      )}

      <Button type="primary" size="large" icon={<KeyOutlined />}
        loading={enrollM.isPending}
        onClick={() => enrollM.mutate()}>
        {t('settings.mfa.btn_enable')}
      </Button>
    </Card>
  )
}

function RecoveryCodesPanel({
  codes, onDownload, onClose,
}: { codes: string[]; onDownload: () => void; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <Alert
      type="info"
      style={{ marginBottom: 16 }}
      message={<Space><SafetyOutlined /> {t('settings.mfa.recovery.panel_title')}</Space>}
      description={
        <div>
          <Paragraph style={{ marginBottom: 8 }}>
            {t('settings.mfa.recovery.panel_intro_pre')}<strong>{t('settings.mfa.recovery.panel_recovery_word')}</strong>{t('settings.mfa.recovery.panel_intro_mid')}<strong>{t('settings.mfa.recovery.panel_one_time')}</strong>{t('settings.mfa.recovery.panel_intro_post')}
          </Paragraph>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6,
            background: 'var(--bg-2)', padding: 12, borderRadius: 4,
            fontFamily: 'IBM Plex Mono, monospace', fontSize: 13.5, letterSpacing: 1,
          }}>
            {codes.map((c, i) => (
              <div key={c}>
                <Text type="secondary" style={{ fontSize: 11, marginRight: 8 }}>{String(i + 1).padStart(2, '0')}</Text>
                {c}
              </div>
            ))}
          </div>
          <Space style={{ marginTop: 12 }}>
            <Button icon={<DownloadOutlined />} onClick={onDownload}>{t('settings.mfa.recovery.btn_download_txt')}</Button>
            <Button onClick={onClose}>{t('settings.mfa.recovery.btn_saved_close')}</Button>
          </Space>
        </div>
      }
    />
  )
}
