/**
 * Topology3D — the 3D tactical engine entry point.
 *
 * A custom react-three-fiber pipeline (no react-force-graph / wrapper
 * abstractions): instanced nodes, a shader-driven edge fabric, a
 * cinematic camera and restrained atmosphere. Consumes the same
 * org/location-scoped TopologyModel as the 2D engine — isolation is
 * inherited, not re-implemented.
 */
import { useState } from 'react'
import { Canvas } from '@react-three/fiber'
import type { TopologyModel } from '../graphModel'
import type { SelectedNode } from '../SigmaCanvas'
import Scene from './Scene'
import type { LayoutMode } from './layout3d'
import type { CameraMode } from './CameraRig'

interface Topology3DProps {
  model: TopologyModel
  collapsed: Set<string>
  patchSignal: number
  /** Tactical Orbit vs Harmonic Cluster layout. */
  mode: LayoutMode
  cameraMode: CameraMode
  onSelectNode: (node: SelectedNode | null) => void
  onExpandCluster: (clusterId: string) => void
}

export default function Topology3D({
  model, collapsed, patchSignal, mode, cameraMode, onSelectNode, onExpandCluster,
}: Topology3DProps) {
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null)

  const handleSelect = (id: string) => {
    const attr = model.graph.getNodeAttributes(id)
    if (attr.nodeKind === 'cluster') {
      onExpandCluster(id)
      return
    }
    setFocusNodeId(id) // incident focus — camera eases onto the node
    onSelectNode({ id, kind: attr.nodeKind, label: attr.label, raw: attr.raw })
  }

  return (
    <Canvas
      style={{ position: 'absolute', inset: 0 }}
      camera={{ position: [0, 320, 880], near: 1, far: 7000, fov: 55 }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      onPointerMissed={() => { setFocusNodeId(null); onSelectNode(null) }}
    >
      <Scene
        model={model}
        collapsed={collapsed}
        patchSignal={patchSignal}
        mode={mode}
        cameraMode={cameraMode}
        focusNodeId={focusNodeId}
        onSelect={handleSelect}
      />
    </Canvas>
  )
}
