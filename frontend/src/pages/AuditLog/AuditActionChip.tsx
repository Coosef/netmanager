import { Tag } from 'antd'
import {
  LoginOutlined,
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  SafetyOutlined,
  TagOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons'
import { getAuditActionCategory, type AuditActionCategory } from './auditActionCategory'

/**
 * Audit Log v2 PR 1 — Action chip görsel ayrımı.
 *
 * Mevcut tablodaki düz `<Tag>` (action_hex tek renk) yerine kategori-bazlı
 * ikon + renk + label sistemi. status='failure' durumunda kırmızı tint +
 * ✗ rozet ile başarısız aksiyon net ayrılır.
 *
 * Bilinmeyen action → kategori 'neutral' → güvenli gri fallback.
 */

type AuditActionChipProps = {
  action: string
  status?: string | null
  /** Compact mod: küçük font + minimal padding (tablo içi). */
  compact?: boolean
}

// Charon NOC palette ile uyumlu kategori renkleri.
// Hex değerler önceki ACTION_HEX kullanımıyla tutarlı tonlarda.
const CATEGORY_STYLES: Record<AuditActionCategory, {
  icon: React.ReactNode
  color: string  // text & border
  bg: string     // soft background tint
}> = {
  auth:     { icon: <LoginOutlined />,       color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
  create:   { icon: <PlusOutlined />,        color: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
  update:   { icon: <EditOutlined />,        color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  delete:   { icon: <DeleteOutlined />,      color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
  approve:  { icon: <CheckCircleOutlined />, color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
  security: { icon: <SafetyOutlined />,      color: '#f97316', bg: 'rgba(249,115,22,0.12)' },
  neutral:  { icon: <TagOutlined />,         color: '#64748b', bg: 'rgba(100,116,139,0.12)' },
}

// Failure modunda kategori rengi üstüne kırmızı vurgu — chip okunmaz olmasın
// diye border kırmızı, bg + icon kategori renginde kalır.
const FAILURE_BORDER = '#ef4444'

export default function AuditActionChip({ action, status, compact }: AuditActionChipProps) {
  const category = getAuditActionCategory(action)
  const s = CATEGORY_STYLES[category]
  const isFailure = status === 'failure'

  return (
    <Tag
      data-testid="audit-action-chip"
      data-category={category}
      data-failure={isFailure ? 'true' : 'false'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        color: s.color,
        background: s.bg,
        borderColor: isFailure ? FAILURE_BORDER : s.color + '60',
        // Failure'da ek görsel sinyal: ince kırmızı sol kenar.
        borderLeft: isFailure ? `2px solid ${FAILURE_BORDER}` : undefined,
        fontSize: compact ? 11 : 12,
        lineHeight: compact ? '18px' : '20px',
        padding: compact ? '0 6px' : '0 8px',
        marginRight: 0,
        fontFamily: 'inherit',
        fontWeight: 500,
      }}
    >
      <span style={{ display: 'inline-flex', fontSize: compact ? 10 : 12 }}>{s.icon}</span>
      <span style={{ fontFamily: 'monospace', letterSpacing: 0.2 }}>{action}</span>
      {isFailure && (
        <CloseCircleOutlined
          data-testid="audit-action-chip-failure-icon"
          style={{ color: FAILURE_BORDER, fontSize: compact ? 10 : 12, marginLeft: 2 }}
        />
      )}
    </Tag>
  )
}
