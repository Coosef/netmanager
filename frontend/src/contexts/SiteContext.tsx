import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { locationsApi, type Location } from '@/api/locations'
import { useAuthStore } from '@/store/auth'
import { ACTIVE_LOCATION_KEY } from '@/api/client'

interface SiteCtx {
  /** Faz 7 — the active location id; null = ALL LOCATIONS in the org. */
  activeLocationId: number | null
  setLocation: (id: number | null) => void
  locations: Location[]
  sitesLoading: boolean
  /** Backward-compat: the active location's NAME, and the name list. */
  activeSite: string | null
  setSite: (site: string | null) => void
  sites: string[]
}

const SiteContext = createContext<SiteCtx>({
  activeLocationId: null,
  setLocation: () => {},
  locations: [],
  sitesLoading: false,
  activeSite: null,
  setSite: () => {},
  sites: [],
})

export function SiteProvider({ children }: { children: ReactNode }) {
  const { token } = useAuthStore()
  const queryClient = useQueryClient()

  const [activeLocationId, setActiveLocationIdState] = useState<number | null>(() => {
    const v = localStorage.getItem(ACTIVE_LOCATION_KEY)
    return v ? Number(v) : null
  })

  const { data, isLoading: sitesLoading } = useQuery({
    queryKey: ['locations'],
    queryFn: () => locationsApi.list(),
    staleTime: 60_000,
    enabled: !!token,
  })
  const locations: Location[] = data?.items ?? []
  const sites: string[] = locations.map((l) => l.name)

  const setLocation = useCallback(
    (id: number | null) => {
      setActiveLocationIdState(id)
      if (id != null) {
        localStorage.setItem(ACTIVE_LOCATION_KEY, String(id))
      } else {
        localStorage.removeItem(ACTIVE_LOCATION_KEY)
      }
      // Faz 7 — reactive scoped reload: every cached query is invalidated
      // so all data refetches under the new X-Location-Id header. This is
      // what guarantees no stale cross-scope data survives a switch.
      queryClient.invalidateQueries()
    },
    [queryClient],
  )

  // Backward-compat: components that still switch by location NAME.
  const setSite = useCallback(
    (site: string | null) => {
      if (site == null) {
        setLocation(null)
        return
      }
      const loc = locations.find((l) => l.name === site)
      setLocation(loc ? loc.id : null)
    },
    [locations, setLocation],
  )

  const activeSite =
    locations.find((l) => l.id === activeLocationId)?.name ?? null

  // If the active location no longer exists (deleted / org changed),
  // fall back to ALL LOCATIONS.
  useEffect(() => {
    if (
      activeLocationId != null &&
      locations.length > 0 &&
      !locations.some((l) => l.id === activeLocationId)
    ) {
      setLocation(null)
    }
  }, [activeLocationId, locations, setLocation])

  return (
    <SiteContext.Provider
      value={{
        activeLocationId,
        setLocation,
        locations,
        sitesLoading,
        activeSite,
        setSite,
        sites,
      }}
    >
      {children}
    </SiteContext.Provider>
  )
}

export const useSite = () => useContext(SiteContext)
