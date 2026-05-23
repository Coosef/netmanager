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
export type ViewVariant = 'workspace' | 'mission' | 'editorial'

// Hazır layout preset'leri — Operatör / Network Admin / Yönetici / NOC Duvarı.
// Her biri density/menu/view/accent kombinasyonu uygular.
export interface PresetLayout {
  id: string
  name: string
  sub: string
  config: Partial<{
    density: Density
    menuPosition: MenuPosition
    viewVariant: ViewVariant
    accent: string
  }>
}
export const PRESET_LAYOUTS: PresetLayout[] = [
  {
    id: 'operator', name: 'Operatör', sub: 'Olay akışı + topoloji ön planda',
    config: { density: 'regular', menuPosition: 'side', viewVariant: 'workspace', accent: '#22d3c5' },
  },
  {
    id: 'admin', name: 'Network Admin', sub: 'Risk, drift, onaylar, uyumluluk',
    config: { density: 'compact', menuPosition: 'side', viewVariant: 'workspace', accent: '#3b82f6' },
  },
  {
    id: 'exec', name: 'Yönetici', sub: 'Editorial brief — günlük özet',
    config: { density: 'spacious', menuPosition: 'top', viewVariant: 'editorial', accent: '#a3e635' },
  },
  {
    id: 'wall', name: 'NOC Duvarı', sub: 'Mission control — duvar ekranı',
    config: { density: 'compact', menuPosition: 'top', viewVariant: 'mission', accent: '#f97316' },
  },
]

// Kullanıcının kaydettiği custom layout'lar — localStorage'da array.
export interface SavedLayout {
  id: string
  name: string
  ts: number
  config: {
    density: Density
    menuPosition: MenuPosition
    viewVariant: ViewVariant
    accent: string
  }
}

interface CustomizeCtx {
  density: Density
  setDensity: (d: Density) => void
  menuPosition: MenuPosition
  setMenuPosition: (p: MenuPosition) => void
  accent: string                              // hex string, örn. "#22d3c5"
  setAccent: (hex: string) => void
  viewVariant: ViewVariant
  setViewVariant: (v: ViewVariant) => void
  soundEnabled: boolean
  setSoundEnabled: (v: boolean) => void
  playBeep: () => void                        // kritik alarm geldiğinde useAlarmWatcher çağırır
  editMode: boolean
  setEditMode: (v: boolean) => void
  savedLayouts: SavedLayout[]
  saveLayout: (name: string) => void
  applyLayout: (id: string) => void          // saved veya preset id
  deleteLayout: (id: string) => void
  reset: () => void
}

// Defaults (NOC mint teal — noc.css'in :root --accent değeriyle yakın hex).
const DEFAULT_ACCENT = '#22d3c5'
const DEFAULT_DENSITY: Density = 'regular'
const DEFAULT_MENU: MenuPosition = 'side'
const DEFAULT_SOUND = false                   // varsayılan sessiz — kullanıcı isteyince açar
const DEFAULT_VIEW: ViewVariant = 'workspace'

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
  viewVariant: DEFAULT_VIEW,
  setViewVariant: () => {},
  soundEnabled: DEFAULT_SOUND,
  setSoundEnabled: () => {},
  playBeep: () => {},
  editMode: false,
  setEditMode: () => {},
  savedLayouts: [],
  saveLayout: () => {},
  applyLayout: () => {},
  deleteLayout: () => {},
  reset: () => {},
})

