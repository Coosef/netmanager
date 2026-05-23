// NocWallContext — Phase 2 NOC duvar modu (auto-rotation).
//
// Belirli sayfaları (Dashboard / Monitor / Topology / Services / Agents)
// kullanıcı belirlediği aralıkta otomatik gezer — kontrol odası/wall
// ekranı için. Pause/Next/Stop kontrolleri RotationOverlay'de.
// CustomizePanel'den ve ⌘K AKSIYON komutundan tetiklenir.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

// Cycle edilecek default route'lar — NOC için en kritik 5 sayfa.
const DEFAULT_ROUTES = [
  { path: '/',          label: 'Dashboard' },
  { path: '/monitor',   label: 'Uyarılar' },
  { path: '/topology',  label: 'Topoloji' },
  { path: '/services',  label: 'Servisler' },
  { path: '/agents',    label: 'Ajanlar' },
]
const DEFAULT_INTERVAL_SEC = 20

export interface WallRoute { path: string; label: string }

interface WallCtx {
  active: boolean
  paused: boolean
  routes: WallRoute[]
  currentIdx: number          // hangi route'tayız (rotation devam ederken)
  intervalSec: number
  start: (routes?: WallRoute[], intervalSec?: number) => void
  stop: () => void
  pause: () => void
  resume: () => void
  next: () => void
  setInterval: (s: number) => void
}

const NocWallContext = createContext<WallCtx>({
  active: false, paused: false,
  routes: DEFAULT_ROUTES, currentIdx: 0, intervalSec: DEFAULT_INTERVAL_SEC,
  start: () => {}, stop: () => {}, pause: () => {}, resume: () => {}, next: () => {},
  setInterval: () => {},
})

export function NocWallProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const [active, setActive] = useState(false)
  const [paused, setPaused] = useState(false)
  const [routes, setRoutes] = useState<WallRoute[]>(DEFAULT_ROUTES)
  const [currentIdx, setCurrentIdx] = useState(0)
  const [intervalSec, setIntervalSecState] = useState(DEFAULT_INTERVAL_SEC)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
  }

  // Aktif + paused değil ise her N saniyede next route'a geç.
  useEffect(() => {
    if (!active || paused) { clearTimer(); return }
    clearTimer()
    timerRef.current = setTimeout(() => {
      setCurrentIdx((i) => {
        const nx = (i + 1) % routes.length
        navigate(routes[nx].path)
        return nx
      })
    }, intervalSec * 1000)
    return () => clearTimer()
  }, [active, paused, currentIdx, intervalSec, routes, navigate])

  const start = useCallback((rs?: WallRoute[], sec?: number) => {
    const finalRoutes = rs && rs.length > 0 ? rs : DEFAULT_ROUTES
    const finalSec = typeof sec === 'number' && sec > 0 ? sec : DEFAULT_INTERVAL_SEC
    setRoutes(finalRoutes)
    setIntervalSecState(finalSec)
    setCurrentIdx(0)
    setPaused(false)
    setActive(true)
    // İlk route'a hemen git
    navigate(finalRoutes[0].path)
  }, [navigate])

  const stop = useCallback(() => { setActive(false); setPaused(false); clearTimer() }, [])
  const pause = useCallback(() => setPaused(true), [])
  const resume = useCallback(() => setPaused(false), [])
  const next = useCallback(() => {
    setCurrentIdx((i) => {
      const nx = (i + 1) % routes.length
      navigate(routes[nx].path)
      return nx
    })
  }, [routes, navigate])
  const setInterval = useCallback((s: number) => { if (s > 0) setIntervalSecState(s) }, [])

  return (
    <NocWallContext.Provider value={{
      active, paused, routes, currentIdx, intervalSec,
      start, stop, pause, resume, next, setInterval,
    }}>
      {children}
    </NocWallContext.Provider>
  )
}

export const useNocWall = () => useContext(NocWallContext)
