/**
 * T10 C7.C — Ports tab veri federasyonu ve effective policy resolver helper'ları.
 *
 * Backend'e yeni endpoint açmadan, client-side:
 *   - port_name başına MAC sayımı (mac_arp/mac-table → group by port)
 *   - effective policy (per-port override → cihaz default → org default → fallback)
 * hesaplar. port_name exact-match v1 (vendor format'ı interfaces ve override
 * tarafında AYNI string olmalı — C7 planında risk olarak yazılı).
 */
import type { PortPolicyAssignment } from '@/api/portPolicyAssignments'

export const FALLBACK_NAME = '(hardcoded-fallback)'
export const MAC_COUNT_CAP = 500  // mac-table limit; aşan port'larda "500+" göster

export type EffectiveSource = 'override' | 'cihaz-default' | 'org-default' | 'fallback'

export interface EffectivePolicy {
  policy_id: number | null   // null = fallback
  name: string                // hesaplanan ad (override'da policy id'sini policy listesinden çözmek için)
  source: EffectiveSource
}

interface PolicyMin { id: number; name: string; is_default?: boolean }

/**
 * Effective port policy zinciri:
 *   1) per-port override (overrides listesinde port adı eşleşmesi)
 *   2) cihaz default (deviceDefaultId)
 *   3) org default (portPolicies içinde is_default=true olan)
 *   4) hardcoded fallback (FALLBACK_NAME)
 *
 * @param portName interfaces'tan gelen port adı (vendor format'ı aynen)
 * @param overrides portPolicyAssignmentsApi.list() sonucu
 * @param deviceDefaultId device.port_security_policy_id
 * @param portPolicies securityPoliciesApi.list('port') sonucu
 */
export function effectivePortPolicy(
  portName: string,
  overrides: PortPolicyAssignment[],
  deviceDefaultId: number | null | undefined,
  portPolicies: PolicyMin[],
): EffectivePolicy {
  // 1) override
  const o = overrides.find((x) => x.port_name === portName)
  if (o) {
    const pol = portPolicies.find((p) => p.id === o.port_security_policy_id)
    return {
      policy_id: o.port_security_policy_id,
      name: pol?.name ?? `#${o.port_security_policy_id}`,
      source: 'override',
    }
  }
  // 2) cihaz default
  if (deviceDefaultId) {
    const pol = portPolicies.find((p) => p.id === deviceDefaultId)
    if (pol) return { policy_id: pol.id, name: pol.name, source: 'cihaz-default' }
  }
  // 3) org default
  const orgDef = portPolicies.find((p) => p.is_default)
  if (orgDef) return { policy_id: orgDef.id, name: orgDef.name, source: 'org-default' }
  // 4) fallback
  return { policy_id: null, name: FALLBACK_NAME, source: 'fallback' }
}

/**
 * mac-table satırlarını port_name başına gruplar; toplam cap=MAC_COUNT_CAP.
 * Cap'e ulaşan portlar UI'da "500+" gösterilebilir (isCapped flag).
 */
export function macCountByPort(
  items: { port?: string | null }[],
  cap: number = MAC_COUNT_CAP,
): Map<string, { count: number; isCapped: boolean }> {
  const counts = new Map<string, number>()
  let total = 0
  for (const m of items) {
    if (!m.port) continue
    counts.set(m.port, (counts.get(m.port) ?? 0) + 1)
    total++
  }
  const capped = total >= cap   // toplam cap'e değiyse hangi port'un kestiğini bilmiyoruz
  const out = new Map<string, { count: number; isCapped: boolean }>()
  for (const [k, v] of counts) out.set(k, { count: v, isCapped: capped })
  return out
}
