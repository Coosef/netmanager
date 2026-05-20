/**
 * EdgesLayer — the network fabric.
 *
 * Every edge is two vertices of one LineSegments mesh, driven by the
 * traffic shader (createTrafficEdgeMaterial). A single draw call for the
 * whole fabric; flow + atmospheric fade run on the GPU.
 */
import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { createTrafficEdgeMaterial } from './trafficShader'
import type { EdgeBuffers } from './sceneData'

export default function EdgesLayer({ edges }: { edges: EdgeBuffers }) {
  const material = useMemo(() => createTrafficEdgeMaterial(), [])

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(edges.positions, 3))
    g.setAttribute('aProgress', new THREE.BufferAttribute(edges.progress, 1))
    g.setAttribute('aColor', new THREE.BufferAttribute(edges.color, 3))
    g.setAttribute('aFlow', new THREE.BufferAttribute(edges.flow, 1))
    g.setAttribute('aSeed', new THREE.BufferAttribute(edges.seed, 1))
    return g
  }, [edges])

  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])

  useFrame((_s, delta) => {
    material.uniforms.uTime.value += delta
  })

  if (!edges.count) return null
  return <lineSegments geometry={geometry} material={material} frustumCulled={false} />
}
