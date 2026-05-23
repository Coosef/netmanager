// CustomizeContext — Phase 2 NOC customization (Aşama 1: temel ayarlar).
//
// Yönetim: yoğunluk / menü pozisyonu / aksent rengi. Tema (dark/light)
// ayrıca ThemeContext'te. Preset layouts, saved layouts ve dashboard
// widget visibility/order — Dashboard yeniden yazımı sırasında eklenecek
// (Aşama 2).
//
// Persistence: localStorage. DOM application: useEffect ile <body>'e
// density-X / menu-X class'ları + --accent / --accent-soft / --accent-line
// custom property'leri inline set ediliyor (noc.css :root default'larını
// override).
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type Density = 'compact' | 'regular' | 'spacious'
export type MenuPosition = 'side' | 'top'

interface CustomizeCtx {
  density: Density
  setDensity: (d: Density) => void
  menuPosition: MenuPosition
  setMenuPosition: (p: MenuPosition) => void
  accent: string                              // hex string, örn. "#22d3c5"
  setAccent: (hex: string) => void
  reset: () => void
}

// Defaults (NOC mint teal — noc.css'in :root --accent değeriyle yakın hex).
const DEFAULT_ACCENT = '#22d3c5'
const DEFAULT_DENSITY: Density = 'regular'
const DEFAULT_MENU: MenuPosition = 'side'

// Önceden tanımlı renk paletleri — kullanıcı custom hex de girebilir.
export const ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: 'Mint',   hex: '#22d3c5' },   // default NOC
  { name: 'Cyan',   hex: '#06b6d4' },
  { name: 'Blue',   hex: '#3b82f6' },
  { name: 'Violet', hex: '#8b5cf6' },
  { name: 'Pink',   hex: '#ec4899' },
  { name: 'Orange', hex: '#f97316' },
  { name: 'Lime',   hex: '#a3e635' },
  { name: 'Rose',   hex: '#f43f5e' },
]

const CustomizeContext = createContext<CustomizeCtx>({
  density: DEFAULT_DENSITY,
  setDensity: () => {},
  menuPosition: DEFAULT_MENU,
  setMenuPosition: () => {},
  accent: DEFAULT_ACCENT,
  setAccent: () => {},
  reset: () => {},
})

const LS_DENSITY = 'nm-customize-density'
const LS_MENU = 'nm-customize-menu'
const LS_ACCENT = 'nm-customize-accent'

function loadDensity(): Density {
  const v = localStorage.getItem(LS_DENSITY)
  return v === 'compact' || v === 'spacious' ? v : DEFAULT_DENSITY
}
function loadMenu(): MenuPosition {
  const v = localStorage.getItem(LS_MENU)
  return v === 'top' ? 'top' : 'side'
}
function loadAccent(): string {
  const v = localStorage.getItem(LS_ACCENT)
  return v && /^#[0-9a-fA-F]{6}$/.test(v) ? v : DEFAULT_ACCENT
}

// Hex → "#xxxxxxAA" alfa eklemek için. CSS modern browsers 8-haneli hex'i
// destekliyor (#rrggbbaa).
function hexAlpha(hex: string, alpha255: number): string {
  const a = Math.max(0, Math.min(255, Math.round(alpha255))).toString(16).padStart(2, '0')
  return `${hex}${a}`
}

export function CustomizeProvider({ children }: { children: ReactNode }) {
  const [density, setDensityState] = useState<Density>(loadDensity)
  const [menuPosition, setMenuState] = useState<MenuPosition>(loadMenu)
  const [accent, setAccentState] = useState<string>(loadAccent)

  // density class — sadece bir tane aktif olacak şekilde body'e uygula.
  useEffect(() => {
    localStorage.setItem(LS_DENSITY, density)
    document.body.classList.remove('density-compact', 'density-regular', 'density-spacious')
    document.body.classList.add(`density-${density}`)
  }, [density])

  // menu position — nm-app-shell'in altındaki nm-root menu-side/menu-top
  // class'ını yöneten Layout zaten var; body'e de class koyalım ki tutar
  // ek selector'lar (örn. shortcut'lar) ulaşsın.
  useEffect(() => {
    localStorage.setItem(LS_MENU, menuPosition)
    document.body.classList.remove('menu-side', 'menu-top')
    document.body.classList.add(`menu-${menuPosition}`)
  }, [menuPosition])

  // accent — :root'taki 3 değişkeni inline override. document.documentElement
  // <html> seviyesinde set ediyoruz ki noc.css'in :root değerini ezsin.
  useEffect(() => {
    localStorage.setItem(LS_ACCENT, accent)
    const root = document.documentElement
    root.style.setProperty('--accent', accent)
    // noc.css'in :root default'unda --accent-soft alpha 0.14 (≈36/255),
    // --accent-line alpha 0.35 (≈89/255). Aynı oranları koruyalım.
    root.style.setProperty('--accent-soft', hexAlpha(accent, 36))
    root.style.setProperty('--accent-line', hexAlpha(accent, 89))
  }, [accent])

  const reset = () => {
    setDensityState(DEFAULT_DENSITY)
    setMenuState(DEFAULT_MENU)
    setAccentState(DEFAULT_ACCENT)
  }

  return (
    <CustomizeContext.Provider value={{
      density, setDensity: setDensityState,
      menuPosition, setMenuPosition: setMenuState,
      accent, setAccent: setAccentState,
      reset,
    }}>
      {children}
    </CustomizeContext.Provider>
  )
}

export const useCustomize = () => useContext(CustomizeContext)
