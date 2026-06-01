/**
 * T10 C7 Wave 2 #2 F4 — Minimal donut/gauge component (conic-gradient).
 *
 * NetManager mockup styles.css:694-716 .nm-donut paterninden TypeScript'e port.
 * Conic-gradient kullanır (modern tarayıcılar). 110x110 default boyut + label.
 *
 * Renk eşik mantığı:
 *   value >= 99 → ok (yeşil)
 *   95-98.99 → warn (turuncu)
 *   <95 → crit (kırmızı)
 */

interface DonutProps {
  /** 0-100 değer (örn. uptime yüzdesi). */
  value: number | null | undefined
  /** Üst label (örn. "uptime · 7g"). */
  label?: string
  /** Sabit renk verilirse threshold mantığı atlanır. */
  color?: string
  size?: number
  /** Değer null/undefined ise alt yazı. */
  emptyText?: string
}

function colorFor(value: number): string {
  if (value >= 99) return 'var(--ok, #22c55e)'
  if (value >= 95) return 'var(--warn, #f59e0b)'
  return 'var(--crit, #ef4444)'
}

export default function Donut({
  value, label, color, size = 110, emptyText = '—',
}: DonutProps) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return (
      <div style={{
        width: size, height: size, borderRadius: '50%',
        border: '6px solid var(--line-soft, #1e2a3a)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        color: 'var(--fg-3, #64748b)', fontSize: 11,
      }}>
        {emptyText}
      </div>
    )
  }
  const clamped = Math.max(0, Math.min(100, value))
  const stroke = color || colorFor(clamped)
  const ringBg = 'var(--line-soft, #1e2a3a)'
  // Conic-gradient ile dış halka: clamped/100 → derece dönüşü
  const deg = (clamped / 100) * 360
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: `conic-gradient(${stroke} ${deg}deg, ${ringBg} 0)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      position: 'relative',
    }}>
      {/* iç dolu daire (donut hole) */}
      <div style={{
        width: size - 14, height: size - 14, borderRadius: '50%',
        background: 'var(--bg-1, #0f172a)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: size * 0.22, fontWeight: 500,
          color: stroke, lineHeight: 1,
        }}>
          {clamped.toFixed(clamped === 100 ? 0 : 2)}<span style={{ fontSize: size * 0.12 }}>%</span>
        </span>
        {label && (
          <span style={{
            fontSize: size * 0.085, color: 'var(--fg-2, #94a3b8)',
            textTransform: 'uppercase', letterSpacing: 0.06,
            marginTop: 2, textAlign: 'center', whiteSpace: 'nowrap',
          }}>
            {label}
          </span>
        )}
      </div>
    </div>
  )
}
