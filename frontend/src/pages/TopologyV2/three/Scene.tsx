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
import { buildSceneData } from './sceneData'
import type { LayoutMode } from './layout3d'
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
  onSelect: (id: string) => void
}

export default function Scene({
  model, collapsed, patchSignal, mode, cameraMode, focusNodeId, onSelect,
}: SceneProps) {
  const data = useMemo(
    () => buildSceneData(model, collapsed, mode),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, collapsed, mode, patchSignal],
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
