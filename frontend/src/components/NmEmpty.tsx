// NmEmpty — tek tip NOC empty-state. Liste/kart sayfalarında "veri yok"
// veya "henüz X yok" çiziminde kullanın. Antd <Empty>'yi sarmıyor;
// nm-* class'larıyla kendi başına render eder ki dark/light + responsive
// + tema renkleri tutarlı kalsın.
//
// Kullanım:
//   <NmEmpty
//     icon={<CheckCircleOutlined />}
//     title="Onay talebi yok"
//     description="Yeni komut onaya geldiğinde burada görünür."
//     action={<Button>Yeni Talep</Button>}   // opsiyonel
//     tone="ok"                              // 'ok' | 'warn' | 'crit' | 'neutral' (default)
//   />
import type { ReactNode } from 'react'

type Tone = 'ok' | 'warn' | 'crit' | 'neutral'

const TONE: Record<Tone, string> = {
  ok:      'var(--ok)',
  warn:    'var(--warn)',
  crit:    'var(--crit)',
  neutral: 'var(--fg-3)',
}

export default function NmEmpty({
  icon,
  title,
  description,
  action,
  tone = 'neutral',
  compact = false,
}: {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
  tone?: Tone
  /** When true, halves the vertical padding — for inline empty-states
   *  inside a section, not a full page. */
  compact?: boolean
}) {
  const color = TONE[tone]
  return (
    <div style={{
      padding: compact ? '24px 16px' : '48px 24px',
      textAlign: 'center',
      color: 'var(--fg-3)',
    }}>
      {icon && (
        <div style={{
          width: 56, height: 56, borderRadius: '50%',
          margin: '0 auto 14px',
          display: 'grid', placeItems: 'center',
          background: 'var(--bg-2)',
          border: `1px solid ${tone === 'neutral' ? 'var(--border-0)' : color + '44'}`,
          color, fontSize: 24,
        }}>
          {icon}
        </div>
      )}
      <div style={{
        color: 'var(--fg-1)', fontSize: 14, fontWeight: 500,
        marginBottom: description ? 6 : 0,
      }}>
        {title}
      </div>
      {description && (
        <div style={{
          color: 'var(--fg-3)', fontSize: 12, maxWidth: 360,
          margin: '0 auto', lineHeight: 1.6,
        }}>
          {description}
        </div>
      )}
      {action && (
        <div style={{ marginTop: 14 }}>{action}</div>
      )}
    </div>
  )
}
