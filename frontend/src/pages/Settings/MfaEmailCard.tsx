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
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
  const emailActive = methods.includes('email')

  const [stage, setStage] = useState<'idle' | 'sent'>('idle')
  const [emailMasked, setEmailMasked] = useState<string>('')
  const [code, setCode] = useState('')

  const enrollM = useMutation({
    mutationFn: () => mfaApi.enrollEmail(),
    onSuccess: (r) => {
      setEmailMasked(r.email_masked)
      setStage('sent')
      message.success(t('settings.mfa.email.toast.code_sent', { email: r.email_masked }))
    },
    onError: (e: any) => message.error(
      e?.response?.data?.detail || t('settings.mfa.email.toast.send_failed'),
    ),
  })

  const confirmM = useMutation({
    mutationFn: (c: string) => mfaApi.confirmEmail(c),
    onSuccess: (r) => {
      message.success(t('settings.mfa.email.toast.added'))
      setStage('idle')
      setCode('')
      if (r.recovery_codes && onRecoveryCodes) {
        onRecoveryCodes(r.recovery_codes)
      }
      qc.invalidateQueries({ queryKey: ['mfa-status'] })
    },
    onError: (e: any) => message.error(
      e?.response?.data?.detail || t('settings.mfa.email.toast.verify_failed'),
    ),
  })

  const removeM = useMutation({
    mutationFn: () => mfaApi.removeEmail(),
    onSuccess: (r) => {
      if (r.removed) {
        message.success(t('settings.mfa.email.toast.removed'))
        qc.invalidateQueries({ queryKey: ['mfa-status'] })
      } else if (r.note) {
        message.info(r.note)
      }
    },
    onError: (e: any) => message.error(
      e?.response?.data?.detail || t('settings.mfa.email.toast.remove_failed'),
    ),
  })

  return (
    <Card
      size="small"
      title={
        <Space>
          <MailOutlined style={{ color: emailActive ? 'var(--ok)' : 'var(--fg-3)' }} />
          {t('settings.mfa.email.card_title')}
          {emailActive && (
            <Tag color="green" style={{ marginLeft: 6 }}>
              <CheckCircleFilled /> {t('settings.notifications.status_active')}
            </Tag>
          )}
        </Space>
      }
    >
      {emailActive ? (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Paragraph style={{ marginBottom: 0, color: 'var(--fg-3)', fontSize: 12 }}>
            {t('settings.mfa.email.active_desc')}
          </Paragraph>
          <Button
            danger size="small"
            onClick={() => removeM.mutate()}
            loading={removeM.isPending}
          >
            {t('settings.mfa.email.btn_remove')}
          </Button>
        </Space>
      ) : stage === 'idle' ? (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Paragraph style={{ marginBottom: 0, color: 'var(--fg-3)', fontSize: 12 }}>
            {t('settings.mfa.email.idle_desc')}
          </Paragraph>
          <Alert
            type="info" showIcon
            message={
              <span style={{ fontSize: 12 }}>
                {t('settings.mfa.email.requirement_alert')}
              </span>
            }
          />
          <Button
            type="primary" size="small"
            icon={<MailOutlined />}
            onClick={() => enrollM.mutate()}
            loading={enrollM.isPending}
          >
            {t('settings.mfa.email.btn_enable')}
          </Button>
        </Space>
      ) : (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Alert
            type="success" showIcon
            message={t('settings.mfa.email.toast.code_sent', { email: emailMasked })}
            description={t('settings.mfa.email.sent_desc')}
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
              {t('settings.mfa.email.btn_verify')}
            </Button>
            <Button
              size="small"
              onClick={() => enrollM.mutate()}
              loading={enrollM.isPending}
            >
              {t('settings.mfa.email.btn_resend')}
            </Button>
            <Button size="small" onClick={() => setStage('idle')}>{t('common.cancel')}</Button>
          </Space>
        </Space>
      )}
    </Card>
  )
}
