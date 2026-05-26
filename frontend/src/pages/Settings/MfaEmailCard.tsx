/**
 * MfaEmailCard — Settings/MfaTab'da gösterilen Email MFA kanalı kartı.
 *
 * T9 Tur 2 #2b. Akış:
 *   idle (email yok)  → "Email kanalı ekle" butonu → enrollEmail()
 *   sent              → backend OTP yollandı, 6-haneli input + Doğrula
 *   active (email var)→ Tag "Email" + "Kaldır" butonu
 *
 * Recovery codes: backend confirmEmail() içinde ilk MFA kanalı email
 * ise mint eder; bu durumda parent'a onRecoveryCodes(codes) ile geri yollayıp
 * mevcut RecoveryCodesPanel'i kullanıyoruz (tek mesaj kaynağı).
 */
import { useState } from 'react'
import { Alert, Button, Card, Input, Space, Tag, Typography, message } from 'antd'
import { CheckCircleFilled, MailOutlined } from '@ant-design/icons'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { mfaApi } from '@/api/mfa'

const { Paragraph } = Typography

interface Props {
  /** mfaApi.status() döner — methods CSV array */
  methods: string[]
  /** İlk MFA kanalı email olduğunda mint edilen recovery codes — parent'a aktar */
  onRecoveryCodes?: (codes: string[]) => void
}

export default function MfaEmailCard({ methods, onRecoveryCodes }: Props) {
  const qc = useQueryClient()
  const emailActive = methods.includes('email')

  const [stage, setStage] = useState<'idle' | 'sent'>('idle')
  const [emailMasked, setEmailMasked] = useState<string>('')
  const [code, setCode] = useState('')

  const enrollM = useMutation({
    mutationFn: () => mfaApi.enrollEmail(),
    onSuccess: (r) => {
      setEmailMasked(r.email_masked)
      setStage('sent')
      message.success(`Doğrulama kodu gönderildi: ${r.email_masked}`)
    },
    onError: (e: any) => message.error(
      e?.response?.data?.detail || 'Email gönderilemedi',
    ),
  })

  const confirmM = useMutation({
    mutationFn: (c: string) => mfaApi.confirmEmail(c),
    onSuccess: (r) => {
      message.success('Email MFA kanalı eklendi')
      setStage('idle')
      setCode('')
      if (r.recovery_codes && onRecoveryCodes) {
        onRecoveryCodes(r.recovery_codes)
      }
      qc.invalidateQueries({ queryKey: ['mfa-status'] })
    },
    onError: (e: any) => message.error(
      e?.response?.data?.detail || 'Kod doğrulanamadı',
    ),
  })

  const removeM = useMutation({
    mutationFn: () => mfaApi.removeEmail(),
    onSuccess: (r) => {
      if (r.removed) {
        message.success('Email MFA kanalı kaldırıldı')
        qc.invalidateQueries({ queryKey: ['mfa-status'] })
      } else if (r.note) {
        message.info(r.note)
      }
    },
    onError: (e: any) => message.error(
      e?.response?.data?.detail || 'Kaldırılamadı',
    ),
  })

  return (
    <Card
      size="small"
      title={
        <Space>
          <MailOutlined style={{ color: emailActive ? 'var(--ok)' : 'var(--fg-3)' }} />
          Email Doğrulama (2. Kanal)
          {emailActive && (
            <Tag color="green" style={{ marginLeft: 6 }}>
              <CheckCircleFilled /> Aktif
            </Tag>
          )}
        </Space>
      }
    >
      {emailActive ? (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Paragraph style={{ marginBottom: 0, color: 'var(--fg-3)', fontSize: 12 }}>
            Login esnasında authenticator yerine email'inize OTP yollanabilir.
            Authenticator yine birincil yöntem olarak kullanılabilir.
          </Paragraph>
          <Button
            danger size="small"
            onClick={() => removeM.mutate()}
            loading={removeM.isPending}
          >
            Email kanalını kaldır
          </Button>
        </Space>
      ) : stage === 'idle' ? (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Paragraph style={{ marginBottom: 0, color: 'var(--fg-3)', fontSize: 12 }}>
            Kayıtlı email adresinize 6-haneli OTP yollanır. Authenticator'a
            ek bir doğrulama kanalı olarak çalışır.
          </Paragraph>
          <Alert
            type="info" showIcon
            message={
              <span style={{ fontSize: 12 }}>
                Email gönderebilmek için organizasyonunuzda en az bir aktif
                email bildirim kanalı tanımlı olmalı (Settings → Bildirimler).
              </span>
            }
          />
          <Button
            type="primary" size="small"
            icon={<MailOutlined />}
            onClick={() => enrollM.mutate()}
            loading={enrollM.isPending}
          >
            Email kanalını etkinleştir
          </Button>
        </Space>
      ) : (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Alert
            type="success" showIcon
            message={`Doğrulama kodu gönderildi: ${emailMasked}`}
            description="Email'inize gelen 6-haneli kodu girin. Kod 10 dakika geçerli."
          />
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            maxLength={6}
            style={{
              fontSize: 22, letterSpacing: 6, textAlign: 'center',
              fontFamily: 'monospace', maxWidth: 220,
            }}
          />
          <Space>
            <Button
              type="primary"
              disabled={code.length !== 6}
              loading={confirmM.isPending}
              onClick={() => confirmM.mutate(code)}
            >
              Doğrula
            </Button>
            <Button
              size="small"
              onClick={() => enrollM.mutate()}
              loading={enrollM.isPending}
            >
              Yeniden yolla
            </Button>
            <Button size="small" onClick={() => setStage('idle')}>İptal</Button>
          </Space>
        </Space>
      )}
    </Card>
  )
}
