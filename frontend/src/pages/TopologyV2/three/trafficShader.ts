/**
 * Traffic edge shader — GPU-driven directional flow for the 3D engine.
 *
 * One ShaderMaterial drives every edge of a LineSegments mesh. Flow is
 * a subtle, low-amplitude pulse travelling source→target, its intensity
 * scaled per-edge by utilization (`aFlow`). Idle links are near-static;
 * only loaded links visibly move. Deliberately restrained — enterprise
 * tactical, not cyberpunk. Atmospheric depth fade is applied in-shader.
 */
import * as THREE from 'three'

const VERT = /* glsl */ `
  attribute float aProgress;   // 0 at source, 1 at target
  attribute vec3  aColor;      // traffic-class colour
  attribute float aFlow;       // 0..1 utilization
  attribute float aSeed;       // per-edge phase offset
  varying float vProgress;
  varying vec3  vColor;
  varying float vFlow;
  varying float vSeed;
  varying float vFade;
  uniform float uFadeStart;
  uniform float uFadeEnd;
  void main() {
    vProgress = aProgress;
    vColor = aColor;
    vFlow = aFlow;
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = -mv.z;
    vFade = 1.0 - clamp((dist - uFadeStart) / (uFadeEnd - uFadeStart), 0.0, 0.85);
    gl_Position = projectionMatrix * mv;
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  varying float vProgress;
  varying vec3  vColor;
  varying float vFlow;
  varying float vSeed;
  varying float vFade;
  uniform float uTime;
  void main() {
    // a quiet always-on base so the fabric is legible at rest
    float base = 0.16;
    // directional flow — travels source→target, speed rises with load
    float phase = vProgress * 5.0 - uTime * (0.35 + vFlow * 0.9) + vSeed * 6.2831;
    float pulse = smoothstep(0.55, 1.0, sin(phase) * 0.5 + 0.5);
    float intensity = base + vFlow * pulse * 0.58;
    gl_FragColor = vec4(vColor, intensity * vFade);
  }
`

export function createTrafficEdgeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFadeStart: { value: 750 },
      uFadeEnd: { value: 1700 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  })
}
