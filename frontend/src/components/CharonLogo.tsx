// Charon brand logosu — inline SVG component. Sidebar, TopNav, Login,
// Reports header gibi her yerde reuse edilir. `size` ile boyut + `glow`
// false → kompakt sidebar/topnav için gold halo'yu kapat.
//
// Tema farkındalığı: gold gradient her temada okunuyor; light tema'da
// daha az glow + biraz daha koyu gold (görünürlük için).

import React from 'react'

interface Props {
  size?: number
  glow?: boolean
  title?: string
  className?: string
  style?: React.CSSProperties
}

let _uidCounter = 0
const uniqueSuffix = () => `cl${++_uidCounter}`

export default function CharonLogo({
  size = 32, glow = true, title = 'Charon', className, style,
}: Props) {
  // Her instance'a benzersiz gradient/filter id ver — aynı sayfada iki
  // logo varken id çakışmasın (SVG defs global namespace gibi davranır).
  const uid = React.useMemo(uniqueSuffix, [])
  const gradId   = `charon-gold-${uid}`
  const fillId   = `charon-fill-${uid}`
  const filterId = `charon-glow-${uid}`

  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      className={className}
      style={style}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <defs>
        <linearGradient id={gradId} x1="20%" y1="10%" x2="80%" y2="90%">
          <stop offset="0%"   stopColor="#FFE57A"/>
          <stop offset="35%"  stopColor="#F0C040"/>
          <stop offset="70%"  stopColor="#D4A017"/>
          <stop offset="100%" stopColor="#9C7212"/>
        </linearGradient>
        <linearGradient id={fillId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#FFE57A"/>
          <stop offset="100%" stopColor="#D4A017"/>
        </linearGradient>
        {glow && (
          <filter id={filterId} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="2" result="b"/>
            <feMerge>
              <feMergeNode in="b"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        )}
      </defs>

      <g
        {...(glow ? { filter: `url(#${filterId})` } : {})}
        stroke={`url(#${gradId})`}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      >
        {/* Dış elmas */}
        <path d="M100 14 L186 100 L100 186 L14 100 Z" strokeWidth="3.5"/>
        {/* İç elmas */}
        <path d="M100 30 L170 100 L100 170 L30 100 Z" strokeWidth="2.5"/>

        {/* Yan compass-arrow notch'ları */}
        <path d="M44 96 L40 100 L44 104" strokeWidth="2"/>
        <path d="M156 96 L160 100 L156 104" strokeWidth="2"/>

        {/* Üst 4-uçlu yıldız (dolu) */}
        <path
          d="M100 44 L104 55 L115 59 L104 63 L100 74 L96 63 L85 59 L96 55 Z"
          fill={`url(#${fillId})`}
          strokeWidth="0.6"
        />

        {/* Ortada Ω (omega / horseshoe) */}
        <path d="M75 118 A26 23 0 0 1 125 118" strokeWidth="3.5"/>
        <path d="M75 118 Q73 132 66 138 L82 138" strokeWidth="3.5"/>
        <path d="M125 118 Q127 132 134 138 L118 138" strokeWidth="3.5"/>

        {/* Dik mızrak gövdesi */}
        <path d="M100 110 L100 158" strokeWidth="2.2"/>
        {/* Mızrak ucu */}
        <path d="M94 150 L100 168 L106 150 Z" fill={`url(#${fillId})`} strokeWidth="0.6"/>
      </g>
    </svg>
  )
}
