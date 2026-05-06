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
  online: 0.6, offline: 0.4, unknown: 0.1, unreachable: 0.4,
}

// ─── Layer config ────────────────────────────────────────────────────────────
const LAYER_CFG: Record<string, { y: number; color: number; hex: string; label: string; radius: number }> = {
  core:         { y: 180,  color: 0xef4444, hex: '#ef4444', label: 'CORE',         radius: 14 },
  distribution: { y: 90,   color: 0xf97316, hex: '#f97316', label: 'DISTRIBUTION', radius: 11 },
  access:       { y: 0,    color: 0x3b82f6, hex: '#3b82f6', label: 'ACCESS',       radius: 9  },
  edge:         { y: -90,  color: 0x22c55e, hex: '#22c55e', label: 'EDGE',         radius: 7  },
  wireless:     { y: -180, color: 0xa855f7, hex: '#a855f7', label: 'WIRELESS',     radius: 6  },
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
  canvas.width = 256; canvas.height = 48
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, 256, 48)
  ctx.font = 'bold 15px system-ui,monospace'
  ctx.textAlign = 'center'
  ctx.shadowColor = glowColor; ctx.shadowBlur = 8
  ctx.fillStyle = color
  ctx.fillText(text.length > 20 ? text.slice(0, 18) + '…' : text, 128, 34)
  const tex = new THREE.CanvasTexture(canvas)
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(32, 6, 1)
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

  const isolateIdRef  = useRef<string | null>(null)
  const pathSrcRef    = useRef<string | null>(null)
  const pathNodeIds   = useRef<Set<string>>(new Set())
  const pathLinkIds   = useRef<Set<string>>(new Set())
  const blastNodeIds  = useRef<Set<number>>(new Set())

  const [linkVis, setLinkVis] = useState(0)

  const tourTimer  = useRef<ReturnType<typeof setInterval> | null>(null)
  const tourIdxRef = useRef(0)

  const blastRings = useRef<Array<{ mesh: THREE.Mesh; age: number; maxAge: number }>>([])
  const rafRef     = useRef<number>(0)
  const sceneReady = useRef(false)

  // ── refreshNodes: scene traversal (works even when graphData prop changes) ──
  const refreshNodes = useCallback(() => {
    if (!fgRef.current || typeof fgRef.current.scene !== 'function') return
    const scene = fgRef.current.scene() as THREE.Scene
    if (!scene) return

    let links: any[] = []
    try {
      if (typeof fgRef.current.graphData === 'function')
        links = (fgRef.current.graphData() as { links: any[] }).links
    } catch { /**/ }

    const isolated = isolateIdRef.current
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
          const mat = child.material as any
          mat.transparent = opacity < 1
          mat.opacity = opacity
          if (mat.emissive) {
            if (isBlast && !n.ghost) {
              mat.emissive.setHex(0xff2222); mat.emissiveIntensity = 0.9
            } else if ((isPath || isPathSrc) && !n.ghost) {
              mat.emissive.setHex(0xfbbf24); mat.emissiveIntensity = isPathSrc ? 1.0 : 0.8
            } else {
              mat.emissive.setHex(STATUS_EMISSIVE[n.status] ?? 0x445566)
              mat.emissiveIntensity = STATUS_EMISSIVE_INT[n.status] ?? 0.1
            }
          }
        }
        if (child instanceof THREE.Sprite) {
          ;(child.material as THREE.SpriteMaterial).opacity = Math.max(opacity, 0.03)
        }
      })
    })
  }, [])

  // ── Expose handle ──────────────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    flyToQuery: (q: string) => {
      if (!fgRef.current || typeof fgRef.current.scene !== 'function') return
      const ql = q.trim().toLowerCase()
      const scene = fgRef.current.scene() as THREE.Scene
      if (!scene) return
      let found: { x: number; y: number; z: number } | null = null
      scene.traverse((obj: any) => {
        if (found || obj.__graphObjType !== 'node') return
        const n = obj.__data
        if (!n) return
        if ((n.label || '').toLowerCase().includes(ql) || (n.ip || '').toLowerCase().includes(ql))
          found = { x: obj.position.x, y: obj.position.y, z: obj.position.z }
      })
      if (!found) return
      const { x, y, z } = found as { x: number; y: number; z: number }
      fgRef.current.cameraPosition({ x: x + 60, y: y + 80, z: z + 100 }, { x, y, z }, 1200)
    },
    startTour: () => {
      if (!fgRef.current || typeof fgRef.current.scene !== 'function') return
      const tick = () => {
        if (!fgRef.current || typeof fgRef.current.scene !== 'function') return
        const scene = fgRef.current.scene() as THREE.Scene
        if (!scene) return
        const positions: { x: number; y: number; z: number }[] = []
        scene.traverse((obj: any) => {
          if (obj.__graphObjType === 'node' && obj.__data && !obj.__data.ghost)
            positions.push({ x: obj.position.x, y: obj.position.y, z: obj.position.z })
        })
        if (positions.length === 0) return
        tourIdxRef.current = (tourIdxRef.current + 1) % positions.length
        const m = positions[tourIdxRef.current]
        fgRef.current.cameraPosition(
          { x: m.x + 50, y: m.y + 80, z: m.z + 100 },
          { x: m.x, y: m.y, z: m.z },
          1800,
        )
      }
      tick()
      tourTimer.current = setInterval(tick, 2800)
    },
    stopTour: () => {
      if (tourTimer.current) { clearInterval(tourTimer.current); tourTimer.current = null }
    },
    clearPath: () => {
      pathSrcRef.current = null; pathNodeIds.current = new Set(); pathLinkIds.current = new Set()
      setLinkVis((v) => v + 1); refreshNodes()
    },
    clearIsolate: () => { isolateIdRef.current = null; refreshNodes() },
  }), [refreshNodes])

  // ── Graph data ─────────────────────────────────────────────────────────────
  // Keep a ref so handleNodeClick can access nodes/links without graphData() ref method
  const graphDataRef = useRef<{ nodes: any[]; links: any[] }>({ nodes: [], links: [] })

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
        // Pin to layer Y so nodes appear on the correct floor
        fy: isGhost ? undefined : (LAYER_CFG[layer]?.y ?? 0),
      }
    })
    const links = graph.edges.map((e) => ({
      id: `${e.source}|${e.target}`,
      source: e.source, target: e.target, label: e.label || '',
    }))
    const result = { nodes, links }
    graphDataRef.current = result
    return result
  }, [graph, searchQuery])

  // ── Node Three.js object ───────────────────────────────────────────────────
  const nodeThreeObject = useCallback((node: any) => {
    const vColor  = VENDOR_COLOR[node.vendor] || VENDOR_COLOR.other
    const eColor  = STATUS_EMISSIVE[node.status] || STATUS_EMISSIVE.unknown
    const eInt    = STATUS_EMISSIVE_INT[node.status] || 0.1
    const radius  = node.ghost ? 4 : (LAYER_CFG[node.layer]?.radius ?? 9)
    const group   = new THREE.Group()

    const geo = new THREE.SphereGeometry(radius, 16, 16)   // 16 segments = lighter than 24
    const op  = node.ghost ? 0.45 : (node.dimmed ? 0.08 : 1)
    const mat = new THREE.MeshLambertMaterial({             // Lambert = cheaper than Phong
      color: vColor, emissive: eColor,
      emissiveIntensity: node.dimmed ? 0 : eInt,
      transparent: node.ghost || node.dimmed, opacity: op,
    })
    if (node.ghost) mat.wireframe = true
    group.add(new THREE.Mesh(geo, mat))

    // Thin status ring (online only to reduce geometry count)
    if (!node.ghost && node.status === 'online') {
      const rg = new THREE.RingGeometry(radius + 1.5, radius + 3, 24)
      const rm = new THREE.MeshBasicMaterial({
        color: eColor, transparent: true, opacity: 0.45, side: THREE.DoubleSide,
      })
      const ring = new THREE.Mesh(rg, rm)
      ring.rotation.x = Math.PI / 2
      group.add(ring)
    }

    // Label sprite
    const sprite = makeTextSprite(node.label, '#ddeeff',
      node.status === 'online' ? '#00e676' : node.status === 'offline' ? '#ff3d6a' : '#00d4ff')
    sprite.position.y = radius + 10
    group.add(sprite)

    return group
  }, [])

  // ── Link color/width ───────────────────────────────────────────────────────
  const linkColorFn = useCallback((link: any) =>
    pathLinkIds.current.has(link.id as string) ? '#fbbf24' : 'rgba(0,195,255,0.20)'
  , [linkVis])  // eslint-disable-line react-hooks/exhaustive-deps

  const linkWidthFn = useCallback((link: any) =>
    pathLinkIds.current.has(link.id as string) ? 3 : 0.7
  , [linkVis])  // eslint-disable-line react-hooks/exhaustive-deps

  const particleColorFn = useCallback((link: any) =>
    pathLinkIds.current.has(link.id as string) ? '#fbbf24' : '#00d4ff'
  , [linkVis])  // eslint-disable-line react-hooks/exhaustive-deps

  const particleSpeedFn = useCallback((link: any) =>
    pathLinkIds.current.has(link.id as string) ? 0.016 : 0.004
  , [linkVis])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Node click ─────────────────────────────────────────────────────────────
  const handleNodeClick = useCallback((node: any) => {
    if (!fgRef.current) return

    if (pathMode) {
      if (!pathSrcRef.current) {
        pathSrcRef.current = node.id; refreshNodes()
      } else if (pathSrcRef.current === node.id) {
        pathSrcRef.current = null; pathNodeIds.current = new Set(); pathLinkIds.current = new Set()
        setLinkVis((v) => v + 1); refreshNodes()
      } else {
        const { nodes, links } = graphDataRef.current
        const path = bfsPath(nodes, links, pathSrcRef.current!, node.id)
        pathNodeIds.current = new Set(path)
        const lids = new Set<string>()
        for (let i = 0; i < path.length - 1; i++) {
          lids.add(`${path[i]}|${path[i + 1]}`); lids.add(`${path[i + 1]}|${path[i]}`)
        }
        pathLinkIds.current = lids; pathSrcRef.current = null
        setLinkVis((v) => v + 1); refreshNodes()
        // Fly to midpoint of path via scene traverse
        if (path.length > 0 && typeof fgRef.current.scene === 'function') {
          const midId = path[Math.floor(path.length / 2)]
          const scene = fgRef.current.scene() as THREE.Scene
          scene.traverse((obj: any) => {
            if (obj.__graphObjType === 'node' && obj.__data?.id === midId)
              fgRef.current.cameraPosition(
                { x: obj.position.x + 60, y: obj.position.y + 80, z: obj.position.z + 80 },
                { x: obj.position.x, y: obj.position.y, z: obj.position.z }, 1200)
          })
        }
      }
      return
    }

    if (node.device_id && onNodeClick) onNodeClick(node.device_id)
    fgRef.current.cameraPosition(
      { x: (node.x || 0) + 40, y: (node.y || 0) + 60, z: (node.z || 0) + 70 },
      { x: node.x || 0, y: node.y || 0, z: node.z || 0 }, 1000)
  }, [pathMode, onNodeClick, refreshNodes])

  // ── Right-click: isolate ───────────────────────────────────────────────────
  const handleNodeRightClick = useCallback((node: any) => {
    isolateIdRef.current = isolateIdRef.current === node.id ? null : node.id
    refreshNodes()
  }, [refreshNodes])

  // ── pathMode exit: clear path data (skip initial mount) ───────────────────
  const pathModeMounted = useRef(false)
  useEffect(() => {
    if (!pathModeMounted.current) { pathModeMounted.current = true; return }
    if (!pathMode) {
      pathSrcRef.current = null; pathNodeIds.current = new Set(); pathLinkIds.current = new Set()
      setLinkVis((v) => v + 1); refreshNodes()
    }
  }, [pathMode, refreshNodes])

  // ── Blast radius animation ─────────────────────────────────────────────────
  useEffect(() => {
    if (!blastDeviceIds.length) return
    blastNodeIds.current = new Set(blastDeviceIds)
    refreshNodes()

    if (!fgRef.current || typeof fgRef.current.scene !== 'function' || typeof fgRef.current.graphData !== 'function') return
    const scene = fgRef.current.scene() as THREE.Scene
    const { nodes } = fgRef.current.graphData() as { nodes: any[] }
    for (const devId of blastDeviceIds) {
      const n = nodes.find((nd: any) => nd.device_id === devId)
      if (!n) continue
      for (let wave = 0; wave < 3; wave++) {
        const rg  = new THREE.RingGeometry(10, 13, 24)
        const rm  = new THREE.MeshBasicMaterial({ color: 0xff2244, transparent: true, opacity: 0.6, side: THREE.DoubleSide })
        const mesh = new THREE.Mesh(rg, rm)
        mesh.position.set(n.x || 0, n.y || 0, n.z || 0)
        mesh.rotation.x = Math.PI / 2
        scene.add(mesh)
        blastRings.current.push({ mesh, age: wave * 0.4, maxAge: 2.5 })
      }
    }
    const t = setTimeout(() => { blastNodeIds.current = new Set(); refreshNodes() }, 4000)
    return () => clearTimeout(t)
  }, [blastDeviceIds, refreshNodes])

  // ── RAF: blast ring animation ──────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick)
      if (!blastRings.current.length) return
      const scene = fgRef.current?.scene() as THREE.Scene | null
      const next: typeof blastRings.current = []
      for (const r of blastRings.current) {
        r.age += 0.016
        const t = r.age / r.maxAge
        r.mesh.scale.setScalar(1 + t * 5)
        ;(r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - t)
        if (r.age >= r.maxAge) { scene?.remove(r.mesh) } else { next.push(r) }
      }
      blastRings.current = next
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  // ── One-time scene setup (after first engine stop) ─────────────────────────
  const setupScene = useCallback(() => {
    if (sceneReady.current) return
    if (!fgRef.current || typeof fgRef.current.scene !== 'function') return
    sceneReady.current = true

    const scene    = fgRef.current.scene() as THREE.Scene
    const controls = fgRef.current.controls()

    // Single ambient boost (library already adds ambient + directional)
    scene.add(new THREE.AmbientLight(0x334466, 0.4))

    // Minimal starfield (1 draw call, 600 points total)
    const starPos = new Float32Array(600 * 3)
    for (let i = 0; i < starPos.length; i++) starPos[i] = (Math.random() - 0.5) * 3000
    const starGeo = new THREE.BufferGeometry()
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xaaccff, size: 0.8, transparent: true, opacity: 0.45, sizeAttenuation: true,
    })))

    // Grid
    const grid = new THREE.GridHelper(1400, 30, 0x00d4ff, 0x001a2e)
    ;(grid.material as THREE.Material).opacity = 0.04
    ;(grid.material as THREE.Material).transparent = true
    grid.position.y = -220; scene.add(grid)

    // Layer floor planes (1 per layer, very low opacity)
    for (const [, cfg] of Object.entries(LAYER_CFG)) {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(700, 700),
        new THREE.MeshBasicMaterial({ color: cfg.color, transparent: true, opacity: 0.015, side: THREE.DoubleSide }),
      )
      plane.rotation.x = -Math.PI / 2
      plane.position.y = cfg.y - 5
      scene.add(plane)

      // Border
      const border = new THREE.Mesh(
        new THREE.RingGeometry(320, 325, 48),
        new THREE.MeshBasicMaterial({ color: cfg.color, transparent: true, opacity: 0.08, side: THREE.DoubleSide }),
      )
      border.rotation.x = -Math.PI / 2
      border.position.y = cfg.y - 4
      scene.add(border)

      // Label
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 44
      const cx = cv.getContext('2d')!
      cx.font = 'bold 20px system-ui,monospace'
      cx.fillStyle = cfg.hex; cx.globalAlpha = 0.5
      cx.shadowColor = cfg.hex; cx.shadowBlur = 10; cx.textAlign = 'left'
      cx.fillText(`— ${cfg.label}`, 6, 32)
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true }))
      spr.scale.set(72, 9, 1); spr.position.set(-360, cfg.y + 2, 0)
      scene.add(spr)
    }

    // Controls: no auto-rotate to keep rendering lightweight
    if (controls) {
      controls.autoRotate   = false
      controls.enableDamping = false
    }
  }, [])

  // ── Engine stop: setup scene once, then refresh node materials ────────────
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
      linkOpacity={0.4}
      linkDirectionalParticles={2}
      linkDirectionalParticleSpeed={particleSpeedFn}
      linkDirectionalParticleWidth={1.5}
      linkDirectionalParticleColor={particleColorFn}
      onNodeClick={handleNodeClick}
      onNodeRightClick={handleNodeRightClick}
      onEngineStop={handleEngineStop}
      nodeLabel={(node: any) =>
        `<div style="background:rgba(3,12,30,0.95);color:#ddeeff;padding:8px 12px;border-radius:8px;font-size:12px;line-height:1.7;border:1px solid rgba(0,195,255,0.22)">` +
        `<strong style="color:#00d4ff">${node.label}</strong><br/>` +
        (node.ip ? `IP: ${node.ip}<br/>` : '') +
        (node.layer ? `<span style="color:${LAYER_CFG[node.layer]?.hex ?? '#94a3b8'}">${node.layer.toUpperCase()}</span> — ` : '') +
        `<span style="color:${node.status === 'online' ? '#00e676' : node.status === 'offline' ? '#ff3d6a' : '#ffb300'}">${node.status}</span>` +
        `</div>`
      }
      enableNodeDrag
      enableNavigationControls
      showNavInfo={false}
      d3AlphaDecay={0.03}
      d3VelocityDecay={0.4}
      cooldownTicks={80}
      warmupTicks={30}
    />
  )
})

export default Topology3D
