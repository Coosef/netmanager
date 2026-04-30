import { useRef, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react'
import ForceGraph3D from 'react-force-graph-3d'
import * as THREE from 'three'
import type { TopologyGraph } from '@/api/topology'

// Neon TV palette — always dark
const VENDOR_COLOR: Record<string, number> = {
  cisco:    0x1a7fd4,
  aruba:    0xff8c00,
  ruijie:   0xff2244,
  fortinet: 0xff4422,
  mikrotik: 0x00ccaa,
  juniper:  0x44dd88,
  other:    0x4488bb,
}

const STATUS_EMISSIVE: Record<string, number> = {
  online:      0x00e676,
  offline:     0xff3d6a,
  unknown:     0x445566,
  unreachable: 0xffb300,
}

const STATUS_EMISSIVE_INTENSITY: Record<string, number> = {
  online:      0.7,
  offline:     0.5,
  unknown:     0.1,
  unreachable: 0.5,
}

const LAYER_Y: Record<string, number> = {
  core:         120,
  distribution: 60,
  access:       0,
  edge:         -60,
  wireless:     -120,
}

const LAYER_RADIUS: Record<string, number> = {
  core:         10,
  distribution: 8,
  access:       6,
  edge:         5,
  wireless:     4,
}

interface Props {
  graph: TopologyGraph
  isDark: boolean
  width: number
  height: number
  onNodeClick?: (deviceId: number) => void
  searchQuery?: string
}

export interface Topology3DHandle {
  flyToQuery: (q: string) => void
}

const Topology3D = forwardRef<Topology3DHandle, Props>(function Topology3D(
  { graph, width, height, onNodeClick, searchQuery },
  ref,
) {
  const fgRef = useRef<any>(null)

  useImperativeHandle(ref, () => ({
    flyToQuery: (q: string) => {
      if (!fgRef.current) return
      const data = fgRef.current.graphData() as { nodes: any[] }
      const ql = q.trim().toLowerCase()
      const match = data.nodes.find((n: any) =>
        (n.label || '').toLowerCase().includes(ql) || (n.ip || '').toLowerCase().includes(ql)
      )
      if (!match) return
      const distance  = 90
      const distRatio = 1 + distance / Math.hypot(match.x || 1, match.y || 1, match.z || 1)
      fgRef.current.cameraPosition(
        { x: (match.x || 0) * distRatio, y: (match.y || 0) * distRatio, z: (match.z || 0) * distRatio },
        match,
        1200,
      )
    },
  }), [])

  const graphData = useMemo(() => {
    const q = searchQuery?.trim()?.toLowerCase() || ''
    const nodes = graph.nodes.map((n) => {
      const isGhost = n.type === 'ghostNode'
      const layer   = n.data.layer || ''
      const label   = (n.data.label || '').toLowerCase()
      const ip      = (n.data.ip || '').toLowerCase()
      const dimmed  = q ? (!label.includes(q) && !ip.includes(q)) : false
      return {
        id:        n.id,
        label:     n.data.label || '',
        ip:        n.data.ip || '',
        vendor:    n.data.vendor || 'other',
        status:    n.data.status || 'unknown',
        layer,
        device_id: n.data.device_id,
        ghost:     isGhost,
        dimmed,
        fy:        isGhost ? undefined : (LAYER_Y[layer] ?? 0),
      }
    })
    const links = graph.edges.map((e) => ({
      source: e.source,
      target: e.target,
      label:  e.label || '',
    }))
    return { nodes, links }
  }, [graph])

  const nodeThreeObject = useCallback((node: any) => {
    const vendorColor   = VENDOR_COLOR[node.vendor] || VENDOR_COLOR.other
    const emissiveColor = STATUS_EMISSIVE[node.status] || STATUS_EMISSIVE.unknown
    const emissiveInt   = STATUS_EMISSIVE_INTENSITY[node.status] || 0.1
    const radius        = node.ghost ? 3.5 : (LAYER_RADIUS[node.layer] ?? 6)

    const group = new THREE.Group()

    // Core sphere
    const geo = new THREE.SphereGeometry(radius, 24, 24)
    const isDimmed  = !!node.dimmed
    const opacity   = node.ghost ? 0.45 : (isDimmed ? 0.08 : 1)
    const mat = new THREE.MeshPhongMaterial({
      color:            vendorColor,
      emissive:         emissiveColor,
      emissiveIntensity: isDimmed ? 0 : emissiveInt,
      shininess:        160,
      transparent:      node.ghost || isDimmed,
      opacity,
    })
    if (node.ghost) mat.wireframe = true
    group.add(new THREE.Mesh(geo, mat))

    // Status glow ring
    if (!node.ghost) {
      const ringGeo = new THREE.RingGeometry(radius + 1.5, radius + 3.2, 36)
      const ringMat = new THREE.MeshBasicMaterial({
        color:       emissiveColor,
        transparent: true,
        opacity:     node.status === 'online' ? 0.55 : 0.25,
        side:        THREE.DoubleSide,
      })
      const ring = new THREE.Mesh(ringGeo, ringMat)
      ring.rotation.x = Math.PI / 2
      group.add(ring)
    }

    // Core layer: double ring
    if (node.layer === 'core' && !node.ghost) {
      const outerGeo = new THREE.RingGeometry(radius + 4, radius + 5.5, 36)
      const outerMat = new THREE.MeshBasicMaterial({
        color:       vendorColor,
        transparent: true,
        opacity:     0.2,
        side:        THREE.DoubleSide,
      })
      const outer = new THREE.Mesh(outerGeo, outerMat)
      outer.rotation.x = Math.PI / 2
      group.add(outer)
    }

    // Canvas label
    const canvas = document.createElement('canvas')
    canvas.width  = 280
    canvas.height = 52
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, 280, 52)
    ctx.font      = 'bold 17px "SF Pro Display",system-ui,monospace'
    ctx.textAlign = 'center'
    // Shadow glow
    ctx.shadowColor = node.status === 'online' ? '#00e676' : node.status === 'offline' ? '#ff3d6a' : '#00d4ff'
    ctx.shadowBlur  = 8
    ctx.fillStyle   = '#ddeeff'
    ctx.fillText(
      node.label.length > 22 ? node.label.slice(0, 20) + '…' : node.label,
      140, 34,
    )

    const texture  = new THREE.CanvasTexture(canvas)
    const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true })
    const sprite   = new THREE.Sprite(spriteMat)
    sprite.scale.set(30, 6, 1)
    sprite.position.y = radius + 8
    group.add(sprite)

    return group
  }, [])

  const linkColorFn = useCallback(() => 'rgba(0,195,255,0.18)', [])
  const linkWidthFn = useCallback(() => 0.7, [])
  const particleColorFn = useCallback(() => '#00d4ff', [])

  const handleNodeClick = useCallback((node: any) => {
    if (node.device_id && onNodeClick) onNodeClick(node.device_id)
    if (fgRef.current) {
      const distance   = 90
      const distRatio  = 1 + distance / Math.hypot(node.x || 1, node.y || 1, node.z || 1)
      fgRef.current.cameraPosition(
        { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
        node,
        1000,
      )
    }
  }, [onNodeClick])

  useEffect(() => {
    if (!fgRef.current) return
    const scene    = fgRef.current.scene()
    const controls = fgRef.current.controls()
    if (!scene) return

    // Minimal ambient
    scene.add(new THREE.AmbientLight(0x112244, 0.6))

    // Key light (cool white)
    const dir = new THREE.DirectionalLight(0xaaccff, 1.1)
    dir.position.set(100, 200, 100)
    scene.add(dir)

    // Status accent lights
    const ptGreen = new THREE.PointLight(0x00e676, 2.5, 600)
    ptGreen.position.set(-200, 80, 200)
    scene.add(ptGreen)

    const ptBlue = new THREE.PointLight(0x00d4ff, 2.0, 500)
    ptBlue.position.set(0, 200, 0)
    scene.add(ptBlue)

    const ptPurple = new THREE.PointLight(0xa78bfa, 1.2, 400)
    ptPurple.position.set(200, -100, -200)
    scene.add(ptPurple)

    const ptRed = new THREE.PointLight(0xff3d6a, 0.8, 300)
    ptRed.position.set(-200, -150, -100)
    scene.add(ptRed)

    // Starfield — white + blue + purple tinted stars
    const makeStars = (count: number, color: number, size: number, opacity: number) => {
      const pos = new Float32Array(count * 3)
      for (let i = 0; i < pos.length; i++) pos[i] = (Math.random() - 0.5) * 3600
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      const mat = new THREE.PointsMaterial({ color, size, transparent: true, opacity, sizeAttenuation: true })
      return new THREE.Points(geo, mat)
    }
    scene.add(makeStars(5000, 0xffffff, 0.55, 0.50))
    scene.add(makeStars(1200, 0x88ccff, 0.80, 0.30))
    scene.add(makeStars(600,  0xaa88ff, 1.00, 0.25))
    scene.add(makeStars(300,  0x00e676, 0.70, 0.20))

    // Subtle grid floor
    const gridHelper = new THREE.GridHelper(1200, 40, 0x00d4ff, 0x001a2e)
    ;(gridHelper.material as THREE.Material).opacity = 0.06
    ;(gridHelper.material as THREE.Material).transparent = true
    gridHelper.position.y = -160
    scene.add(gridHelper)

    if (controls) {
      controls.autoRotate      = true
      controls.autoRotateSpeed = 0.35
      controls.enableDamping   = true
      controls.dampingFactor   = 0.07
    }
  }, [])

  return (
    <ForceGraph3D
      ref={fgRef}
      graphData={graphData}
      width={width}
      height={height}
      backgroundColor="#030c1e"
      nodeThreeObject={nodeThreeObject}
      nodeThreeObjectExtend={false}
      linkColor={linkColorFn}
      linkWidth={linkWidthFn}
      linkOpacity={0.45}
      linkDirectionalParticles={3}
      linkDirectionalParticleSpeed={0.004}
      linkDirectionalParticleWidth={1.8}
      linkDirectionalParticleColor={particleColorFn}
      onNodeClick={handleNodeClick}
      nodeLabel={(node: any) =>
        `<div style="background:rgba(3,12,30,0.96);color:#ddeeff;padding:10px 14px;border-radius:10px;font-size:12px;line-height:1.7;border:1px solid rgba(0,195,255,0.25);box-shadow:0 4px 20px rgba(0,195,255,0.1)">` +
        `<strong style="color:#00d4ff">${node.label}</strong><br/>` +
        (node.ip ? `<span style="color:#6080a0">IP: </span>${node.ip}<br/>` : '') +
        `<span style="color:#6080a0">Vendor: </span>${node.vendor}<br/>` +
        `<span style="color:#6080a0">Durum: </span><span style="color:${node.status === 'online' ? '#00e676' : node.status === 'offline' ? '#ff3d6a' : '#ffb300'}">${node.status}</span></div>`
      }
      enableNodeDrag
      enableNavigationControls
      showNavInfo={false}
      d3AlphaDecay={0.02}
      d3VelocityDecay={0.3}
      cooldownTicks={100}
    />
  )
})

export default Topology3D
