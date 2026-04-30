import { memo, useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { useTheme } from '@/contexts/ThemeContext'

const STALE_MS = 48 * 3600 * 1000

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const h = Math.floor(ms / 3600000)
  if (h < 1) return `${Math.floor(ms / 60000)}d önce`
  if (h < 24) return `${h}s önce`
  return `${Math.floor(h / 24)}g önce`
}

export function utilColor(pct: number): string {
  if (pct >= 80) return '#ef4444'
  if (pct >= 60) return '#f97316'
  return '#22c55e'
}

function formatSpeed(mbps: number): string {
  if (mbps >= 100000) return `${(mbps / 1000).toFixed(0)}G`
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(0)}G`
  if (mbps >= 100) return `${mbps}M`
  return `${mbps}M`
}

function speedColor(mbps: number): string {
  if (mbps >= 10000) return '#a78bfa'  // 10G+ — violet
  if (mbps >= 1000) return '#38bdf8'   // 1G — sky blue
  if (mbps >= 100) return '#86efac'    // 100M — green
  return '#fbbf24'                     // <100M — amber
}

function speedStrokeWidth(mbps: number): number {
  if (mbps >= 10000) return 3.5
  if (mbps >= 1000) return 2.5
  if (mbps >= 100) return 1.8
  return 1.2
}

export const CustomEdge = memo((props: EdgeProps) => {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, style, markerEnd } = props
  const { isDark } = useTheme()
  const [hovered, setHovered] = useState(false)

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
  })

  const lastSeen = data?.last_seen as string | undefined
  const isStale = lastSeen ? (Date.now() - new Date(lastSeen).getTime()) > STALE_MS : false
  const isGhost = !!(style as React.CSSProperties | undefined)?.strokeDasharray

  const inUtil = data?.in_utilization_pct as number | null | undefined
  const outUtil = data?.out_utilization_pct as number | null | undefined
  const speedMbps = data?.speed_mbps as number | null | undefined
  const duplex = data?.local_duplex as string | null | undefined
  const portMode = data?.local_port_mode as string | null | undefined
  const vlan = data?.local_vlan as number | null | undefined
  const poeEnabled = data?.local_poe_enabled as boolean | null | undefined
  const poeMw = data?.local_poe_mw as number | null | undefined

  const maxUtil = (inUtil != null || outUtil != null)
    ? Math.max(inUtil ?? 0, outUtil ?? 0)
    : null

  const isHighlighted = !!(data?.highlighted)
  const isDimmed = !!(data?.dimmed)

  // Ghost edges get a more visible amber default
  const baseStroke = (style?.stroke as string)
    || (isGhost ? (isDark ? '#b45309' : '#d97706') : (isDark ? '#475569' : '#b0b0b0'))

  const utilStroke = maxUtil !== null ? utilColor(maxUtil) : null

  let strokeColor: string
  if (isHighlighted) {
    strokeColor = '#60a5fa'
  } else if (hovered) {
    strokeColor = '#3b82f6'
  } else {
    strokeColor = utilStroke ?? (isStale ? '#f59e0b' : baseStroke)
  }

  // Speed-based stroke width (only when no util data and not highlighted)
  const baseWidth = speedMbps != null && maxUtil === null
    ? speedStrokeWidth(speedMbps)
    : ((style?.strokeWidth as number) || (isGhost ? 1.5 : 2))
  const strokeWidth = (isHighlighted || hovered) ? Math.max(baseWidth, 3) : baseWidth

  const opacity = isDimmed ? 0.1 : 1

  const tooltipBg = isDark ? '#1e293b' : '#ffffff'
  const tooltipBorder = maxUtil !== null && maxUtil >= 60
    ? utilColor(maxUtil)
    : isStale ? '#f59e0b' : (isDark ? '#334155' : '#e2e8f0')
  const tooltipText = isDark ? '#f1f5f9' : '#1e293b'
  const tooltipSub = isDark ? '#94a3b8' : '#64748b'

  // Show persistent util badge when highlighted but not hovered
  const showHighlightLabel = isHighlighted && !hovered && (inUtil != null || outUtil != null)

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: strokeColor,
          strokeWidth,
          opacity,
          transition: 'stroke 0.12s, stroke-width 0.12s, opacity 0.12s',
          ...(!isGhost && !isStale && !isDimmed ? {
            strokeDasharray: '10 4',
            animation: 'edgeFlow 1.4s linear infinite',
          } : {}),
        }}
      />
      {/* Wide invisible hit target */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ cursor: 'crosshair' }}
      />

      {/* Persistent utilization badge shown when node is hovered (edge highlighted) */}
      {showHighlightLabel && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              display: 'flex',
              gap: 4,
              pointerEvents: 'none',
              zIndex: 900,
            }}
          >
            {inUtil != null && (
              <span style={{
                color: '#fff', fontWeight: 700, background: utilColor(inUtil),
                padding: '1px 5px', borderRadius: 4, fontSize: 9,
                lineHeight: 1.6, boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
              }}>↓{inUtil.toFixed(0)}%</span>
            )}
            {outUtil != null && (
              <span style={{
                color: '#fff', fontWeight: 700, background: utilColor(outUtil),
                padding: '1px 5px', borderRadius: 4, fontSize: 9,
                lineHeight: 1.6, boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
              }}>↑{outUtil.toFixed(0)}%</span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}

      {/* Full tooltip on edge hover */}
      {hovered && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              background: tooltipBg,
              border: `1px solid ${tooltipBorder}`,
              borderRadius: 8,
              padding: '8px 12px',
              fontSize: 11,
              pointerEvents: 'none',
              zIndex: 1000,
              minWidth: 160,
              boxShadow: isDark ? '0 2px 12px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.15)',
            }}
          >
            <div style={{ fontWeight: 600, color: tooltipText, marginBottom: 6 }}>
              {data?.source_port as string} ↔ {data?.target_port as string}
            </div>
            <div style={{ color: tooltipSub, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{
                background: '#3b82f622', color: '#3b82f6',
                padding: '1px 6px', borderRadius: 3, fontWeight: 700, fontSize: 10,
              }}>
                {(data?.protocol as string)?.toUpperCase()}
              </span>
              {isGhost && (
                <span style={{ background: '#f59e0b22', color: '#f59e0b', padding: '1px 5px', borderRadius: 3, fontWeight: 700, fontSize: 10 }}>
                  GHOST
                </span>
              )}
              {speedMbps != null && (
                <span style={{
                  background: `${speedColor(speedMbps)}22`,
                  color: speedColor(speedMbps),
                  padding: '1px 6px', borderRadius: 3, fontWeight: 700, fontSize: 10,
                }}>
                  ⚡ {formatSpeed(speedMbps)}
                </span>
              )}
            </div>
            {(inUtil != null || outUtil != null) && (
              <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                {inUtil != null && (
                  <span style={{
                    color: utilColor(inUtil), fontWeight: 600,
                    background: `${utilColor(inUtil)}22`,
                    padding: '1px 6px', borderRadius: 3, fontSize: 10,
                  }}>
                    ↓ {inUtil.toFixed(1)}%
                  </span>
                )}
                {outUtil != null && (
                  <span style={{
                    color: utilColor(outUtil), fontWeight: 600,
                    background: `${utilColor(outUtil)}22`,
                    padding: '1px 6px', borderRadius: 3, fontSize: 10,
                  }}>
                    ↑ {outUtil.toFixed(1)}%
                  </span>
                )}
              </div>
            )}
            {/* Extended port attributes */}
            {(duplex || portMode || vlan != null || poeEnabled != null) && (
              <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {duplex && (
                  <span style={{
                    background: '#64748b22', color: tooltipSub,
                    padding: '1px 5px', borderRadius: 3, fontSize: 9, fontWeight: 600,
                  }}>
                    {duplex === 'full' ? 'FDX' : duplex === 'half' ? 'HDX' : 'AUTO'}
                  </span>
                )}
                {portMode && (
                  <span style={{
                    background: portMode === 'trunk' ? '#8b5cf622' : '#22c55e22',
                    color: portMode === 'trunk' ? '#8b5cf6' : '#22c55e',
                    padding: '1px 5px', borderRadius: 3, fontSize: 9, fontWeight: 600,
                  }}>
                    {portMode.toUpperCase()}
                  </span>
                )}
                {vlan != null && (
                  <span style={{
                    background: '#f59e0b22', color: '#f59e0b',
                    padding: '1px 5px', borderRadius: 3, fontSize: 9, fontWeight: 600,
                  }}>
                    VLAN {vlan}
                  </span>
                )}
                {poeEnabled != null && (
                  <span style={{
                    background: poeEnabled ? '#22c55e22' : '#64748b22',
                    color: poeEnabled ? '#22c55e' : '#94a3b8',
                    padding: '1px 5px', borderRadius: 3, fontSize: 9, fontWeight: 600,
                  }}>
                    PoE {poeEnabled ? (poeMw != null ? `${(poeMw / 1000).toFixed(1)}W` : 'ON') : 'OFF'}
                  </span>
                )}
              </div>
            )}
            {lastSeen && (
              <div style={{ color: isStale ? '#f59e0b' : tooltipSub, marginTop: 4 }}>
                {isStale && '⚠ '}Son keşif: {formatAge(lastSeen)}
              </div>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

CustomEdge.displayName = 'CustomEdge'
