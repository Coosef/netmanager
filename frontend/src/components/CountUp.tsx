// CountUp — sayı değişimini smooth tween + flash animasyonu ile gösterir.
// Dashboard KPI'larında kullanılır: değer 5 → 7 olunca animate eder ve
// kart anlık olarak "flash" yapar (kullanıcının değişimi farketmesini
// sağlar). Live update hissini güçlendirir.
import { useEffect, useRef, useState } from 'react'

const TWEEN_DURATION_MS = 600

interface Props {
  value: number
  /** Ondalık basamak sayısı (örn. SLA için 1) */
  decimals?: number
  /** Sayı görüntüleme öneki/eki tween'den ayrı; çocuk olarak iletilir.
   *  Örnek: <CountUp value={offline} unit={`/ ${total}`} /> */
  unit?: string
  /** Değişim sonrası flash class — değer artarsa 'up', azalırsa 'down'.
   *  Tek başına kullanılabilir; "" parent stilini bozmaz. */
  flashOnChange?: boolean
  /** Inline style geçişi için */
  style?: React.CSSProperties
  className?: string
}

const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4)

export default function CountUp({
  value, decimals = 0, unit, flashOnChange = true, style, className,
}: Props) {
  const [display, setDisplay] = useState(value)
  const [flash, setFlash] = useState<'up' | 'down' | null>(null)
  const fromRef = useRef(value)
  const startTimeRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (value === display) return
    fromRef.current = display
    startTimeRef.current = performance.now()

    // Flash class — yön
    if (flashOnChange) {
      setFlash(value > display ? 'up' : 'down')
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
      flashTimerRef.current = setTimeout(() => setFlash(null), 900)
    }

    const tick = (t: number) => {
      const progress = Math.min(1, (t - startTimeRef.current) / TWEEN_DURATION_MS)
      const eased = easeOutQuart(progress)
      const cur = fromRef.current + (value - fromRef.current) * eased
      setDisplay(cur)
      if (progress < 1) rafRef.current = requestAnimationFrame(tick)
      else { setDisplay(value); rafRef.current = null }
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
    // display'i bağımlılığa eklemiyoruz — sonsuz tween olur
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
  }, [])

  const text = decimals === 0
    ? String(Math.round(display))
    : display.toFixed(decimals)

  return (
    <span className={`nm-countup ${flash ? `flash-${flash}` : ''} ${className || ''}`} style={style}>
      {text}{unit && <small>{unit}</small>}
    </span>
  )
}
