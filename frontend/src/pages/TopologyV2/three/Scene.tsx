/**
 * Scene — composes the isolated rendering systems of the 3D engine:
 * atmosphere, instanced nodes, the edge fabric and the camera rig.
 *
 * The scene derivation (`buildSceneData`) is memoised on the model +
 * cluster view + layout mode + patch signal, so a realtime patch
 * recomputes instances without a React subtree rebuild.
 */
import { useMemo } from 'react'
import type { TopologyModel } from '../graphModel'
import { buildSceneData, type OverlayContext } from './sceneData'
import { computeLayout, type LayoutMode } from './layout3d'
import NodesLayer from './NodesLayer'
import EdgesLayer from './EdgesLayer'
import Atmosphere from './Atmosphere'
import CameraRig, { type CameraMode } from './CameraRig'

interface SceneProps {
  model: TopologyModel
  collapsed: Set<string>
  patchSignal: number
  mode: LayoutMode
  cameraMode: CameraMode
  focusNodeId: string | null
  overlay?: OverlayContext
  onSelect: (id: string) => void
}

export default function Scene({
  model, collapsed, patchSignal, mode, cameraMode, focusNodeId, overlay, onSelect,
}: SceneProps) {
  // 3D positions are deterministic — recompute only when the graph
  // structure (node count) or the layout mode changes, NOT on every
  // realtime status patch.
  const layout = useMemo(
    () => computeLayout(model, mode),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, mode, model.graph.order],
  )

  // Re-bucket instances + repack edges on each patch / overlay change;
  // cheap, reuses the layout.
  const data = useMemo(
    () => buildSceneData(model, collapsed, layout, overlay),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, collapsed, layout, patchSignal, overlay],
  )

  const focus = focusNodeId ? data.layout.get(focusNodeId) ?? null : null

  return (
    <>
      <Atmosphere />
      <NodesLayer nodes={data.nodes} clusters={data.clusters} onSelect={onSelect} />
      <EdgesLayer edges={data.edges} />
      <CameraRig focus={focus} mode={cameraMode} />
    </>
  )
}
