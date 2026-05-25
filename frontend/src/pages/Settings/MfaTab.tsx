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
import { mfaApi } from '@/api/mfa'

const { Title, Text, Paragraph } = Typography

function chunkSecret(secret: string): string {
  // Authenticator apps accept whitespace; humans read 4-char groups easier.
  return secret.replace(/(.{4})/g, '$1 ').trim()
}

export default function MfaTab() {
  const qc = useQueryClient()
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
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Kayıt başlatılamadı'),
  })

  const confirmM = useMutation({
    mutationFn: (code: string) => mfaApi.confirm(code),
    onSuccess: (r) => {
      setRecoveryCodes(r.recovery_codes)
      setEnrollSecret(null)
      setEnrollUri(null)
      setConfirmCode('')
      qc.invalidateQueries({ queryKey: ['mfa-status'] })
      message.success('MFA aktif edildi — kurtarma kodlarınızı şimdi saklayın.')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Geçersiz kod'),
  })

  const disableM = useMutation({
    mutationFn: () => mfaApi.disable(disablePwd, disableCode || undefined),
    onSuccess: () => {
      setDisableOpen(false); setDisablePwd(''); setDisableCode('')
      setRecoveryCodes(null)
      qc.invalidateQueries({ queryKey: ['mfa-status'] })
      message.success('MFA devre dışı bırakıldı')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Devre dışı bırakılamadı'),
  })

  const regenM = useMutation({
    mutationFn: () => mfaApi.regenerateRecoveryCodes(regenCode),
    onSuccess: (r) => {
      setRecoveryCodes(r.recovery_codes)
      setRegenOpen(false); setRegenCode('')
      qc.invalidateQueries({ queryKey: ['mfa-status'] })
      message.success('Yeni kurtarma kodları üretildi — eskileri artık geçersiz.')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Yenileme başarısız'),
  })

  // Friendly setup-key form for manual entry into the authenticator app.
  const formattedSecret = useMemo(
    () => enrollSecret ? chunkSecret(enrollSecret) : '',
    [enrollSecret],
  )

  const copySecret = async () => {
    if (!enrollSecret) return
    await navigator.clipboard.writeText(enrollSecret)
    message.success('Anahtar kopyalandı')
  }

  const downloadRecovery = () => {
    if (!recoveryCodes?.length) return
    const blob = new Blob(
      [`Charon — MFA Kurtarma Kodları\n` +
       `Oluşturulma: ${new Date().toISOString()}\n` +
       `Her kod TEK KULLANIMLIKTIR. Authenticator erişimini kaybederseniz birini kullanın.\n\n` +
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
      <Card title={<Space><SafetyOutlined style={{ color: 'var(--ok)' }} /> Çok Faktörlü Doğrulama</Space>}>
        <Alert
          type="success"
          showIcon
          icon={<CheckCircleFilled />}
          message="MFA aktif"
          description={
            <>
              Her girişte authenticator uygulamanızdan 6-haneli kod istenir.
              {status.enrolled_at && (
                <> Kayıt: <Text type="secondary">{new Date(status.enrolled_at).toLocaleString('tr-TR')}</Text></>
              )}
            </>
          }
          style={{ marginBottom: 16 }}
        />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 16 }}>
          <Card size="small">
            <Text type="secondary" style={{ fontSize: 11 }}>YÖNTEM</Text>
            <div style={{ fontSize: 16, marginTop: 4 }}>
              {status.methods.includes('totp') && <Tag color="green">Authenticator (TOTP)</Tag>}
            </div>
          </Card>
          <Card size="small">
            <Text type="secondary" style={{ fontSize: 11 }}>KURTARMA KODU KALAN</Text>
            <div style={{ fontSize: 22, marginTop: 4, fontWeight: 500 }}>
              {status.recovery_codes_remaining} / 10
              {status.recovery_codes_remaining <= 3 && (
                <Tag color="orange" style={{ marginLeft: 8 }}>Azalıyor</Tag>
              )}
            </div>
          </Card>
        </div>

        {recoveryCodes && (
          <RecoveryCodesPanel codes={recoveryCodes} onDownload={downloadRecovery} onClose={() => setRecoveryCodes(null)} />
        )}

        <Space>
          <Button icon={<SyncOutlined />} onClick={() => setRegenOpen(true)}>
            Kurtarma kodlarını yenile
          </Button>
          <Button danger icon={<LockOutlined />} onClick={() => setDisableOpen(true)}>
            MFA'yı kapat
          </Button>
        </Space>

        <Modal
          title={<Space><LockOutlined /> MFA'yı kapat</Space>}
          open={disableOpen}
          onCancel={() => setDisableOpen(false)}
          onOk={() => disableM.mutate()}
          okText="Kapat" okButtonProps={{ danger: true, loading: disableM.isPending,
            disabled: !disablePwd }}
          cancelText="İptal"
        >
          <Alert type="warning" showIcon message="Hesabınız tekrar tek-faktörlü olacak."
            style={{ marginBottom: 12 }} />
          <Space direction="vertical" style={{ width: '100%' }}>
            <Input.Password placeholder="Şifre" value={disablePwd}
              onChange={(e) => setDisablePwd(e.target.value)} autoFocus />
            <Input placeholder="6-haneli kod veya kurtarma kodu (önerilir)" value={disableCode}
              onChange={(e) => setDisableCode(e.target.value)} />
          </Space>
        </Modal>

        <Modal
          title={<Space><SyncOutlined /> Kurtarma kodlarını yenile</Space>}
          open={regenOpen}
          onCancel={() => setRegenOpen(false)}
          onOk={() => regenM.mutate()}
          okText="Yenile" okButtonProps={{ loading: regenM.isPending, disabled: regenCode.length !== 6 }}
          cancelText="İptal"
        >
          <Alert type="info" showIcon message="Yeni kodlar üretildiğinde eskiler anında geçersiz olur."
            style={{ marginBottom: 12 }} />
          <Input placeholder="Authenticator'dan 6-haneli kod" value={regenCode} maxLength={6}
            onChange={(e) => setRegenCode(e.target.value.replace(/\D/g, ''))} />
        </Modal>
      </Card>
    )
  }

  // ── ENROLLING state (we have a pending secret) ────────────────────────────
  if (enrollSecret && enrollUri) {
    return (
      <Card title={<Space><KeyOutlined /> MFA Kurulumu — 1 / 2</Space>}>
        <Paragraph type="secondary">
          Authenticator uygulamanızda (<Text strong>Google Authenticator · Microsoft Authenticator · Authy · 1Password</Text>) QR'ı tarayın
          veya kurulum anahtarını manuel girin. Bu anahtar yalnızca <strong>bir kez</strong> gösterilir.
        </Paragraph>

        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 24, alignItems: 'center', marginBottom: 20 }}>
          <div style={{ background: '#fff', padding: 10, borderRadius: 6, display: 'inline-block' }}>
            <QRCode value={enrollUri} size={184} bordered={false} />
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 11, letterSpacing: 1 }}>KURULUM ANAHTARI (BASE32)</Text>
            <div className="mono" style={{
              fontSize: 16, letterSpacing: 1.5, padding: '10px 12px',
              background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 4,
              marginTop: 6, fontFamily: 'IBM Plex Mono, monospace', wordBreak: 'break-all',
            }}>{formattedSecret}</div>
            <Button type="text" icon={<CopyOutlined />} size="small" onClick={copySecret} style={{ marginTop: 4 }}>
              Anahtarı kopyala
            </Button>
            <Paragraph type="secondary" style={{ fontSize: 11, marginTop: 10, marginBottom: 0 }}>
              QR taranamıyorsa "Kurulum anahtarı gir" → bu metni yapıştırın.
            </Paragraph>
          </div>
        </div>

        <Title level={5} style={{ marginTop: 0 }}>2 / 2 — Uygulamanızdaki kodu girin</Title>
        <Space>
          <Input
            value={confirmCode}
            onChange={(e) => setConfirmCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="6 haneli kod"
            maxLength={6}
            style={{ width: 180, fontSize: 18, letterSpacing: 4, textAlign: 'center', fontFamily: 'IBM Plex Mono, monospace' }}
            autoFocus
            onPressEnter={() => confirmCode.length === 6 && confirmM.mutate(confirmCode)}
          />
          <Button type="primary" loading={confirmM.isPending}
            disabled={confirmCode.length !== 6}
            onClick={() => confirmM.mutate(confirmCode)}>
            Onayla ve aktif et
          </Button>
          <Button onClick={() => { setEnrollSecret(null); setEnrollUri(null); setConfirmCode('') }}>
            İptal
          </Button>
        </Space>
      </Card>
    )
  }

  // ── IDLE state ────────────────────────────────────────────────────────────
  return (
    <Card title={<Space><SafetyOutlined /> Çok Faktörlü Doğrulama</Space>}>
      <Alert
        type="warning"
        showIcon
        icon={<WarningFilled />}
        message="MFA şu anda devre dışı"
        description="Hesabınız yalnızca şifre ile korunuyor. Tek tıkla TOTP açabilirsiniz — Google Authenticator, Microsoft Authenticator, Authy ve 1Password ile çalışır."
        style={{ marginBottom: 16 }}
      />

      {recoveryCodes && (
        <RecoveryCodesPanel codes={recoveryCodes} onDownload={downloadRecovery} onClose={() => setRecoveryCodes(null)} />
      )}

      <Button type="primary" size="large" icon={<KeyOutlined />}
        loading={enrollM.isPending}
        onClick={() => enrollM.mutate()}>
        MFA'yı aç
      </Button>
    </Card>
  )
}

function RecoveryCodesPanel({
  codes, onDownload, onClose,
}: { codes: string[]; onDownload: () => void; onClose: () => void }) {
  return (
    <Alert
      type="info"
      style={{ marginBottom: 16 }}
      message={<Space><SafetyOutlined /> Kurtarma kodlarınız</Space>}
      description={
        <div>
          <Paragraph style={{ marginBottom: 8 }}>
            Authenticator erişimini kaybederseniz aşağıdaki kodlardan birini Login sayfasında <strong>Kurtarma</strong> alanına girerek
            yeniden giriş yapabilirsiniz. Her kod <strong>tek kullanımlıktır</strong>. Bu liste yalnızca şimdi gösterilir.
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
            <Button icon={<DownloadOutlined />} onClick={onDownload}>İndir (.txt)</Button>
            <Button onClick={onClose}>Sakladım, kapat</Button>
          </Space>
        </div>
      }
    />
  )
}
