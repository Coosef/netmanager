import { useRef, useEffect, useCallback, useMemo, useState, forwardRef, useImperativeHandle } from 'react'
import ForceGraph3D from 'react-force-graph-3d'
import * as THREE from 'three'
import type { TopologyGraph } from '@/api/topology'

// ─── Palette ────────────────────────────────────────────────────────────────
const VENDOR_COLOR: Record<string, number> = {
  cisco: 0x1a7fd4, aruba: 0xff8c00, ruijie: 0xff2244,
  fortinet: 0xff4422, mikrotik: 0x00ccaa, juniper: 0x44dd88, other: 0x4488bb,
}
const STATUS_EMISSIVE: Record<string, number> = {
  online: 0x00e676, offline: 0xff3d6a, unknown: 0x445566, unreachable: 0xffb300,
}
const STATUS_EMISSIVE_INT: Record<string, number> = {
  online: 0.7, offline: 0.5, unknown: 0.1, unreachable: 0.5,
}

// ─── Layer config ────────────────────────────────────────────────────────────
const LAYER_CFG: Record<string, { y: number; color: number; hex: string; label: string; radius: number }> = {
  core:         { y: 200,  color: 0xef4444, hex: '#ef4444', label: 'CORE',         radius: 16 },
  distribution: { y: 100,  color: 0xf97316, hex: '#f97316', label: 'DISTRIBUTION', radius: 13 },
  access:       { y: 0,    color: 0x3b82f6, hex: '#3b82f6', label: 'ACCESS',       radius: 10 },
  edge:         { y: -100, color: 0x22c55e, hex: '#22c55e', label: 'EDGE',         radius: 8  },
  wireless:     { y: -200, color: 0xa855f7, hex: '#a855f7', label: 'WIRELESS',     radius: 7  },
}

// ─── BFS shortest path ───────────────────────────────────────────────────────
function bfsPath(nodes: any[], links: any[], srcId: string, dstId: string): string[] {
  const getId = (n: any) => (typeof n === 'object' ? n.id : n) as string
  const adj = new Map<string, string[]>()
  for (const n of nodes) adj.set(n.id, [])
  for (const l of links) {
    const s = getId(l.source); const t = getId(l.target)
    adj.get(s)?.push(t); adj.get(t)?.push(s)
  }
  const visited = new Set([srcId])
  const q: { id: string; path: string[] }[] = [{ id: srcId, path: [srcId] }]
  while (q.length) {
    const { id, path } = q.shift()!
    if (id === dstId) return path
    for (const next of (adj.get(id) ?? [])) {
      if (!visited.has(next)) { visited.add(next); q.push({ id: next, path: [...path, next] }) }
    }
  }
  return []
}

// ─── Canvas text sprite ──────────────────────────────────────────────────────
function makeTextSprite(text: string, color = '#ddeeff', glowColor = '#00d4ff'): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 320; canvas.height = 56
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, 320, 56)
  ctx.font = 'bold 17px "SF Pro Display",system-ui,monospace'
  ctx.textAlign = 'center'
  ctx.shadowColor = glowColor; ctx.shadowBlur = 10
  ctx.fillStyle = color
  ctx.fillText(text.length > 24 ? text.slice(0, 22) + '…' : text, 160, 38)
  const tex = new THREE.CanvasTexture(canvas)
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(38, 7, 1)
  return sprite
}

// ─── Types ───────────────────────────────────────────────────────────────────
interface Props {
  graph: TopologyGraph
  isDark: boolean
  width: number
  height: number
  onNodeClick?: (deviceId: number) => void
  searchQuery?: string
  pathMode?: boolean
  blastDeviceIds?: number[]
}

export interface Topology3DHandle {
  flyToQuery: (q: string) => void
  startTour: () => void
  stopTour: () => void
  clearPath: () => void
  clearIsolate: () => void
}