const LS_DENSITY = 'nm-customize-density'
const LS_MENU = 'nm-customize-menu'
const LS_ACCENT = 'nm-customize-accent'
const LS_SOUND = 'nm-customize-sound'
const LS_VIEW = 'nm-customize-view'
const LS_SAVED = 'nm-customize-saved'

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
function loadSound(): boolean {
  return localStorage.getItem(LS_SOUND) === 'on'
}
function loadView(): ViewVariant {
  const v = localStorage.getItem(LS_VIEW)
  return v === 'mission' || v === 'editorial' ? v : DEFAULT_VIEW
}
function loadSaved(): SavedLayout[] {
  try {
    const v = localStorage.getItem(LS_SAVED)
    if (!v) return []
    const arr = JSON.parse(v)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

// Web Audio API beep — mockup commandk.jsx'ten port. Kritik alarm
// geldiğinde kısa "ding" sesi çalar. Tarayıcı autoplay policy nedeniyle
// kullanıcı sayfa ile etkileşime geçmeden çalışmayabilir — bu sebeple
// soundEnabled default false, kullanıcı bilinçli açar.
function playAlertBeep() {
  try {
    type AudioCtxCtor = typeof AudioContext
    const w = window as unknown as { AudioContext?: AudioCtxCtor; webkitAudioContext?: AudioCtxCtor }
    const AC = w.AudioContext || w.webkitAudioContext
    if (!AC) return
    const ac = new AC()
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    osc.connect(gain); gain.connect(ac.destination)
    gain.gain.setValueAtTime(0, ac.currentTime)
    gain.gain.linearRampToValueAtTime(0.18, ac.currentTime + 0.02)
    gain.gain.linearRampToValueAtTime(0, ac.currentTime + 0.25)
    osc.start(ac.currentTime)
    osc.stop(ac.currentTime + 0.28)
    setTimeout(() => ac.close(), 600)
  } catch { /* AudioContext yok / muted */ }
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
  const [soundEnabled, setSoundState] = useState<boolean>(loadSound)
  const [viewVariant, setViewState] = useState<ViewVariant>(loadView)
  const [editMode, setEditModeState] = useState<boolean>(false)
  const [savedLayouts, setSavedLayouts] = useState<SavedLayout[]>(loadSaved)

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

  // soundEnabled persistence
  useEffect(() => {
    localStorage.setItem(LS_SOUND, soundEnabled ? 'on' : 'off')
  }, [soundEnabled])

  // viewVariant persistence + body class (Dashboard rewrite'ı geldiğinde
  // workspace/mission/editorial layout'ları seçecek).
  useEffect(() => {
    localStorage.setItem(LS_VIEW, viewVariant)
    document.body.classList.remove('view-workspace', 'view-mission', 'view-editorial')
    document.body.classList.add(`view-${viewVariant}`)
  }, [viewVariant])

  // editMode body class — noc.css'te .nm-root.edit-mode .nm-card pattern'i
  // zaten var (Dashboard widget drag handle gibi feature'lar açar).
  useEffect(() => {
    document.body.classList.toggle('edit-mode', editMode)
  }, [editMode])

  // saved layouts persistence
  useEffect(() => {
    try { localStorage.setItem(LS_SAVED, JSON.stringify(savedLayouts)) } catch { /* quota */ }
  }, [savedLayouts])

  const playBeep = () => { if (soundEnabled) playAlertBeep() }

  // Bir preset veya saved layout uygula — id'ye bakar.
  const applyLayout = (id: string) => {
    const preset = PRESET_LAYOUTS.find((p) => p.id === id)
    if (preset) {
      const c = preset.config
      if (c.density) setDensityState(c.density)
      if (c.menuPosition) setMenuState(c.menuPosition)
      if (c.viewVariant) setViewState(c.viewVariant)
      if (c.accent) setAccentState(c.accent)
      return
    }
    const saved = savedLayouts.find((s) => s.id === id)
    if (saved) {
      setDensityState(saved.config.density)
      setMenuState(saved.config.menuPosition)
      setViewState(saved.config.viewVariant)
      setAccentState(saved.config.accent)
    }
  }

  // Mevcut config'i isimli olarak kaydet.
  const saveLayout = (name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    setSavedLayouts((prev) => [
      ...prev.filter((s) => s.name.toLowerCase() !== trimmed.toLowerCase()),
      {
        id: `s${Date.now()}`,
        name: trimmed,
        ts: Date.now(),
        config: { density, menuPosition, viewVariant, accent },
      },
    ])
  }
  const deleteLayout = (id: string) => {
    setSavedLayouts((prev) => prev.filter((s) => s.id !== id))
  }

  const reset = () => {
    setDensityState(DEFAULT_DENSITY)
    setMenuState(DEFAULT_MENU)
    setAccentState(DEFAULT_ACCENT)
    setSoundState(DEFAULT_SOUND)
    setViewState(DEFAULT_VIEW)
    setEditModeState(false)
  }

  return (
    <CustomizeContext.Provider value={{
      density, setDensity: setDensityState,
      menuPosition, setMenuPosition: setMenuState,
      accent, setAccent: setAccentState,
      viewVariant, setViewVariant: setViewState,
      soundEnabled, setSoundEnabled: setSoundState,
      playBeep,
      editMode, setEditMode: setEditModeState,
      savedLayouts, saveLayout, applyLayout, deleteLayout,
      reset,
    }}>
      {children}
    </CustomizeContext.Provider>
  )
}

export const useCustomize = () => useContext(CustomizeContext)
