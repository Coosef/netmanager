import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { locationsApi, type Location } from '@/api/locations'
import { useAuthStore } from '@/store/auth'

interface SiteCtx {
  activeSite: string | null
  setSite: (site: string | null) => void
  locations: Location[]
  sitesLoading: boolean
  /** Backward-compat: just the name strings */
  sites: string[]
}

const SiteContext = createContext<SiteCtx>({
  activeSite: null,
  setSite: () => {},
  locations: [],
  sitesLoading: false,
  sites: [],
})

export function SiteProvider({ children }: { children: ReactNode }) {
  const { token } = useAuthStore()
  const [activeSite, setActiveSiteState] = useState<string | null>(() => {
    return localStorage.getItem('nm-active-site') || null
  })

  const { data, isLoading: sitesLoading } = useQuery({
    queryKey: ['locations'],
    queryFn: () => locationsApi.list(),
    staleTime: 60_000,
    enabled: !!token,
  })

  const locations: Location[] = data?.items ?? []
  const sites: string[] = locations.map((l) => l.name)

  const setSite = useCallback((site: string | null) => {
    setActiveSiteState(site)
    if (site) {
      localStorage.setItem('nm-active-site', site)
    } else {
      localStorage.removeItem('nm-active-site')
    }
  }, [])

  // Clear stale site if location was deleted
  if (activeSite && sites.length > 0 && !sites.includes(activeSite)) {
    setSite(null)
  }

  return (
    <SiteContext.Provider value={{ activeSite, setSite, locations, sitesLoading, sites }}>
      {children}
    </SiteContext.Provider>
  )
}

export const useSite = () => useContext(SiteContext)
