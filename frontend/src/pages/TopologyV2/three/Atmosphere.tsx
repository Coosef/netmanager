/**
 * Atmosphere — restrained enterprise-tactical depth.
 *
 * Exponential haze for atmospheric perspective (distant nodes recede,
 * never abruptly vanish), a slow parallax particle field for spatial
 * depth, and soft fill lighting. No cone lights, no clutter fog.
 */
import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

const HAZE = '#0a1322'
const PARTICLES = 460
const FIELD = 2600

export default function Atmosphere() {
  const { scene } = useThree()
  const points = useRef<THREE.Points>(null)

  // exponential haze — subtle, matched to the page background
  useMemo(() => {
    scene.fog = new THREE.FogExp2(HAZE, 0.00042)
    return null
  }, [scene])

  // faint parallax particle field
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const pos = new Float32Array(PARTICLES * 3)
    for (let i = 0; i < PARTICLES; i++) {
      pos[i * 3] = (Math.random() - 0.5) * FIELD
      pos[i * 3 + 1] = (Math.random() - 0.5) * FIELD * 0.6
      pos[i * 3 + 2] = (Math.random() - 0.5) * FIELD
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    return g
  }, [])

  useFrame((_s, delta) => {
    if (points.current) points.current.rotation.y += delta * 0.012
  })

  return (
    <>
      <ambientLight intensity={0.62} color="#cbd8ea" />
      <directionalLight position={[400, 600, 300]} intensity={0.5} color="#dce8ff" />
      <directionalLight position={[-500, -200, -400]} intensity={0.22} color="#5b6b85" />
      <points ref={points} geometry={geometry}>
        <pointsMaterial
          size={2.1}
          sizeAttenuation
          color="#3b4a63"
          transparent
          opacity={0.5}
          depthWrite={false}
        />
      </points>
    </>
  )
}
