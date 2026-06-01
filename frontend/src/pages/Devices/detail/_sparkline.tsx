/**
 * T10 C7 Wave 2 #2 F3 — Minimal SVG sparkline.
 *
 * Saf SVG path; recharts/echarts gibi büyük lib gerek YOK (~30 satır kod).
 * NetManager mockup widgets.jsx:70-86 paterninden TypeScript'e port.
 *
 * Kullanım:
 *   <Sparkline data={[12, 18, 22, 19, ...]} color="var(--accent)" />
 * Boş / yetersiz veri için friendly placeholder gösterir.
 */

interface SparklineProps {
  data: number[]
  color?: string
  width?: number
  height?: number
  fill?: boolean
  /** Y-eksen sabit aralık (örn. 0-100). Verilmezse min/max'tan otomatik. */
  yMin?: number
  yMax?: number
}

export default function Sparkline({
  data, color = 'var(--accent, #22d3c5)',
  width = 120, height = 28,
  fill = false,
  yMin, yMax,
}: SparklineProps) {
  const points = (data || []).filter((v) => Number.isFinite(v))
  if (points.length < 2) {
    return (
      <div style={{
        width, height, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 10, color: 'var(--fg-3, #64748b)',
      }}>
        veri yok
      </div>
    )
  }
  const min = yMin ?? Math.min(...points)
  const max = yMax ?? Math.max(...points)
  const range = max - min || 1
  const stepX = width / (points.length - 1)
  const coords = points.map((v, i) => {
    const x = i * stepX
    const y = height - ((v - min) / range) * height
    return [x, y]
  })
  const pathD = coords
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ')
  const areaD = fill
    ? `${pathD} L ${width} ${height} L 0 ${height} Z`
    : null

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {areaD && (
        <path d={areaD} fill={color} fillOpacity={0.18} />
      )}
      <path d={pathD} stroke={color} strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
