/**
 * CameraRig — the cinematic camera system.
 *
 * OrbitControls supplies tactical orbit with damping + inertia. On top:
 * incident focus (smooth target lerp to a selected node) and a
 * data-stream traversal mode (a slow guided drift). Easing is frame-rate
 * independent.
 */
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'

export type CameraMode = 'orbit' | 'traverse'

interface CameraRigProps {
  /** World position to ease the orbit target onto (incident focus). */
  focus: [number, number, number] | null
  mode: CameraMode
}

export default function CameraRig({ focus, mode }: CameraRigProps) {
  // OrbitControls instance (three-stdlib) — loose ref type avoids a
  // direct dependency on three-stdlib's d.ts.
  const controls = useRef<{ target: THREE.Vector3; autoRotate: boolean; update: () => void } | null>(null)
  const desired = useRef(new THREE.Vector3())

  useFrame((_state, delta) => {
    const c = controls.current
    if (!c) return
    c.autoRotate = mode === 'traverse'
    if (focus) {
      desired.current.set(focus[0], focus[1], focus[2])
      // critically-damped-ish ease — frame-rate independent
      const k = 1 - Math.pow(0.0025, delta)
      c.target.lerp(desired.current, k)
      c.update()
    }
  })

  return (
    <OrbitControls
      // @ts-expect-error — drei forwards the three-stdlib instance
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.085}
      rotateSpeed={0.62}
      zoomSpeed={0.85}
      autoRotateSpeed={0.32}
      minDistance={60}
      maxDistance={3200}
    />
  )
}
