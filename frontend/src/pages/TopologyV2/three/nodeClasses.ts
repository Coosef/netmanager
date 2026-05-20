/**
 * Node classes for the 3D tactical engine.
 *
 * Each class maps a topology node onto a compact, restrained tactical
 * representation — differentiated by size + colour, NOT by flashy
 * geometry. Devices of one class share a single InstancedMesh.
 */

export type NodeClass =
  | 'core' | 'distribution' | 'access' | 'wireless'
  | 'swarm' | 'ghost' | 'threat'

export const NODE_CLASSES: NodeClass[] = [
  'core', 'distribution', 'access', 'wireless', 'swarm', 'ghost', 'threat',
]

export interface NodeClassStyle {
  /** Base colour (hex). */
  color: string
  /** Base instance scale (world units). */
  size: number
  /** Geometry family — kept deliberately minimal / tactical. */
  geometry: 'octahedron' | 'box' | 'tetra' | 'point'
  /** Emissive intensity 0..1 — a quiet inner glow, never neon. */
  emissive: number
}

export const NODE_CLASS_STYLE: Record<NodeClass, NodeClassStyle> = {
  core:         { color: '#3b82f6', size: 7.0, geometry: 'octahedron', emissive: 0.35 },
  distribution: { color: '#06b6d4', size: 5.5, geometry: 'octahedron', emissive: 0.28 },
  access:       { color: '#22c55e', size: 4.0, geometry: 'box',        emissive: 0.20 },
  wireless:     { color: '#ec4899', size: 3.6, geometry: 'tetra',      emissive: 0.24 },
  swarm:        { color: '#f472b6', size: 2.0, geometry: 'point',      emissive: 0.16 },
  ghost:        { color: '#52617a', size: 3.0, geometry: 'octahedron', emissive: 0.08 },
  threat:       { color: '#ef4444', size: 6.2, geometry: 'octahedron', emissive: 0.55 },
}

const SWARM_ROLES = new Set(['client', 'phone', 'printer', 'camera', 'laptop'])

/**
 * Classify a graphology node's attributes into a tactical node class.
 * `threat` is assigned by the T5 anomaly layer — never here.
 */
export function classifyNode(attr: {
  nodeKind?: string
  layer?: string | null
  device_role?: string | null
  raw?: { data?: { device_role?: string | null } }
}): NodeClass {
  if (attr.nodeKind === 'ghost') return 'ghost'

  const role = (attr.device_role || attr.raw?.data?.device_role || '').toLowerCase()
  if (role === 'ap') return 'wireless'
  if (SWARM_ROLES.has(role)) return 'swarm'

  switch ((attr.layer || '').toLowerCase()) {
    case 'core': return 'core'
    case 'distribution': return 'distribution'
    case 'access': return 'access'
    case 'edge': return 'access'
    case 'wireless': return 'wireless'
    default: return 'access'
  }
}

/** Status → instance tint multiplier (dimmed offline, amber unreachable). */
export function statusTint(status?: string): { mul: number; override?: string } {
  switch (status) {
    case 'offline': return { mul: 1, override: '#ef4444' }
    case 'unreachable': return { mul: 1, override: '#f59e0b' }
    case 'unknown': return { mul: 0.55 }
    default: return { mul: 1 }
  }
}
