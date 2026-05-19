/**
 * Data access for the v2 topology engine.
 *
 * Strictly the v2 contract — `GET /topology/graph?v=2`. Org/location
 * scope is enforced server-side: the axios client attaches the bearer
 * token (org boundary) and the `X-Location-Id` header (location filter),
 * and PostgreSQL RLS scopes every row. The frontend never sends an org
 * id. The React Query key includes the active location so a location
 * switch fully refetches.
 */
import { useQuery } from '@tanstack/react-query'
import client from '@/api/client'
import { useSite } from '@/contexts/SiteContext'
import { validateTopologyGraphV2 } from './contract'
import type { TopologyGraphV2 } from './contract'

export interface TopologyGraphV2Params {
  groupId?: number
  site?: string
}

export async function fetchTopologyGraphV2(
  params: TopologyGraphV2Params = {},
  refresh = false,
): Promise<TopologyGraphV2> {
  const { data } = await client.get('/topology/graph', {
    params: {
      v: 2,
      group_id: params.groupId,
      site: params.site,
      refresh: refresh || undefined,
    },
  })
  return validateTopologyGraphV2(data)
}

/**
 * React Query hook for the v2 graph. Keyed by the active location so a
 * location switch (SiteContext) triggers a clean refetch under the new
 * `X-Location-Id` scope.
 */
export function useTopologyGraphV2(params: TopologyGraphV2Params = {}) {
  const { activeLocationId } = useSite()
  return useQuery({
    queryKey: ['topology-graph-v2', activeLocationId, params.groupId ?? null, params.site ?? null],
    queryFn: () => fetchTopologyGraphV2(params),
    staleTime: 30_000,
    refetchInterval: 60_000, // slow safety-net poll; T3 adds realtime patching
  })
}
