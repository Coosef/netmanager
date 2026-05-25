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
    paletteName: string        // ACCENT_PALETTES'tan birinin adı
    accent: string             // veya doğrudan hex (geriye uyumluluk)
  }>
}
export const PRESET_LAYOUTS: PresetLayout[] = [
  {
    id: 'operator', name: 'Operatör', sub: 'Olay akışı + topoloji ön planda',
    config: { density: 'regular', menuPosition: 'side', viewVariant: 'workspace', paletteName: 'Mint' },
  },
  {
    id: 'admin', name: 'Network Admin', sub: 'Risk, drift, onaylar, uyumluluk',
    config: { density: 'compact', menuPosition: 'side', viewVariant: 'workspace', paletteName: 'Ocean' },
  },
  {
    id: 'exec', name: 'Yönetici', sub: 'Editorial brief — günlük özet',
    config: { density: 'spacious', menuPosition: 'top', viewVariant: 'editorial', paletteName: 'Lime' },
  },
  {
    id: 'wall', name: 'NOC Duvarı', sub: 'Mission control — duvar ekranı',
    config: { density: 'compact', menuPosition: 'top', viewVariant: 'mission', paletteName: 'Sunset' },
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
    paletteName: string
  }
}

interface CustomizeCtx {
  density: Density
  setDensity: (d: Density) => void
  menuPosition: MenuPosition
  setMenuPosition: (p: MenuPosition) => void
  // accent: artık 3 renkli palet — primary `accent`, secondary `info`, tertiary `warn`.
  // Tek-renk seçim için custom hex'i 3'üne de uygula (info/warn'u kendi default'una bırak veya hex'in alt-renklerine).
  accent: string                              // primary hex (örn. "#5eead4")
  accentPalette: AccentPalette                // 3 renkli palet (preset veya custom)
  setAccent: (hex: string) => void            // sadece primary'yi değiştirir (custom mod)
  setAccentPalette: (p: AccentPalette) => void
  viewVariant: ViewVariant
  setViewVariant: (v: ViewVariant) => void
  soundEnabled: boolean
  setSoundEnabled: (v: boolean) => void
  playBeep: () => void
  editMode: boolean
  setEditMode: (v: boolean) => void
  // Dashboard widget state — visible widgets'ı `hidden` ID listesinde
  // tutar (visible = ALL_WIDGETS \ hidden); `order` görüntülenme sırası.
  widgetHidden: string[]
  toggleWidget: (id: string) => void
  widgetOrder: string[]
  setWidgetOrder: (next: string[]) => void
  savedLayouts: SavedLayout[]
  saveLayout: (name: string) => void
  applyLayout: (id: string) => void
  deleteLayout: (id: string) => void
  reset: () => void
}

// Defaults — NOC mint paletini varsayılan olarak kullan.
const DEFAULT_DENSITY: Density = 'regular'
const DEFAULT_MENU: MenuPosition = 'side'
const DEFAULT_SOUND = false                   // varsayılan sessiz — kullanıcı isteyince açar
const DEFAULT_VIEW: ViewVariant = 'workspace'

// Tüm widget'lar — mockup customize-panel.jsx ALL_WIDGETS. ID'ler
// NocDashboard'da render sırasını belirler; hidden listesinde olanlar
// gizlenir.
export interface WidgetMeta { id: string; label: string; cat: string }
export const ALL_WIDGETS: WidgetMeta[] = [
  { id: 'risk',      label: 'Risk Dağılımı',       cat: 'intelligence' },
  { id: 'events',    label: 'Olay Akışı',          cat: 'monitoring' },
  { id: 'topo',      label: 'Topoloji Önizleme',   cat: 'monitoring' },
  { id: 'services',  label: 'Servis Etkisi',       cat: 'monitoring' },
  { id: 'worst',     label: 'En Sorunlu Cihazlar', cat: 'intelligence' },
  { id: 'agents',    label: 'Agent Filosu',        cat: 'monitoring' },
  { id: 'sla',       label: 'SLA Compliance',      cat: 'intelligence' },
  { id: 'drift',     label: 'Config Drift',        cat: 'config' },
  { id: 'approvals', label: 'Onay Bekleyenler',    cat: 'ops' },
  { id: 'probes',    label: 'Synthetic Probes',    cat: 'monitoring' },
  { id: 'anomalies', label: 'Anomali Feed',        cat: 'intelligence' },
  { id: 'vendors',   label: 'Vendor Dağılımı',     cat: 'inventory' },
]
const DEFAULT_ORDER = ALL_WIDGETS.map((w) => w.id)