// ─── Component ───────────────────────────────────────────────────────────────
const Topology3D = forwardRef<Topology3DHandle, Props>(function Topology3D(
  { graph, width, height, onNodeClick, searchQuery, pathMode = false, blastDeviceIds = [] },
  ref,
) {
  const fgRef = useRef<any>(null)

  // Visual-mode refs
  const isolateIdRef  = useRef<string | null>(null)
  const pathSrcRef    = useRef<string | null>(null)
  const pathNodeIds   = useRef<Set<string>>(new Set())
  const pathLinkIds   = useRef<Set<string>>(new Set())
  const blastNodeIds  = useRef<Set<number>>(new Set())

  const [linkVis, setLinkVis] = useState(0)

  // Tour
  const tourTimer   = useRef<ReturnType<typeof setInterval> | null>(null)
  const tourIdxRef  = useRef(0)

  // Blast animation
  const blastRings  = useRef<Array<{ mesh: THREE.Mesh; age: number; maxAge: number }>>([])
  const rafRef      = useRef<number>(0)

  // Scene setup flag — ensures we only add lights/floors once
  const sceneReady  = useRef(false)

  // ── refreshNodes: traverse scene to find node objects directly ────────────
  // This approach works even when graphData prop changes (useMemo recreates objects)
  // because we use __graphObjType and __data set by the library on the actual Three.js objects
  const refreshNodes = useCallback(() => {
    if (!fgRef.current || typeof fgRef.current.scene !== 'function') return
    const scene = fgRef.current.scene() as THREE.Scene
    if (!scene) return

    // Get links for isolation neighbor calculation
    let links: any[] = []
    if (typeof fgRef.current.graphData === 'function') {
      try { links = (fgRef.current.graphData() as { links: any[] }).links } catch { /**/ }
    }

    const isolated = isolateIdRef.current

    // Build neighbor set for isolate
    let neighbors: Set<string> | null = null
    if (isolated) {
      neighbors = new Set([isolated])
      const getId = (x: any) => (typeof x === 'object' ? x.id : x) as string
      for (const l of links) {
        const s = getId(l.source); const t = getId(l.target)
        if (s === isolated) neighbors.add(t)
        if (t === isolated) neighbors.add(s)
      }
    }

    scene.traverse((obj: any) => {
      // Only process top-level node objects set by the library
      if (obj.__graphObjType !== 'node') return
      const n = obj.__data
      if (!n) return

      const isPath    = pathNodeIds.current.has(n.id)
      const isBlast   = blastNodeIds.current.has(n.device_id as number)
      const isIsoVis  = !isolated || neighbors!.has(n.id)
      const isPathSrc = n.id === pathSrcRef.current

      let opacity = n.ghost ? 0.45 : 1
      if (!isIsoVis) opacity = 0.03
      else if (n.dimmed) opacity = 0.08

      obj.traverse((child: any) => {
        if (child instanceof THREE.Mesh) {
          const mat = child.material as THREE.MeshPhongMaterial
          mat.transparent = opacity < 1
          mat.opacity = opacity
          if (isBlast && !n.ghost) {
            mat.emissive.setHex(0xff2222)
            mat.emissiveIntensity = 0.9
          } else if (isPath && !n.ghost) {
            mat.emissive.setHex(0xfbbf24)
            mat.emissiveIntensity = 0.8
          } else if (isPathSrc && !n.ghost) {
            mat.emissive.setHex(0xfbbf24)
            mat.emissiveIntensity = 1.0
          } else {
            mat.emissive.setHex(STATUS_EMISSIVE[n.status] ?? 0x445566)
            mat.emissiveIntensity = STATUS_EMISSIVE_INT[n.status] ?? 0.1
          }
        }
        if (child instanceof THREE.Sprite) {
          const mat = child.material as THREE.SpriteMaterial
          mat.opacity = Math.max(opacity, 0.03)
        }
      })
    })
  }, [])

  // ── Expose handle ──────────────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    flyToQuery: (q: string) => {
      if (!fgRef.current || typeof fgRef.current.graphData !== 'function') return
      const ql = q.trim().toLowerCase()
      const { nodes } = fgRef.current.graphData() as { nodes: any[] }
      const m = nodes.find((n: any) =>
        (n.label || '').toLowerCase().includes(ql) || (n.ip || '').toLowerCase().includes(ql))
      if (!m) return
      const nodePos = { x: m.x || 0, y: m.y || 0, z: m.z || 0 }
      const dist = Math.max(80, Math.hypot(nodePos.x, nodePos.y, nodePos.z) * 0.3 + 80)
      fgRef.current.cameraPosition(
        { x: nodePos.x + dist * 0.5, y: nodePos.y + dist * 0.7, z: nodePos.z + dist },
        nodePos, 1200)
    },
    startTour: () => {
      if (!fgRef.current) return
      const controls = fgRef.current.controls()
      if (controls) controls.autoRotate = false
      const tick = () => {
        if (!fgRef.current || typeof fgRef.current.graphData !== 'function') return
        const { nodes } = fgRef.current.graphData() as { nodes: any[] }
        const real = nodes.filter((n: any) => !n.ghost && n.x !== undefined)
        if (real.length === 0) return
        tourIdxRef.current = (tourIdxRef.current + 1) % real.length
        const m = real[tourIdxRef.current]
        const px = m.x || 0; const py = m.y || 0; const pz = m.z || 0
        // Camera flies to a position above and behind the node
        fgRef.current.cameraPosition(
          { x: px + 60, y: py + 90, z: pz + 120 },
          { x: px, y: py, z: pz }, 1800)
      }
      tick()
      tourTimer.current = setInterval(tick, 2800)
    },
    stopTour: () => {
      if (tourTimer.current) { clearInterval(tourTimer.current); tourTimer.current = null }
      const controls = fgRef.current?.controls()
      if (controls) controls.autoRotate = true
    },
    clearPath: () => {
      pathSrcRef.current = null
      pathNodeIds.current = new Set()
      pathLinkIds.current = new Set()
      setLinkVis((v) => v + 1)
      refreshNodes()
    },
    clearIsolate: () => {
      isolateIdRef.current = null
      refreshNodes()
    },
  }), [refreshNodes])

  // ── Graph data ─────────────────────────────────────────────────────────────
  const graphData = useMemo(() => {
    const q = searchQuery?.trim()?.toLowerCase() || ''
    const nodes = graph.nodes.map((n) => {
      const isGhost = n.type === 'ghostNode'
      const layer   = n.data.layer || ''
      const label   = (n.data.label || '').toLowerCase()
      const ip      = (n.data.ip   || '').toLowerCase()
      return {
        id: n.id, label: n.data.label || '', ip: n.data.ip || '',
        vendor: n.data.vendor || 'other', status: n.data.status || 'unknown',
        layer, device_id: n.data.device_id, ghost: isGhost,
        dimmed: q ? (!label.includes(q) && !ip.includes(q)) : false,
        // Soft Y guidance: nudge toward layer Y without hard-pinning
        // fy removed — let force simulation spread nodes freely in 3D
      }
    })
    const links = graph.edges.map((e) => ({
      id: `${e.source}|${e.target}`,
      source: e.source, target: e.target, label: e.label || '',
    }))
    return { nodes, links }
  }, [graph, searchQuery])

  // ── Node Three.js object builder ───────────────────────────────────────────
  const nodeThreeObject = useCallback((node: any) => {
    const vColor  = VENDOR_COLOR[node.vendor] || VENDOR_COLOR.other
    const eColor  = STATUS_EMISSIVE[node.status] || STATUS_EMISSIVE.unknown
    const eInt    = STATUS_EMISSIVE_INT[node.status] || 0.1
    const radius  = node.ghost ? 4 : (LAYER_CFG[node.layer]?.radius ?? 10)
    const group   = new THREE.Group()

    // Core sphere
    const geo = new THREE.SphereGeometry(radius, 24, 24)
    const op  = node.ghost ? 0.45 : (node.dimmed ? 0.08 : 1)
    const mat = new THREE.MeshPhongMaterial({
      color: vColor, emissive: eColor, emissiveIntensity: node.dimmed ? 0 : eInt,
      shininess: 160, transparent: node.ghost || node.dimmed, opacity: op,
    })
    if (node.ghost) mat.wireframe = true
    group.add(new THREE.Mesh(geo, mat))

    // Status glow ring
    if (!node.ghost) {
      const rg = new THREE.RingGeometry(radius + 2, radius + 4, 36)
      const rm = new THREE.MeshBasicMaterial({
        color: eColor, transparent: true,
        opacity: node.status === 'online' ? 0.55 : 0.25, side: THREE.DoubleSide,
      })
      const ring = new THREE.Mesh(rg, rm)
      ring.rotation.x = Math.PI / 2
      group.add(ring)
    }

    // Core layer extra ring
    if (node.layer === 'core' && !node.ghost) {
      const og = new THREE.RingGeometry(radius + 5, radius + 7, 36)
      const om = new THREE.MeshBasicMaterial({
        color: vColor, transparent: true, opacity: 0.2, side: THREE.DoubleSide,
      })
      const outer = new THREE.Mesh(og, om)
      outer.rotation.x = Math.PI / 2
      group.add(outer)
    }

    // Label sprite
    const glowCol = node.status === 'online' ? '#00e676' : node.status === 'offline' ? '#ff3d6a' : '#00d4ff'
    const sprite  = makeTextSprite(node.label, '#ddeeff', glowCol)
    sprite.position.y = radius + 12
    group.add(sprite)

    return group
  }, [])

  // ── Link color/width (reactive via linkVis) ────────────────────────────────
  const linkColorFn = useCallback((link: any) => {
    if (pathLinkIds.current.has(link.id as string)) return '#fbbf24'
    return 'rgba(0,195,255,0.18)'
  }, [linkVis])  // eslint-disable-line react-hooks/exhaustive-deps

  const linkWidthFn = useCallback((link: any) =>
    pathLinkIds.current.has(link.id as string) ? 3.5 : 0.8
  , [linkVis])  // eslint-disable-line react-hooks/exhaustive-deps

  const particleColorFn = useCallback((link: any) =>
    pathLinkIds.current.has(link.id as string) ? '#fbbf24' : '#00d4ff'
  , [linkVis])  // eslint-disable-line react-hooks/exhaustive-deps

  const particleSpeedFn = useCallback((link: any) =>
    pathLinkIds.current.has(link.id as string) ? 0.016 : 0.004
  , [linkVis])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Node click (normal OR path mode) ──────────────────────────────────────
  const handleNodeClick = useCallback((node: any) => {
    if (!fgRef.current) return

    if (pathMode) {
      if (!pathSrcRef.current) {
        pathSrcRef.current = node.id
        refreshNodes()
      } else if (pathSrcRef.current === node.id) {
        pathSrcRef.current = null
        pathNodeIds.current = new Set(); pathLinkIds.current = new Set()
        setLinkVis((v) => v + 1); refreshNodes()
      } else {
        // Find path using graphData for BFS (links need source/target resolved)
        if (typeof fgRef.current.graphData === 'function') {
          const { nodes, links } = fgRef.current.graphData() as { nodes: any[]; links: any[] }
          const path = bfsPath(nodes, links, pathSrcRef.current, node.id)
          pathNodeIds.current = new Set(path)
          const lids = new Set<string>()
          for (let i = 0; i < path.length - 1; i++) {
            lids.add(`${path[i]}|${path[i + 1]}`); lids.add(`${path[i + 1]}|${path[i]}`)
          }
          pathLinkIds.current = lids
          pathSrcRef.current = null
          setLinkVis((v) => v + 1); refreshNodes()
          // Fly to path midpoint
          if (path.length > 0) {
            const mid = nodes.find((n: any) => n.id === path[Math.floor(path.length / 2)])
            if (mid) {
              fgRef.current.cameraPosition(
                { x: (mid.x || 0) + 80, y: (mid.y || 0) + 100, z: (mid.z || 0) + 80 },
                { x: mid.x || 0, y: mid.y || 0, z: mid.z || 0 }, 1200)
            }
          }
        }
      }
      return
    }

    // Normal mode: open drawer + fly camera
    if (node.device_id && onNodeClick) onNodeClick(node.device_id)
    const px = node.x || 0; const py = node.y || 0; const pz = node.z || 0
    fgRef.current.cameraPosition(
      { x: px + 50, y: py + 70, z: pz + 80 },
      { x: px, y: py, z: pz }, 1000)
  }, [pathMode, onNodeClick, refreshNodes])

  // ── Right-click → isolate toggle ──────────────────────────────────────────
  const handleNodeRightClick = useCallback((node: any) => {
    if (isolateIdRef.current === node.id) {
      isolateIdRef.current = null
    } else {
      isolateIdRef.current = node.id
    }
    refreshNodes()
  }, [refreshNodes])

  // ── Refresh nodes when pathMode exits (skip initial mount) ────────────────
  const pathModeMountedRef = useRef(false)
  useEffect(() => {
    if (!pathModeMountedRef.current) { pathModeMountedRef.current = true; return }
    if (!pathMode) {
      pathSrcRef.current = null
      pathNodeIds.current = new Set(); pathLinkIds.current = new Set()
      setLinkVis((v) => v + 1); refreshNodes()
    }
  }, [pathMode, refreshNodes])

  // ── Blast radius: trigger animation when blastDeviceIds changes ───────────
  useEffect(() => {
    if (!blastDeviceIds.length) return
    blastNodeIds.current = new Set(blastDeviceIds)
    refreshNodes()

    if (!fgRef.current || typeof fgRef.current.scene !== 'function') return
    const scene = fgRef.current.scene() as THREE.Scene
    if (!fgRef.current || typeof fgRef.current.graphData !== 'function') return
    const { nodes } = fgRef.current.graphData() as { nodes: any[] }
    for (const devId of blastDeviceIds) {
      const n = nodes.find((nd: any) => nd.device_id === devId)
      if (!n) continue
      for (let wave = 0; wave < 3; wave++) {
        const rg  = new THREE.RingGeometry(10, 13, 32)
        const rm  = new THREE.MeshBasicMaterial({ color: 0xff2244, transparent: true, opacity: 0.6, side: THREE.DoubleSide })
        const mesh = new THREE.Mesh(rg, rm)
        mesh.position.set(n.x || 0, n.y || 0, n.z || 0)
        mesh.rotation.x = Math.PI / 2
        scene.add(mesh)
        blastRings.current.push({ mesh, age: wave * 0.4, maxAge: 2.5 })
      }
    }

    const t = setTimeout(() => {
      blastNodeIds.current = new Set()
      refreshNodes()
    }, 4000)
    return () => clearTimeout(t)
  }, [blastDeviceIds, refreshNodes])

  // ── RAF loop: animate blast rings ─────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick)
      if (blastRings.current.length === 0) return
      const scene = fgRef.current?.scene() as THREE.Scene | null
      blastRings.current = blastRings.current.filter(({ mesh, age, maxAge }) => {
        const t = age / maxAge
        mesh.scale.setScalar(1 + t * 5)
        ;(mesh.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - t)
        blastRings.current.find(r => r.mesh === mesh)!.age += 0.016
        if (age >= maxAge) { scene?.remove(mesh); return false }
        return true
      })
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(rafRef.current) }
  }, [])

  // ── Scene setup (runs once after engine stops, via onEngineStop) ──────────
  const setupScene = useCallback(() => {
    if (sceneReady.current) return
    if (!fgRef.current || typeof fgRef.current.scene !== 'function') return
    sceneReady.current = true

    const scene    = fgRef.current.scene() as THREE.Scene
    const controls = fgRef.current.controls()

    // Extra lights (library adds ambient + directional by default)
    const addPt = (color: number, int: number, dist: number, x: number, y: number, z: number) => {
      const l = new THREE.PointLight(color, int, dist); l.position.set(x, y, z); scene.add(l)
    }
    addPt(0x00e676, 2.5, 700, -200, 150, 200)
    addPt(0x00d4ff, 2.0, 600, 0, 300, 0)
    addPt(0xa78bfa, 1.2, 500, 200, -100, -200)
    addPt(0xff3d6a, 0.8, 400, -200, -150, -100)

    // Stars
    const makeStars = (count: number, color: number, size: number, op: number) => {
      const pos = new Float32Array(count * 3)
      for (let i = 0; i < pos.length; i++) pos[i] = (Math.random() - 0.5) * 4000
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      return new THREE.Points(geo, new THREE.PointsMaterial({ color, size, transparent: true, opacity: op, sizeAttenuation: true }))
    }
    scene.add(makeStars(5000, 0xffffff, 0.55, 0.50))
    scene.add(makeStars(1200, 0x88ccff, 0.80, 0.30))
    scene.add(makeStars(600,  0xaa88ff, 1.00, 0.25))
    scene.add(makeStars(300,  0x00e676, 0.70, 0.20))

    // Grid floor
    const grid = new THREE.GridHelper(1600, 40, 0x00d4ff, 0x001a2e)
    ;(grid.material as THREE.Material).opacity = 0.05
    ;(grid.material as THREE.Material).transparent = true
    grid.position.y = -240; scene.add(grid)

    // Layer floor planes
    for (const [, cfg] of Object.entries(LAYER_CFG)) {
      const planeGeo = new THREE.PlaneGeometry(800, 800)
      const planeMat = new THREE.MeshBasicMaterial({
        color: cfg.color, transparent: true, opacity: 0.018,
        side: THREE.DoubleSide,
      })
      const plane = new THREE.Mesh(planeGeo, planeMat)
      plane.rotation.x = -Math.PI / 2
      plane.position.y = cfg.y - 5
      scene.add(plane)

      // Border ring
      const borderGeo = new THREE.RingGeometry(370, 376, 64)
      const borderMat = new THREE.MeshBasicMaterial({
        color: cfg.color, transparent: true, opacity: 0.10,
        side: THREE.DoubleSide,
      })
      const border = new THREE.Mesh(borderGeo, borderMat)
      border.rotation.x = -Math.PI / 2
      border.position.y = cfg.y - 4
      scene.add(border)

      // Layer label sprite
      const canvas = document.createElement('canvas')
      canvas.width = 360; canvas.height = 48
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, 360, 48)
      ctx.font = 'bold 22px "SF Pro Display",system-ui,monospace'
      ctx.fillStyle = cfg.hex
      ctx.globalAlpha = 0.55
      ctx.shadowColor = cfg.hex; ctx.shadowBlur = 12
      ctx.textAlign = 'left'
      ctx.fillText(`— ${cfg.label}`, 8, 34)
      const tex    = new THREE.CanvasTexture(canvas)
      const sprMat = new THREE.SpriteMaterial({ map: tex, transparent: true })
      const spr    = new THREE.Sprite(sprMat)
      spr.scale.set(80, 10, 1)
      spr.position.set(-400, cfg.y, 0)
      scene.add(spr)
    }

    if (controls) {
      controls.autoRotate      = true
      controls.autoRotateSpeed = 0.30
      controls.enableDamping   = true
      controls.dampingFactor   = 0.07
    }
  }, [])

  // ── Engine stop: setup scene + refresh materials ───────────────────────────
  const handleEngineStop = useCallback(() => {
    setupScene()
    refreshNodes()
  }, [setupScene, refreshNodes])

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
      linkDirectionalParticleSpeed={particleSpeedFn}
      linkDirectionalParticleWidth={2}
      linkDirectionalParticleColor={particleColorFn}
      onNodeClick={handleNodeClick}
      onNodeRightClick={handleNodeRightClick}
      onEngineStop={handleEngineStop}
      nodeLabel={(node: any) =>
        `<div style="background:rgba(3,12,30,0.96);color:#ddeeff;padding:10px 14px;border-radius:10px;font-size:12px;line-height:1.8;border:1px solid rgba(0,195,255,0.25);box-shadow:0 4px 20px rgba(0,195,255,0.1)">` +
        `<strong style="color:#00d4ff">${node.label}</strong><br/>` +
        (node.ip ? `<span style="color:#6080a0">IP: </span>${node.ip}<br/>` : '') +
        (node.layer ? `<span style="color:#6080a0">Katman: </span><span style="color:${LAYER_CFG[node.layer]?.hex ?? '#94a3b8'}">${node.layer.toUpperCase()}</span><br/>` : '') +
        `<span style="color:#6080a0">Vendor: </span>${node.vendor}<br/>` +
        `<span style="color:#6080a0">Durum: </span><span style="color:${node.status === 'online' ? '#00e676' : node.status === 'offline' ? '#ff3d6a' : '#ffb300'}">${node.status}</span>` +
        `</div>`
      }
      enableNodeDrag
      enableNavigationControls
      showNavInfo={false}
      d3AlphaDecay={0.02}
      d3VelocityDecay={0.3}
      cooldownTicks={120}
    />
  )
})

export default Topology3D
