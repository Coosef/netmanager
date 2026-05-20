/**
 * NodesLayer — instanced node rendering.
 *
 * One InstancedMesh per node class (core / distribution / access /
 * wireless / swarm / ghost / threat) plus one for cluster super-nodes —
 * a handful of draw calls for thousands of nodes. Compact tactical
 * geometry, differentiated by size + colour, never a geometry showcase.
 */
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import { NODE_CLASSES, NODE_CLASS_STYLE, type NodeClass } from './nodeClasses'
import type { InstanceRec } from './sceneData'

const _m = new THREE.Matrix4()
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _c = new THREE.Color()

function applyInstances(mesh: THREE.InstancedMesh, recs: InstanceRec[]) {
  recs.forEach((r, i) => {
    _p.set(r.pos[0], r.pos[1], r.pos[2])
    _s.setScalar(r.scale)
    _m.compose(_p, _q, _s)
    mesh.setMatrixAt(i, _m)
    mesh.setColorAt(i, _c.set(r.color))
  })
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  mesh.computeBoundingSphere()
}

function ClassGeometry({ kind }: { kind: NodeClass }) {
  switch (NODE_CLASS_STYLE[kind].geometry) {
    case 'box': return <boxGeometry args={[1.5, 1.5, 1.5]} />
    case 'tetra': return <tetrahedronGeometry args={[1.25]} />
    case 'point': return <sphereGeometry args={[0.7, 6, 6]} />
    default: return <octahedronGeometry args={[1, 0]} />
  }
}

interface MeshProps {
  cls: NodeClass
  instances: InstanceRec[]
  onSelect: (id: string) => void
}

function NodeClassMesh({ cls, instances, onSelect }: MeshProps) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const style = NODE_CLASS_STYLE[cls]

  useEffect(() => {
    if (ref.current) applyInstances(ref.current, instances)
  }, [instances])

  if (!instances.length) return null
  const handle = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    if (e.instanceId != null && instances[e.instanceId]) onSelect(instances[e.instanceId].id)
  }
  return (
    <instancedMesh
      key={instances.length}
      ref={ref}
      args={[undefined, undefined, instances.length]}
      onClick={handle}
      frustumCulled
    >
      <ClassGeometry kind={cls} />
      <meshStandardMaterial
        color="#ffffff"
        emissive={style.color}
        emissiveIntensity={style.emissive}
        metalness={0.15}
        roughness={0.55}
        transparent={cls === 'ghost'}
        opacity={cls === 'ghost' ? 0.5 : 1}
      />
    </instancedMesh>
  )
}

function ClusterMesh({ instances, onSelect }: { instances: InstanceRec[]; onSelect: (id: string) => void }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  useEffect(() => {
    if (ref.current) applyInstances(ref.current, instances)
  }, [instances])
  if (!instances.length) return null
  const handle = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    if (e.instanceId != null && instances[e.instanceId]) onSelect(instances[e.instanceId].id)
  }
  return (
    <instancedMesh
      key={instances.length}
      ref={ref}
      args={[undefined, undefined, instances.length]}
      onClick={handle}
      frustumCulled
    >
      <icosahedronGeometry args={[1, 1]} />
      <meshStandardMaterial
        color="#ffffff"
        emissive="#1e293b"
        emissiveIntensity={0.3}
        metalness={0.2}
        roughness={0.4}
        transparent
        opacity={0.42}
        wireframe
      />
    </instancedMesh>
  )
}

interface NodesLayerProps {
  nodes: Record<NodeClass, InstanceRec[]>
  clusters: InstanceRec[]
  onSelect: (id: string) => void
}

export default function NodesLayer({ nodes, clusters, onSelect }: NodesLayerProps) {
  return (
    <>
      {NODE_CLASSES.map((cls) => (
        <NodeClassMesh key={cls} cls={cls} instances={nodes[cls]} onSelect={onSelect} />
      ))}
      <ClusterMesh instances={clusters} onSelect={onSelect} />
    </>
  )
}