// 3-renkli aksent paletleri — mockup customize-panel.jsx ACCENT_PALETTES.
// Her palet [primary (--accent), secondary (--info), tertiary (--warn-soft
// vurgu)] üçlüsünden oluşur. Kullanıcı tek hex de seçebilir (custom).
export interface AccentPalette {
  name: string
  colors: [string, string, string]   // [primary, secondary, tertiary]
}
export const ACCENT_PALETTES: AccentPalette[] = [
  { name: 'Mint',   colors: ['#5eead4', '#22c55e', '#f59e0b'] },
  { name: 'Vivid',  colors: ['#8b5cf6', '#3b82f6', '#ec4899'] },
  { name: 'Lime',   colors: ['#a3e635', '#eab308', '#f97316'] },
  { name: 'Ocean',  colors: ['#0ea5e9', '#10b981', '#f43f5e'] },
  { name: 'Sunset', colors: ['#f97316', '#fb7185', '#facc15'] },
  { name: 'Slate',  colors: ['#94a3b8', '#cbd5e1', '#f1f5f9'] },
]
// Geriye uyumluluk için tek-renk preset listesi (CustomizePanel'in
// custom hex section'unda kullanılır).
export const ACCENT_PRESETS: { name: string; hex: string }[] =
  ACCENT_PALETTES.map((p) => ({ name: p.name, hex: p.colors[0] }))

// Default palette — Mint (NOC teal+green+orange).
const DEFAULT_PALETTE: AccentPalette = ACCENT_PALETTES[0]
const DEFAULT_ACCENT: string = DEFAULT_PALETTE.colors[0]

const CustomizeContext = createContext<CustomizeCtx>({
  density: DEFAULT_DENSITY,
  setDensity: () => {},
  menuPosition: DEFAULT_MENU,
  setMenuPosition: () => {},
  accent: DEFAULT_ACCENT,
  accentPalette: DEFAULT_PALETTE,
  setAccent: () => {},
  setAccentPalette: () => {},
  viewVariant: DEFAULT_VIEW,
  setViewVariant: () => {},
  soundEnabled: DEFAULT_SOUND,
  setSoundEnabled: () => {},
  playBeep: () => {},
  editMode: false,
  setEditMode: () => {},
  widgetHidden: [],
  toggleWidget: () => {},
  widgetOrder: DEFAULT_ORDER,
  setWidgetOrder: () => {},
  savedLayouts: [],
  saveLayout: () => {},
  applyLayout: () => {},
  deleteLayout: () => {},
  reset: () => {},
})

