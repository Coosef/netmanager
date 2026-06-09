import { Empty, Button, Typography } from 'antd'
import { FileSearchOutlined, InboxOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

const { Text } = Typography

/**
 * Audit Log v2 PR 4 — Empty state component.
 *
 * 2 mode:
 *   1. 'no_data' — gerçek empty (filtre yok, kayıt yok)
 *      Mesaj: "Henüz audit log kaydı yok"
 *      CTA: YOK (sistemde aksiyon olduğunda dolacak)
 *
 *   2. 'no_match' — filtre sonucu 0 kayıt
 *      Mesaj: "Mevcut filtrelerle eşleşen kayıt yok"
 *      CTA: "Filtreleri Sıfırla" (onReset callback)
 */

type Props = {
  mode: 'no_data' | 'no_match'
  onReset?: () => void
}

export default function AuditEmptyState({ mode, onReset }: Props) {
  const { t } = useTranslation()
  const isNoMatch = mode === 'no_match'

  return (
    <div
      data-testid="audit-empty-state"
      data-mode={mode}
      style={{
        padding: '40px 16px',
        textAlign: 'center',
      }}
    >
      <Empty
        image={
          isNoMatch ? (
            <FileSearchOutlined style={{ fontSize: 48, color: 'var(--fg-3)' }} />
          ) : (
            <InboxOutlined style={{ fontSize: 48, color: 'var(--fg-3)' }} />
          )
        }
        imageStyle={{ height: 60 }}
        description={
          <div style={{ marginTop: 12 }}>
            <Text strong style={{ fontSize: 14, color: 'var(--fg-1)' }}>
              {isNoMatch ? t('audit.empty.no_match_title') : t('audit.empty.no_data_title')}
            </Text>
            <br />
            <Text style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 4, display: 'inline-block' }}>
              {isNoMatch ? t('audit.empty.no_match_desc') : t('audit.empty.no_data_desc')}
            </Text>
          </div>
        }
      >
        {isNoMatch && onReset && (
          <Button
            data-testid="audit-empty-reset-cta"
            icon={<ReloadOutlined />}
            onClick={onReset}
            type="primary"
            ghost
            style={{ marginTop: 16 }}
          >
            {t('audit.empty.reset_cta')}
          </Button>
        )}
      </Empty>
    </div>
  )
}