const LS_DENSITY = 'nm-customize-density'
const LS_MENU = 'nm-customize-menu'
const LS_ACCENT = 'nm-customize-accent'
const LS_PALETTE = 'nm-customize-palette'    // palette name (Mint/Vivid/...) veya 'custom'
const LS_SOUND = 'nm-customize-sound'
const LS_VIEW = 'nm-customize-view'
const LS_SAVED = 'nm-customize-saved'
const LS_HIDDEN = 'nm-customize-widget-hidden'
const LS_ORDER = 'nm-customize-widget-order'

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
function loadPalette(): AccentPalette {
  const name = localStorage.getItem(LS_PALETTE)
  if (!name) return DEFAULT_PALETTE
  const found = ACCENT_PALETTES.find((p) => p.name === name)
  return found ?? DEFAULT_PALETTE
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
function loadHidden(): string[] {
  try {
    const v = localStorage.getItem(LS_HIDDEN)
    if (!v) return []
    const arr = JSON.parse(v)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []
  } catch { return [] }
}
function loadOrder(): string[] {
  try {
    const v = localStorage.getItem(LS_ORDER)
    if (!v) return DEFAULT_ORDER
    const arr = JSON.parse(v)
    if (!Array.isArray(arr)) return DEFAULT_ORDER
    // Ensure all ALL_WIDGETS ids appear in the order — append any missing.
    const valid = arr.filter((x): x is string => typeof x === 'string' && DEFAULT_ORDER.includes(x))
    const missing = DEFAULT_ORDER.filter((x) => !valid.includes(x))
    return [...valid, ...missing]
  } catch { return DEFAULT_ORDER }
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
  const [accentPalette, setPaletteState] = useState<AccentPalette>(loadPalette)
  const [soundEnabled, setSoundState] = useState<boolean>(loadSound)
  const [viewVariant, setViewState] = useState<ViewVariant>(loadView)
  const [editMode, setEditModeState] = useState<boolean>(false)
  const [widgetHidden, setWidgetHidden] = useState<string[]>(loadHidden)
  const [widgetOrder, setWidgetOrderState] = useState<string[]>(loadOrder)
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

  // accent + palette — 3 rengi de :root'a uygula:
  //   primary  → --accent + --accent-soft + --accent-line
  //   secondary→ --info + --info-soft         (var olan secondary slot)
  //   tertiary → --warn yerine alternatif vurgu kanalı; bu sürümde
  //              status warn'a dokunmuyoruz çünkü kritik/uyarı semantik
  //              (sarı/turuncu doku); palette tertiary'sini sadece
  //              CSS custom property `--accent-2` olarak expose ediyoruz
  //              (Dashboard widget'ları kullanabilsin).
  useEffect(() => {
    localStorage.setItem(LS_ACCENT, accent)
    localStorage.setItem(LS_PALETTE, accentPalette.name)
    const root = document.documentElement
    const [primary, secondary, tertiary] = accentPalette.colors
    // Aktif palette varsa onun renklerini kullan; kullanıcı custom hex
    // seçtiyse (accent !== primary), primary'yi accent'le ezeriz.
    const eff = accent.toLowerCase() === primary.toLowerCase() ? primary : accent
    root.style.setProperty('--accent', eff)
    root.style.setProperty('--accent-soft', hexAlpha(eff, 36))
    root.style.setProperty('--accent-line', hexAlpha(eff, 89))
    // Secondary → --info (link/info accent)
    root.style.setProperty('--info', secondary)
    root.style.setProperty('--info-soft', hexAlpha(secondary, 36))
    // Tertiary → ek slot. Dashboard widget'ları "--accent-2" ile alabilir.
    root.style.setProperty('--accent-2', tertiary)
    root.style.setProperty('--accent-2-soft', hexAlpha(tertiary, 36))
  }, [accent, accentPalette])

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

  // widget hidden + order persistence
  useEffect(() => {
    try { localStorage.setItem(LS_HIDDEN, JSON.stringify(widgetHidden)) } catch { /* quota */ }
  }, [widgetHidden])
  useEffect(() => {
    try { localStorage.setItem(LS_ORDER, JSON.stringify(widgetOrder)) } catch { /* quota */ }
  }, [widgetOrder])

  const toggleWidget = (id: string) => {
    setWidgetHidden((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }
  const setWidgetOrder = (next: string[]) => setWidgetOrderState(next)

  const playBeep = () => { if (soundEnabled) playAlertBeep() }

  // Palette değişince accent'i palette'in primary'sine al — kullanıcı
  // bir palette seçtiğinde "Mint primary"yi otomatik aktif etmek için.
  const setAccentPalette = (p: AccentPalette) => {
    setPaletteState(p)
    setAccentState(p.colors[0])
  }

  // Bir preset veya saved layout uygula — id'ye bakar.
  // preset.config.paletteName ile palette de değiştirilebilir.
  const applyLayout = (id: string) => {
    const preset = PRESET_LAYOUTS.find((p) => p.id === id)
    if (preset) {
      const c = preset.config
      if (c.density) setDensityState(c.density)
      if (c.menuPosition) setMenuState(c.menuPosition)
      if (c.viewVariant) setViewState(c.viewVariant)
      if (c.paletteName) {
        const p = ACCENT_PALETTES.find((x) => x.name === c.paletteName)
        if (p) { setPaletteState(p); setAccentState(p.colors[0]) }
      } else if (c.accent) {
        setAccentState(c.accent)
      }
      return
    }
    const saved = savedLayouts.find((s) => s.id === id)
    if (saved) {
      setDensityState(saved.config.density)
      setMenuState(saved.config.menuPosition)
      setViewState(saved.config.viewVariant)
      const p = ACCENT_PALETTES.find((x) => x.name === saved.config.paletteName)
      if (p) setPaletteState(p)
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
        config: { density, menuPosition, viewVariant, accent, paletteName: accentPalette.name },
      },
    ])
  }
  const deleteLayout = (id: string) => {
    setSavedLayouts((prev) => prev.filter((s) => s.id !== id))
  }

  const reset = () => {
    setDensityState(DEFAULT_DENSITY)
    setMenuState(DEFAULT_MENU)
    setPaletteState(DEFAULT_PALETTE)
    setAccentState(DEFAULT_ACCENT)
    setSoundState(DEFAULT_SOUND)
    setViewState(DEFAULT_VIEW)
    setEditModeState(false)
    setWidgetHidden([])
    setWidgetOrderState(DEFAULT_ORDER)
  }

  return (
    <CustomizeContext.Provider value={{
      density, setDensity: setDensityState,
      menuPosition, setMenuPosition: setMenuState,
      accent, accentPalette, setAccent: setAccentState, setAccentPalette,
      viewVariant, setViewVariant: setViewState,
      soundEnabled, setSoundEnabled: setSoundState,
      playBeep,
      editMode, setEditMode: setEditModeState,
      widgetHidden, toggleWidget,
      widgetOrder, setWidgetOrder,
      savedLayouts, saveLayout, applyLayout, deleteLayout,
      reset,
    }}>
      {children}
    </CustomizeContext.Provider>
  )
}

export const useCustomize = () => useContext(CustomizeContext)
