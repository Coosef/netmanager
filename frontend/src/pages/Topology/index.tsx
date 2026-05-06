import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTaskProgress } from '@/hooks/useTaskProgress'
import {
  ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState,
  Panel, ReactFlowProvider, useReactFlow, type Node, type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  App, Badge, Button, Card, Col, Descriptions, Drawer, Form, Input, Modal, Row,
  Select, Space, Spin, Table, Tag, Tooltip, Alert,
} from 'antd'
import {
  SyncOutlined, ApartmentOutlined, ReloadOutlined,
  ThunderboltOutlined, BranchesOutlined, LoginOutlined, CheckCircleOutlined,
  NodeIndexOutlined, ApiOutlined, WarningOutlined, RadarChartOutlined,
  BugOutlined, ExportOutlined,
  BorderOuterOutlined, DeploymentUnitOutlined,
  FullscreenOutlined, FullscreenExitOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { topologyApi, type DiscoverSingleResult, type DiscoverGhostResult } from '@/api/topology'
import { devicesApi } from '@/api/devices'
import type { Device } from '@/types'
import { DeviceNode, GhostNode } from './DeviceNode'
import { CustomEdge } from './CustomEdge'
import { applyLayout, type LayoutType } from './layout'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'
import { useTranslation } from 'react-i18next'
import Topology3D, { type Topology3DHandle } from './Topology3D'
import { buildWsUrl } from '@/utils/ws'

const nodeTypes = { deviceNode: DeviceNode, ghostNode: GhostNode }
const edgeTypes = { custom: CustomEdge }

const OS_TYPE_OPTIONS = [
  { label: 'Ruijie OS', value: 'ruijie_os' },
  { label: 'Cisco IOS', value: 'cisco_ios' },
  { label: 'Cisco NX-OS', value: 'cisco_nxos' },
  { label: 'Aruba AOS-CX', value: 'aruba_aoscx' },
  { label: 'Aruba OS-Switch', value: 'aruba_osswitch' },
  { label: 'Generic', value: 'generic' },
]

const TYPE_ICON: Record<string, string> = {
  switch: '🔀', router: '🌐', ap: '📶', phone: '📱',
  printer: '🖨️', camera: '📷', firewall: '🛡️', server: '🗄️',
  laptop: '💻', other: '❓',
}

interface GhostSwitchTarget {
  hostname: string
  ip: string
  source_device_id: number
}

function mkTV(isDark: boolean) {
  return {
    page:   isDark ? '#030c1e'               : '#f0f4f8',
    card:   isDark ? 'rgba(6,16,40,0.94)'    : 'rgba(255,255,255,0.96)',
    border: isDark ? 'rgba(0,195,255,0.09)'  : '#e2e8f0',
    text:   isDark ? '#d8eeff'               : '#1e293b',
    muted:  isDark ? '#5a7a9a'               : '#64748b',
    dim:    isDark ? '#304560'               : '#cbd5e1',
    hover:  isDark ? 'rgba(0,195,255,0.06)'  : 'rgba(59,130,246,0.04)',
  }
}

function mkTopoCSS(isDark: boolean) {
  const card = isDark ? 'rgba(6,16,40,0.94)'   : 'rgba(255,255,255,0.96)'
  const bord = isDark ? 'rgba(0,195,255,0.09)' : '#e2e8f0'
  const bhov = isDark ? 'rgba(0,195,255,0.2)'  : '#bfdbfe'
  return `
.topo-card {
  background: ${card};
  border: 1px solid ${bord};
  border-radius: 10px;
  backdrop-filter: blur(8px);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.topo-card:hover {
  border-color: ${bhov};
}
`
}

function StatCard({ label, value, color, icon, isDark }: {
  label: string; value: number; color: string; icon: React.ReactNode; isDark: boolean
}) {
  const TV = mkTV(isDark)
  return (
    <div className="topo-card" style={{
      padding: '10px 16px', minWidth: 130,
      borderTop: `2px solid ${color}`,
      boxShadow: `0 2px 18px ${color}10`,
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: 8, flexShrink: 0,
        background: `${color}18`, border: `1px solid ${color}25`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{ color, fontSize: 15 }}>{icon}</span>
      </div>
      <div>
        <div style={{ fontSize: 10, color: TV.muted, fontWeight: 600, letterSpacing: 1.2, textTransform: 'uppercase' }}>{label}</div>
        <div style={{ fontSize: 24, fontWeight: 900, color, fontFamily: 'monospace', lineHeight: 1.2, textShadow: isDark ? `0 0 16px ${color}50` : undefined }}>{value}</div>
      </div>
    </div>
  )
}

function exportTopologyAsHtml(graph: import('@/api/topology').TopologyGraph) {
  // Only pass data fields — no positions; Cytoscape will compute its own layout
  const cytNodes = graph.nodes.map((n) => {
    const platform = (n.data.platform || '').toLowerCase()
    const layer = (n.data.layer || '').toLowerCase()
    const label = (n.data.label || '').toLowerCase()
    let device_type = 'switch'
    if (n.type === 'ghostNode') device_type = 'other'
    else if (layer === 'wireless' || /\bap\b|wifi|access.?point|wap/.test(platform)) device_type = 'ap'
    else if (/asa|firewall|ftd|firepower|paloalto|fortinet|checkpoint/.test(platform)) device_type = 'firewall'
    else if (/\brouter\b|isr|csr|asr|nxr/.test(platform)) device_type = 'router'
    else if (/phone|ip.?phone|voip/.test(platform) || /phone/.test(label)) device_type = 'phone'
    else if (/server/.test(label) || /server/.test(platform)) device_type = 'server'
    else if (/printer/.test(platform) || /printer/.test(label)) device_type = 'printer'
    else if (/camera|cam/.test(platform)) device_type = 'camera'
    else if (/laptop/.test(platform) || /laptop/.test(label)) device_type = 'laptop'
    return {
      data: {
        id: n.id,
        label: n.data.label || '',
        ip: n.data.ip || '',
        vendor: n.data.vendor || 'other',
        status: n.data.status || 'unknown',
        layer: n.data.layer || '',
        ghost: n.type === 'ghostNode' ? 1 : 0,
        platform: n.data.platform || '',
        device_id: n.data.device_id ?? null,
        device_type,
      },
    }
  })
  const cytEdges = graph.edges.map((e) => ({
    data: {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label || '',
      source_port: e.data?.source_port || '',
      target_port: e.data?.target_port || '',
      protocol: e.data?.protocol || '',
    },
  }))

  const graphJson = JSON.stringify({ nodes: cytNodes, edges: cytEdges })
  const exportDate = new Date().toLocaleString('tr-TR')

  const html = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NetManager Topoloji - ${exportDate}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.29.2/cytoscape.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{display:flex;height:100vh;font-family:'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#f1f5f9;overflow:hidden}
#sidebar{width:280px;flex-shrink:0;display:flex;flex-direction:column;background:#1e293b;border-right:1px solid #334155;overflow-y:auto}
#cy{flex:1;background:#0f172a;position:relative}
#layout-spinner{display:none;position:absolute;inset:0;background:#0f172a99;align-items:center;justify-content:center;font-size:14px;color:#94a3b8;z-index:10}
.sidebar-header{padding:14px 16px;border-bottom:1px solid #334155;background:#0f172a}
.sidebar-header h1{font-size:14px;font-weight:700;color:#3b82f6}
.sidebar-header p{font-size:10px;color:#64748b;margin-top:2px}
.section{padding:10px 14px;border-bottom:1px solid #334155}
.section-title{font-size:10px;font-weight:700;color:#64748b;letter-spacing:.08em;text-transform:uppercase;margin-bottom:7px}
input,select{width:100%;padding:5px 9px;border:1px solid #334155;border-radius:6px;background:#0f172a;color:#f1f5f9;font-size:12px;outline:none;margin-bottom:5px}
input:focus,select:focus{border-color:#3b82f6}
select option{background:#0f172a}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:5px 10px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;border:none;width:100%;margin-bottom:5px;transition:background .12s}
.btn-blue{background:#1d4ed8;color:#fff}.btn-blue:hover{background:#1e40af}
.btn-gray{background:#334155;color:#94a3b8}.btn-gray:hover{background:#475569}
.btn-green{background:#15803d;color:#fff}.btn-green:hover{background:#166534}
.btn-row{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:2px}
.btn-row .btn{margin:0}
.legend-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.legend-sq{width:9px;height:9px;border-radius:2px;flex-shrink:0}
.legend-row{display:flex;align-items:center;gap:7px;margin-bottom:4px;font-size:11px;color:#cbd5e1}
#detail-panel{padding:12px 14px;display:none;border-top:1px solid #334155}
#detail-title{font-size:13px;font-weight:700;color:#f1f5f9;margin-bottom:10px;word-break:break-all}
.dr{display:flex;margin-bottom:5px;font-size:11px}
.dl{color:#64748b;width:80px;flex-shrink:0}
.dv{color:#f1f5f9;word-break:break-all}
.badge{display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:700}
.chip{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;margin-right:3px}
#stats-bar{display:flex;gap:8px;padding:8px 14px 4px;flex-wrap:wrap}
.sc{background:#0f172a;border:1px solid #334155;border-radius:7px;padding:4px 10px;font-size:10px;color:#94a3b8;text-align:center}
.sc strong{color:#f1f5f9;display:block;font-size:15px;font-weight:700}
</style>
</head>
<body>
<div id="sidebar">
  <div class="sidebar-header">
    <h1>⬡ NetManager Topoloji</h1>
    <p>Dışa aktarıldı: ${exportDate}</p>
  </div>
  <div id="stats-bar">
    <div class="sc"><strong id="sn">0</strong>Cihaz</div>
    <div class="sc"><strong id="se">0</strong>Bağlantı</div>
    <div class="sc"><strong id="sg">0</strong>Bilinmeyen</div>
  </div>

  <div class="section">
    <div class="section-title">Yerleşim</div>
    <button class="btn btn-green" onclick="runLayout('cose')">🔄 Yeniden Düzenle (Otomatik)</button>
    <div class="btn-row">
      <button class="btn btn-gray" onclick="runLayout('breadthfirst')" title="Hiyerarşik ağaç düzeni">🌲 Hiyerarşi</button>
      <button class="btn btn-gray" onclick="runLayout('circle')" title="Daire düzeni">⭕ Daire</button>
      <button class="btn btn-gray" onclick="runLayout('grid')" title="Izgara düzeni">⊞ Izgara</button>
      <button class="btn btn-gray" onclick="runLayout('concentric')" title="Konsentrik düzen">🎯 Konsantrik</button>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Arama & Filtre</div>
    <input id="search" type="text" placeholder="Hostname veya IP ara…" />
    <select id="fv"><option value="">Tüm Vendor</option><option value="cisco">Cisco</option><option value="aruba">Aruba</option><option value="ruijie">Ruijie</option><option value="other">Diğer</option></select>
    <select id="fl"><option value="">Tüm Katman</option><option value="core">Core</option><option value="distribution">Distribution</option><option value="access">Access</option><option value="edge">Edge</option><option value="wireless">Wireless</option></select>
    <select id="fs"><option value="">Tüm Durum</option><option value="online">Online</option><option value="offline">Offline</option><option value="unreachable">Unreachable</option><option value="unknown">Bilinmiyor</option></select>
    <div class="btn-row">
      <button class="btn btn-blue" onclick="applyFilters()">Uygula</button>
      <button class="btn btn-gray" onclick="resetFilters()">Sıfırla</button>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Görünüm</div>
    <button class="btn btn-gray" onclick="cy.fit(cy.elements(':visible'),40)">🔍 Tümüne Sığdır</button>
    <button class="btn btn-gray" onclick="toggleLabels()">🏷️ Etiketleri Gizle/Göster</button>
  </div>

  <div class="section">
    <div class="section-title">Lejand — Vendor</div>
    <div class="legend-row"><div class="legend-sq" style="background:#1d6fa4"></div>Cisco</div>
    <div class="legend-row"><div class="legend-sq" style="background:#ff8300"></div>Aruba</div>
    <div class="legend-row"><div class="legend-sq" style="background:#e4002b"></div>Ruijie</div>
    <div class="legend-row"><div class="legend-sq" style="background:#64748b"></div>Diğer</div>
    <div class="legend-row"><div class="legend-sq" style="background:#92400e;border:1px dashed #fbbf24"></div>Bilinmeyen</div>
  </div>
  <div class="section">
    <div class="section-title">Lejand — Durum / Katman</div>
    <div class="legend-row"><div class="legend-dot" style="background:#22c55e"></div>Online</div>
    <div class="legend-row"><div class="legend-dot" style="background:#ef4444"></div>Offline</div>
    <div class="legend-row"><div class="legend-dot" style="background:#f59e0b"></div>Erişilemiyor</div>
    <div class="legend-row"><div class="legend-dot" style="background:#64748b"></div>Bilinmiyor</div>
    <div style="margin-top:6px">
      <div class="legend-row"><div class="legend-sq" style="background:#ef4444"></div>Core</div>
      <div class="legend-row"><div class="legend-sq" style="background:#f97316"></div>Distribution</div>
      <div class="legend-row"><div class="legend-sq" style="background:#3b82f6"></div>Access</div>
      <div class="legend-row"><div class="legend-sq" style="background:#22c55e"></div>Edge</div>
      <div class="legend-row"><div class="legend-sq" style="background:#a855f7"></div>Wireless</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Cihaz Tipleri</div>
    <div id="dt-legend"></div>
  </div>

  <div id="detail-panel">
    <div id="detail-title">Cihaz Detayı</div>
    <div id="detail-content"></div>
  </div>
</div>
<div id="cy"><div id="layout-spinner">⟳ Düzenleniyor…</div></div>
<script>
var VC={cisco:'#1d6fa4',aruba:'#ff8300',ruijie:'#e4002b',other:'#64748b'};
var SC={online:'#22c55e',offline:'#ef4444',unreachable:'#f59e0b',unknown:'#64748b'};
var LC={core:'#ef4444',distribution:'#f97316',access:'#3b82f6',edge:'#22c55e',wireless:'#a855f7'};
function svgIcon(s){return 'data:image/svg+xml,'+encodeURIComponent(s);}
var DT_SVG={
  switch:svgIcon("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><rect x='1' y='7' width='22' height='10' rx='2' fill='none' stroke='white' stroke-width='1.5'/><line x1='6' y1='7' x2='6' y2='17' stroke='white' stroke-width='0.9' opacity='0.55'/><line x1='10' y1='7' x2='10' y2='17' stroke='white' stroke-width='0.9' opacity='0.55'/><line x1='14' y1='7' x2='14' y2='17' stroke='white' stroke-width='0.9' opacity='0.55'/><line x1='18' y1='7' x2='18' y2='17' stroke='white' stroke-width='0.9' opacity='0.55'/></svg>"),
  firewall:svgIcon("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M12 2L4 6v6c0 5.25 3.5 9.74 8 11 4.5-1.26 8-5.75 8-11V6z'/><polyline points='9 12 11 14 15 10'/></svg>"),
  ap:svgIcon("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='1.5' stroke-linecap='round'><path d='M2 8.82a15 15 0 0 1 20 0'/><path d='M5 12a11 11 0 0 1 14 0'/><path d='M8.5 15.5a6 6 0 0 1 7 0'/><circle cx='12' cy='19' r='1.5' fill='white' stroke='none'/></svg>"),
  router:svgIcon("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='1.5' stroke-linecap='round'><circle cx='12' cy='12' r='3'/><line x1='12' y1='3' x2='12' y2='9'/><line x1='21' y1='12' x2='15' y2='12'/><line x1='12' y1='21' x2='12' y2='15'/><line x1='3' y1='12' x2='9' y2='12'/></svg>"),
  phone:svgIcon("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='1.5' stroke-linecap='round'><rect x='7' y='2' width='10' height='20' rx='2'/><circle cx='12' cy='17.5' r='1' fill='white' stroke='none'/></svg>"),
  server:svgIcon("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='1.5' stroke-linecap='round'><rect x='3' y='4' width='18' height='5' rx='1'/><rect x='3' y='11' width='18' height='5' rx='1'/><rect x='3' y='18' width='18' height='3' rx='1'/><circle cx='6.5' cy='6.5' r='1' fill='white' stroke='none'/><circle cx='6.5' cy='13.5' r='1' fill='white' stroke='none'/></svg>"),
  printer:svgIcon("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='1.5' stroke-linecap='round'><rect x='6' y='2' width='12' height='6' rx='1'/><rect x='3' y='8' width='18' height='9' rx='1'/><rect x='6' y='17' width='12' height='5' rx='1'/></svg>"),
  camera:svgIcon("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='1.5' stroke-linecap='round'><path d='M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z'/><circle cx='12' cy='13' r='4'/></svg>"),
  laptop:svgIcon("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='1.5' stroke-linecap='round'><rect x='3' y='4' width='18' height='13' rx='1'/><polyline points='1 21 23 21'/></svg>"),
  other:svgIcon("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='1.5' stroke-linecap='round'><circle cx='12' cy='12' r='10'/><path d='M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3'/><circle cx='12' cy='17' r='1' fill='white' stroke='none'/></svg>"),
};
var RAW=${graphJson};
var cy=cytoscape({
  container:document.getElementById('cy'),
  elements:RAW,
  style:[
    {selector:'node[ghost=0]',style:{
      shape:'roundrectangle',width:126,height:44,
      'background-color':function(e){return VC[e.data('vendor')]||'#64748b';},
      'background-image':function(e){return DT_SVG[e.data('device_type')]||DT_SVG.switch;},
      'background-width':20,'background-height':20,
      'background-position-x':10,'background-position-y':'50%',
      'border-width':3,
      'border-color':function(e){return SC[e.data('status')]||'#64748b';},
      label:'data(label)',
      'font-size':11,color:'#ffffff',
      'text-valign':'center','text-halign':'center',
      'text-margin-x':14,
      'text-wrap':'ellipsis','text-max-width':84,
      'text-outline-width':1.5,'text-outline-color':'rgba(0,0,0,0.5)',
    }},
    {selector:'node[ghost=1]',style:{
      shape:'diamond',width:44,height:44,
      'background-color':'#92400e',
      'border-width':2,'border-style':'dashed','border-color':'#fbbf24',
      label:'data(label)',
      'font-size':9,color:'#fbbf24',
      'text-valign':'bottom','text-margin-y':4,
      'text-wrap':'ellipsis','text-max-width':70,
      'text-outline-width':1,'text-outline-color':'rgba(0,0,0,0.6)',
    }},
    {selector:'edge',style:{
      width:1.5,'line-color':'#475569','target-arrow-shape':'none',
      label:'data(label)','font-size':8,color:'#64748b',
      'text-background-color':'#1e293b','text-background-opacity':0.85,'text-background-padding':'2px',
      'text-background-shape':'roundrectangle','curve-style':'bezier',
    }},
    {selector:'node:selected',style:{'border-width':4,'border-color':'#60a5fa','overlay-opacity':0.15,'overlay-color':'#60a5fa','overlay-padding':5}},
    {selector:'edge:selected',style:{width:3,'line-color':'#60a5fa'}},
    {selector:'.faded',style:{opacity:0.12}},
  ],
  layout:{name:'grid'},
  wheelSensitivity:0.3,
  minZoom:0.03,maxZoom:4,
});

function runLayout(name){
  var sp=document.getElementById('layout-spinner');
  sp.style.display='flex';
  var opts={
    cose:{name:'cose',animate:false,fit:true,padding:50,nodeRepulsion:function(){return 450000;},nodeOverlap:20,idealEdgeLength:function(){return 80;},edgeElasticity:function(){return 100;},nestingFactor:5,gravity:80,numIter:1000,initialTemp:200,coolingFactor:0.95,minTemp:1.0,randomize:true},
    breadthfirst:{name:'breadthfirst',animate:false,fit:true,padding:40,directed:false,spacingFactor:1.6,avoidOverlap:true},
    circle:{name:'circle',animate:false,fit:true,padding:40,avoidOverlap:true,spacingFactor:1.2},
    grid:{name:'grid',animate:false,fit:true,padding:40,avoidOverlap:true,spacingFactor:1.1},
    concentric:{name:'concentric',animate:false,fit:true,padding:40,avoidOverlap:true,levelWidth:function(){return 2;},concentric:function(n){var d=n.degree();return d;},spacingFactor:1.4},
  }[name];
  if(!opts){sp.style.display='none';return;}
  setTimeout(function(){
    cy.layout(opts).run();
    sp.style.display='none';
  },50);
}

// Run cose on load
runLayout('cose');

// Stats
document.getElementById('sn').textContent=cy.nodes('[ghost=0]').length;
document.getElementById('se').textContent=cy.edges().length;
document.getElementById('sg').textContent=cy.nodes('[ghost=1]').length;

// Device type legend (dynamic)
var DT_LABELS={switch:'Switch',firewall:'Güvenlik Duvarı',ap:'Erişim Noktası',router:'Router',phone:'Telefon',server:'Sunucu',printer:'Yazıcı',camera:'Kamera',laptop:'Laptop',other:'Bilinmeyen'};
var dtC={};
cy.nodes('[ghost=0]').each(function(n){var t=n.data('device_type')||'switch';dtC[t]=(dtC[t]||0)+1;});
var dtEl=document.getElementById('dt-legend');
Object.keys(dtC).sort().forEach(function(t){
  var row=document.createElement('div');row.className='legend-row';
  var ic=document.createElement('img');ic.src=DT_SVG[t]||DT_SVG.switch;ic.width=13;ic.height=13;ic.style.opacity='0.85';ic.style.flexShrink='0';
  var lb=document.createElement('span');lb.textContent=(DT_LABELS[t]||t)+' — '+dtC[t];
  row.appendChild(ic);row.appendChild(lb);dtEl.appendChild(row);
});

// Click → detail
cy.on('tap','node',function(evt){
  var n=evt.target,d=n.data();
  var dp=document.getElementById('detail-panel');
  document.getElementById('detail-title').textContent=d.label||(d.ghost?'Bilinmeyen Cihaz':'Cihaz');
  var sc=SC[d.status]||'#64748b',lc=LC[d.layer]||'#475569',vc=VC[d.vendor]||'#64748b';
  var h='';
  if(d.ip) h+='<div class="dr"><span class="dl">IP Adresi</span><span class="dv">'+d.ip+'</span></div>';
  if(d.vendor&&!d.ghost) h+='<div class="dr"><span class="dl">Vendor</span><span class="dv"><span class="chip" style="background:'+vc+'33;color:'+vc+'">'+d.vendor+'</span></span></div>';
  if(d.layer) h+='<div class="dr"><span class="dl">Katman</span><span class="dv"><span class="chip" style="background:'+lc+'33;color:'+lc+'">'+d.layer+'</span></span></div>';
  if(d.status&&!d.ghost) h+='<div class="dr"><span class="dl">Durum</span><span class="dv"><span class="badge" style="background:'+sc+'22;color:'+sc+'">⬤ '+d.status+'</span></span></div>';
  if(d.platform) h+='<div class="dr"><span class="dl">Platform</span><span class="dv">'+d.platform+'</span></div>';
  if(d.ghost) h+='<div style="font-size:10px;color:#fbbf24;margin-top:6px;padding:6px 8px;background:#92400e22;border-radius:6px;border:1px solid #fbbf2444">⚠ Envanterde bulunmuyor</div>';
  var nbrs=n.neighborhood('node');
  if(nbrs.length>0){
    h+='<div style="margin-top:8px;font-size:10px;color:#64748b;font-weight:700;letter-spacing:.06em;text-transform:uppercase">Komşular ('+nbrs.length+')</div>';
    nbrs.each(function(nb){h+='<div style="font-size:11px;color:#cbd5e1;padding:2px 0;border-bottom:1px solid #334155">'+nb.data('label')+(nb.data('ip')?'<span style="color:#64748b;margin-left:6px">'+nb.data('ip')+'</span>':'')+'</div>';});
  }
  document.getElementById('detail-content').innerHTML=h;
  dp.style.display='block';
  cy.elements().style('opacity',0.12);
  n.neighborhood().add(n).style('opacity',1);
});
cy.on('tap',function(evt){
  if(evt.target===cy){cy.elements().style('opacity',1);document.getElementById('detail-panel').style.display='none';}
});

// Filters
var labelsOn=true;
function toggleLabels(){
  labelsOn=!labelsOn;
  cy.nodes().style('label',labelsOn?function(e){return e.data('label');}:'');
}
function applyFilters(){
  var q=(document.getElementById('search').value||'').toLowerCase();
  var fv=document.getElementById('fv').value;
  var fl=document.getElementById('fl').value;
  var fs=document.getElementById('fs').value;
  cy.nodes().forEach(function(n){
    var d=n.data();
    var ok=(!q||(d.label||'').toLowerCase().includes(q)||(d.ip||'').includes(q))
          &&(!fv||d.ghost||d.vendor===fv)
          &&(!fl||d.ghost||d.layer===fl)
          &&(!fs||d.ghost||d.status===fs);
    n.style('display',ok?'element':'none');
  });
  cy.edges().forEach(function(e){
    var vis=e.source().style('display')!=='none'&&e.target().style('display')!=='none';
    e.style('display',vis?'element':'none');
  });
}
function resetFilters(){
  document.getElementById('search').value='';
  document.getElementById('fv').value='';
  document.getElementById('fl').value='';
  document.getElementById('fs').value='';
  cy.elements().style('display','element');
}
document.getElementById('search').addEventListener('keydown',function(e){if(e.key==='Enter')applyFilters();});
<\/script>
</body>
</html>`

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `topology-${new Date().toISOString().slice(0, 10)}.html`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function TopologyFlow() {
  const { message } = App.useApp()
  const { isDark } = useTheme()
  const { t } = useTranslation()
  const { activeSite } = useSite()
  const queryClient = useQueryClient()
  const { fitView } = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [layout, setLayout] = useState<LayoutType>('force')
  const [filterGroup, setFilterGroup] = useState<number>()
  const [filterLayer, setFilterLayer] = useState<string>()
  const [filterSite, setFilterSite] = useState<string>()
  const [filterBuilding, setFilterBuilding] = useState<string>()
  const [filterFloor, setFilterFloor] = useState<string>()
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [blastModalOpen, setBlastModalOpen] = useState(false)
  const [anomalyModalOpen, setAnomalyModalOpen] = useState(false)
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('2d')
  const [searchQuery, setSearchQuery] = useState('')
  const canvasContainerRef = useRef<HTMLDivElement>(null)
  const topo3dRef = useRef<Topology3DHandle>(null)

  // 3D feature states
  const [topo3dPathMode, setTopo3dPathMode] = useState(false)
  const [topo3dTourActive, setTopo3dTourActive] = useState(false)
  const [blast3dIds, setBlast3dIds] = useState<number[]>([])
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set())

  const [discoverResult, setDiscoverResult] = useState<DiscoverSingleResult | null>(null)
  const [discoverModalOpen, setDiscoverModalOpen] = useState(false)

  const [hopTaskId, setHopTaskId] = useState<number | null>(null)
  const [bulkTaskId, setBulkTaskId] = useState<number | null>(null)

  const [selectMode, setSelectMode] = useState(false)
  const [bulkSelected, setBulkSelected] = useState<Set<number>>(new Set())
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number } | null>(null)
  const [bulkResultModal, setBulkResultModal] = useState(false)
  const [bulkResults, setBulkResults] = useState<Array<{ hostname: string; neighbor_count: number; success: boolean; error?: string }>>([])

  useTaskProgress(hopTaskId, {
    title: 'Atlama Keşfi',
    invalidateKeys: [['topology-graph'], ['topology-stats'], ['devices']],
    onDone: () => setHopTaskId(null),
  })
  useTaskProgress(bulkTaskId, {
    title: 'Topoloji Keşfi',
    invalidateKeys: [['topology-graph'], ['topology-stats']],
    onDone: () => setBulkTaskId(null),
  })

  const [ghostTarget, setGhostTarget] = useState<GhostSwitchTarget | null>(null)
  const [ghostConnectModalOpen, setGhostConnectModalOpen] = useState(false)
  const [credModalOpen, setCredModalOpen] = useState(false)
  const [credForm] = Form.useForm()
  const [ghostResult, setGhostResult] = useState<DiscoverGhostResult | null>(null)
  const [ghostResultModalOpen, setGhostResultModalOpen] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const [wsConnected, setWsConnected] = useState(false)
  const [wsEventLog, setWsEventLog] = useState<Array<{ type: string; hostname: string; time: number }>>([])
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      canvasContainerRef.current?.requestFullscreen()
    } else {
      document.exitFullscreen()
    }
  }

  const canvasBorder    = isDark ? 'rgba(0,195,255,0.14)'  : '#e2e8f0'
  const canvasLoadingBg = isDark ? 'rgba(3,12,30,0.88)'    : 'rgba(248,250,252,0.9)'
  const bgColor         = isDark ? '#030c1e'               : '#f8fafc'
  const bgDotColor      = isDark ? 'rgba(0,195,255,0.08)'  : '#dde3ea'
  const panelCardBg     = isDark ? 'rgba(6,16,40,0.95)'    : 'rgba(255,255,255,0.97)'
  const panelCardBorder = isDark ? 'rgba(0,195,255,0.10)'  : '#e2e8f0'
  const textColor       = isDark ? '#d8eeff'               : '#1e293b'
  const subColor        = isDark ? '#5a7a9a'               : '#64748b'
  const legendDivider   = isDark ? 'rgba(0,195,255,0.08)'  : '#f1f5f9'

  const edgeOptions = {
    style: { stroke: isDark ? '#475569' : '#b0b0b0', strokeWidth: 2 },
    labelStyle: { fontSize: 10, fill: isDark ? '#94a3b8' : '#595959' },
    labelBgStyle: { fill: isDark ? '#1e293b' : '#f5f5f5', fillOpacity: 0.9 },
    labelBgPadding: [4, 4] as [number, number],
    labelBgBorderRadius: 3,
  }

  const { data: graph, isLoading: graphLoading } = useQuery({
    queryKey: ['topology-graph', filterGroup, activeSite],
    queryFn: () => topologyApi.getGraph({ group_id: filterGroup, site: activeSite || undefined }),
  })

  const { data: stats } = useQuery({
    queryKey: ['topology-stats'],
    queryFn: topologyApi.getStats,
    refetchInterval: 30000,
  })

  const { data: groups } = useQuery({
    queryKey: ['groups'],
    queryFn: devicesApi.listGroups,
  })

  const { data: locationOptions } = useQuery({
    queryKey: ['location-options'],
    queryFn: devicesApi.getLocationOptions,
  })

  const discoverMutation = useMutation({
    mutationFn: () => topologyApi.triggerDiscovery(),
    onSuccess: (data) => { setBulkTaskId(data.task_id) },
    onError: () => message.error(t('topology.discover_failed')),
  })

  const bulkLldpMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const rows: typeof bulkResults = []
      setBulkProgress({ current: 0, total: ids.length })
      for (const id of ids) {
        try {
          const res = await topologyApi.discoverSingle(id)
          rows.push({ hostname: res.hostname, neighbor_count: res.neighbor_count, success: true })
        } catch (e: any) {
          rows.push({ hostname: `#${id}`, neighbor_count: 0, success: false, error: e?.response?.data?.detail || 'Hata' })
        }
        setBulkProgress({ current: rows.length, total: ids.length })
      }
      return rows
    },
    onSuccess: (rows) => {
      setBulkProgress(null)
      setSelectMode(false)
      setBulkSelected(new Set())
      setBulkResults(rows)
      setBulkResultModal(true)
      queryClient.invalidateQueries({ queryKey: ['topology-graph'] })
      queryClient.invalidateQueries({ queryKey: ['topology-stats'] })
    },
    onError: () => { setBulkProgress(null); message.error('LLDP başlatılamadı') },
  })

  const refreshGraph = useMutation({
    mutationFn: () => topologyApi.getGraph({ group_id: filterGroup, site: activeSite || undefined, refresh: true }),
    onSuccess: (data) => {
      applyGraph(data.nodes as any, data.edges as any)
      queryClient.setQueryData(['topology-graph', filterGroup], data)
      message.success(t('topology.topology_updated'))
    },
  })

  const singleDiscoverMutation = useMutation({
    mutationFn: (device_id: number) => topologyApi.discoverSingle(device_id),
    onSuccess: (data) => {
      message.success(t('topology.neighbors_found', { count: data.neighbor_count }))
      setDiscoverResult(data)
      setDiscoverModalOpen(true)
      queryClient.invalidateQueries({ queryKey: ['topology-graph'] })
      queryClient.invalidateQueries({ queryKey: ['topology-stats'] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('topology.lldp_failed')),
  })

  const hopMutation = useMutation({
    mutationFn: ({ source_id, ips }: { source_id: number; ips: string[] }) =>
      topologyApi.hopDiscover(source_id, ips),
    onSuccess: (data) => {
      setHopTaskId(data.task_id)
      message.success(t('topology.hop_started', { count: data.target_count, id: data.task_id }))
      setDiscoverModalOpen(false)
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['topology-graph'] })
        queryClient.invalidateQueries({ queryKey: ['topology-stats'] })
      }, 20000)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('topology.hop_failed')),
  })

  const blastRadiusMutation = useMutation({
    mutationFn: (device_id: number) => topologyApi.getBlastRadius(device_id),
    onSuccess: (data) => {
      setBlastModalOpen(true)
      if (viewMode === '3d') {
        setBlast3dIds(data.affected_devices.map((d) => d.id))
        setTimeout(() => setBlast3dIds([]), 5000)
      }
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Blast radius analizi başarısız'),
  })

  const anomalyMutation = useMutation({
    mutationFn: () => topologyApi.getAnomalies(),
    onSuccess: () => setAnomalyModalOpen(true),
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Anomali taraması başarısız'),
  })

  const discoverGhostMutation = useMutation({
    mutationFn: (params: {
      hostname: string; ip: string; source_device_id?: number
      username?: string; password?: string; os_type?: string
    }) => topologyApi.discoverGhost(params),
    onSuccess: (data) => {
      if (data.needs_credentials) {
        setGhostConnectModalOpen(false)
        setCredModalOpen(true)
        message.warning(`${data.tried_count} credential denendi, giriş başarısız. Lütfen bilgilerinizi girin.`)
      } else if (data.success) {
        setGhostConnectModalOpen(false)
        setCredModalOpen(false)
        credForm.resetFields()
        message.success(t('topology.ghost_connected', { name: data.hostname, count: data.neighbor_count }))
        setGhostResult(data)
        setGhostResultModalOpen(true)
        queryClient.invalidateQueries({ queryKey: ['topology-graph'] })
        queryClient.invalidateQueries({ queryKey: ['topology-stats'] })
        queryClient.invalidateQueries({ queryKey: ['devices'] })
      }
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('topology.connect_failed')),
  })

  const applyGraph = useCallback(
    (rawNodes: any[], rawEdges: any[]) => {
      const flowEdges: Edge[] = rawEdges.map((e) => ({
        ...e,
        ...edgeOptions,
        type: 'custom',
        style: e.style ? { ...edgeOptions.style, ...e.style } : edgeOptions.style,
      }))
      const laidOut = applyLayout(rawNodes as Node[], flowEdges, layout)
      setNodes(laidOut)
      setEdges(flowEdges)
      requestAnimationFrame(() => fitView({ padding: 0.12, duration: 350 }))
    },
    [layout, setNodes, setEdges, isDark, fitView],
  )

  const displayNodes = useMemo(() => {
    const typedNodes = nodes as Node[]
    let result = typedNodes
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = typedNodes.map((n) => ({
        ...n,
        hidden: !(
          ((n.data?.label as string) || '').toLowerCase().includes(q) ||
          ((n.data?.ip as string) || '').toLowerCase().includes(q)
        ),
      }))
    }
    if (selectMode && bulkSelected.size > 0) {
      return result.map((n) => ({
        ...n,
        selected: bulkSelected.has(n.data?.device_id as number),
      }))
    }
    return result
  }, [nodes, searchQuery, selectMode, bulkSelected])

  const displayEdges = useMemo(() => {
    const typedEdges = edges as Edge[]
    if (!searchQuery.trim()) return typedEdges
    const visibleIds = new Set(displayNodes.filter((n) => !n.hidden).map((n) => n.id))
    return typedEdges.map((e) => ({
      ...e,
      hidden: !visibleIds.has(e.source) || !visibleIds.has(e.target),
    }))
  }, [edges, displayNodes, searchQuery])

  const searchMatchCount = useMemo(() => {
    if (!searchQuery.trim()) return null
    return displayNodes.filter((n) => !n.hidden).length
  }, [displayNodes, searchQuery])

  const handleSearchFit = useCallback(() => {
    const matching = displayNodes.filter((n) => !n.hidden)
    if (matching.length > 0) fitView({ nodes: matching, padding: 0.25, duration: 400 })
  }, [displayNodes, fitView])

  useEffect(() => {
    if (!graph) return
    let rawNodes = graph.nodes as any[]
    let rawEdges = graph.edges as any[]

    const hasFilter = filterLayer || filterSite || filterBuilding || filterFloor
    if (hasFilter) {
      const visibleIds = new Set(
        rawNodes
          .filter((n: any) => {
            if (n.type === 'ghostNode') return true
            const d = n.data || {}
            if (filterLayer && d.layer !== filterLayer) return false
            if (filterSite && d.site !== filterSite) return false
            if (filterBuilding && d.building !== filterBuilding) return false
            if (filterFloor && d.floor !== filterFloor) return false
            return true
          })
          .map((n: any) => n.id)
      )
      rawEdges = rawEdges.filter((e: any) => visibleIds.has(e.source) && visibleIds.has(e.target))
      rawNodes = rawNodes.filter((n: any) => visibleIds.has(n.id))
    }
    applyGraph(rawNodes, rawEdges)
  }, [graph, layout, isDark, filterLayer, filterSite, filterBuilding, filterFloor])

  useEffect(() => {
    const url = buildWsUrl('/api/v1/ws/events')
    const connect = () => {
      const ws = new WebSocket(url)
      wsRef.current = ws
      ws.onopen = () => setWsConnected(true)
      ws.onclose = () => { setWsConnected(false); setTimeout(connect, 5000) }
      ws.onerror = () => ws.close()
      ws.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data as string)
          if (evt.event_type === 'device_offline' || evt.event_type === 'device_online') {
            const newStatus = evt.event_type === 'device_online' ? 'online' : 'offline'
            const deviceId = evt.device_id as number | undefined
            if (deviceId) {
              ;(setNodes as any)((nds: any[]) => nds.map((n: any) =>
                n.data?.device_id === deviceId
                  ? { ...n, data: { ...n.data, status: newStatus } }
                  : n
              ))
              setWsEventLog((prev) => [
                { type: evt.event_type, hostname: evt.device_hostname || String(deviceId), time: Date.now() },
                ...prev.slice(0, 4),
              ])
            }
          }
        } catch { /* ignore */ }
      }
    }
    connect()
    return () => wsRef.current?.close()
  }, [])

  const openDeviceById = useCallback(async (deviceId: number) => {
    try {
      const device = await devicesApi.get(deviceId)
      setSelectedDevice(device)
      setDrawerOpen(true)
    } catch {}
  }, [])

  const onNodeClick = useCallback(async (_: unknown, node: Node) => {
    if (node.type === 'ghostNode') {
      if (selectMode) return
      const dtype = node.data?.device_type as string
      if (dtype === 'switch' || dtype === 'router') {
        setGhostTarget({
          hostname: node.data?.label as string || '',
          ip: node.data?.ip as string || '',
          source_device_id: node.data?.source_device_id as number,
        })
        setGhostConnectModalOpen(true)
      }
      return
    }
    const deviceId = node.data?.device_id as number
    if (!deviceId) return
    if (selectMode) {
      setBulkSelected((prev) => {
        const next = new Set(prev)
        if (next.has(deviceId)) next.delete(deviceId)
        else next.add(deviceId)
        return next
      })
      return
    }
    openDeviceById(deviceId)
  }, [openDeviceById, selectMode])

  const onNodeMouseEnter = useCallback((_: unknown, node: Node) => {
    setEdges((eds) => eds.map((e) => ({
      ...e,
      data: {
        ...e.data,
        highlighted: e.source === node.id || e.target === node.id,
        dimmed: e.source !== node.id && e.target !== node.id,
      },
    })))
  }, [setEdges])

  const onNodeMouseLeave = useCallback(() => {
    setEdges((eds) => eds.map((e) => ({
      ...e,
      data: { ...e.data, highlighted: false, dimmed: false },
    })))
  }, [setEdges])

  const minimapNodeColor = (node: Node) => {
    if (node.type === 'ghostNode') return '#faad14'
    const s = node.data?.status as string || 'unknown'
    return { online: '#22c55e', offline: '#ef4444', unknown: '#64748b', unreachable: '#f59e0b' }[s] || '#64748b'
  }

  const handleCredSubmit = () => {
    credForm.validateFields().then((vals) => {
      if (!ghostTarget) return
      discoverGhostMutation.mutate({
        hostname: ghostTarget.hostname,
        ip: ghostTarget.ip,
        source_device_id: ghostTarget.source_device_id,
        username: vals.username,
        password: vals.password,
        os_type: vals.os_type,
      })
    })
  }

  const neighborColumns = [
    { title: 'Port', dataIndex: 'local_port', width: 100 },
    {
      title: 'Komşu', dataIndex: 'hostname',
      render: (v: string, r: any) => (
        <span>
          {TYPE_ICON[r.device_type] || '❓'} {v}
          {r.in_inventory && <Tag color="green" style={{ marginLeft: 6, fontSize: 10 }}>Envanter</Tag>}
        </span>
      ),
    },
    { title: 'IP', dataIndex: 'ip', width: 120 },
    { title: 'Tür', dataIndex: 'device_type', width: 100, render: (v: string) => <Tag>{v}</Tag> },
    { title: 'Protokol', dataIndex: 'protocol', width: 80, render: (v: string) => <Tag color="blue">{v?.toUpperCase()}</Tag> },
  ]

  const TV = mkTV(isDark)

  return (
    <div style={{ height: isFullscreen ? '100vh' : 'calc(100vh - 110px)', display: 'flex', flexDirection: 'column', gap: 12, backgroundColor: TV.page }}>
      {/* Stats bar */}
      <Row gutter={12} align="middle">
        <Col>
          <StatCard label="Topoloji Node" value={stats?.devices_with_neighbors || 0} color="#4488ff" icon={<NodeIndexOutlined />} isDark={isDark} />
        </Col>
        <Col>
          <StatCard label="Bağlantı" value={stats?.total_links || 0} color="#00e676" icon={<ApiOutlined />} isDark={isDark} />
        </Col>
        <Col>
          <StatCard label="Eşleşmemiş" value={stats?.unmatched_links || 0} color="#ffb300" icon={<WarningOutlined />} isDark={isDark} />
        </Col>
        <Col style={{ marginLeft: 'auto' }}>
          <Space align="center">
            {/* WS live status */}
            <Tooltip title={wsConnected ? 'Canlı bağlantı aktif' : 'Canlı bağlantı bekleniyor…'}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 20,
                background: wsConnected ? 'rgba(34,197,94,0.12)' : 'rgba(100,116,139,0.12)',
                border: `1px solid ${wsConnected ? '#22c55e40' : '#47556940'}`,
                cursor: 'default',
              }}>
                <div style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: wsConnected ? '#22c55e' : '#64748b',
                  boxShadow: wsConnected ? '0 0 6px #22c55e' : undefined,
                  animation: wsConnected ? 'topoNodeLed 2.5s ease-in-out infinite' : undefined,
                }} />
                <span style={{ fontSize: 11, color: wsConnected ? '#22c55e' : '#64748b', fontWeight: 600 }}>
                  {wsConnected ? 'CANLI' : 'BEKLEME'}
                </span>
                {wsEventLog.length > 0 && (
                  <span style={{ fontSize: 10, color: '#94a3b8', marginLeft: 2 }}>
                    {wsEventLog[0].type === 'device_offline' ? '🔴' : '🟢'} {wsEventLog[0].hostname.substring(0, 12)}
                  </span>
                )}
              </div>
            </Tooltip>
            <Button
              icon={<BorderOuterOutlined />}
              type={viewMode === '2d' ? 'primary' : 'default'}
              onClick={() => setViewMode('2d')}
              size="small"
            >
              2D
            </Button>
            <Button
              icon={<DeploymentUnitOutlined />}
              type={viewMode === '3d' ? 'primary' : 'default'}
              onClick={() => setViewMode('3d')}
              size="small"
            >
              3D
            </Button>
            <Tooltip title={isFullscreen ? 'Tam Ekrandan Çık' : 'Tam Ekran'}>
              <Button
                icon={isFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                onClick={toggleFullscreen}
                size="small"
              />
            </Tooltip>
          </Space>
        </Col>
      </Row>

      {/* Live event ticker */}
      {wsEventLog.length > 0 && (
        <div style={{
          display: 'flex', gap: 6, flexWrap: 'wrap', paddingBottom: 2,
        }}>
          {wsEventLog.map((ev, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '2px 8px', borderRadius: 12, fontSize: 11,
              background: ev.type === 'device_offline' ? 'rgba(239,68,68,0.12)' : 'rgba(34,197,94,0.10)',
              border: `1px solid ${ev.type === 'device_offline' ? '#ef444430' : '#22c55e30'}`,
              color: ev.type === 'device_offline' ? '#f87171' : '#4ade80',
              opacity: 1 - i * 0.15,
            }}>
              <span>{ev.type === 'device_offline' ? '↓' : '↑'}</span>
              <span style={{ fontWeight: 600 }}>{ev.hostname}</span>
              <span style={{ color: '#475569', fontSize: 10 }}>{new Date(ev.time).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            </div>
          ))}
        </div>
      )}

      {/* Flow canvas */}
      <div
        ref={canvasContainerRef}
        style={{
          flex: 1,
          border: `1px solid ${canvasBorder}`,
          borderRadius: 12,
          overflow: 'hidden',
          position: 'relative',
          background: bgColor,
        }}
      >
        {graphLoading && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 10, background: canvasLoadingBg,
          }}>
            <Spin size="large" tip={t('topology.loading')} />
          </div>
        )}

        {viewMode === '3d' && (
          <Topology3D
            ref={topo3dRef}
            graph={graph ?? { nodes: [], edges: [], stats: { total_nodes: 0, known_nodes: 0, ghost_nodes: 0, total_edges: 0 } }}
            isDark={isDark}
            width={canvasContainerRef.current?.clientWidth || window.innerWidth - 240}
            height={canvasContainerRef.current?.clientHeight || window.innerHeight - 200}
            onNodeClick={openDeviceById}
            searchQuery={searchQuery}
            pathMode={topo3dPathMode}
            blastDeviceIds={blast3dIds}
            hiddenLayers={hiddenLayers}
          />
        )}

        {viewMode === '3d' && (
          <div style={{
            position: 'absolute', top: 12, right: 12, zIndex: 10, width: 238,
            background: 'rgba(3,12,30,0.92)', borderRadius: 12, padding: '10px 12px',
            border: '1px solid rgba(0,195,255,0.22)', backdropFilter: 'blur(12px)',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            {/* Search */}
            <Input.Search
              placeholder="Hostname veya IP ara…"
              allowClear size="small"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onSearch={(q) => topo3dRef.current?.flyToQuery(q)}
              style={{ width: '100%' }}
            />
            {searchMatchCount !== null && (
              <div style={{ fontSize: 10, color: searchMatchCount > 0 ? '#00d4ff' : '#ff4d4f', textAlign: 'right', marginTop: -4 }}>
                {searchMatchCount > 0 ? `${searchMatchCount} cihaz eşleşti` : 'Eşleşme yok'}
              </div>
            )}

            {/* Divider */}
            <div style={{ borderTop: '1px solid rgba(0,195,255,0.10)' }} />

            {/* Tour */}
            <div>
              <div style={{ fontSize: 9, color: '#00d4ff', fontWeight: 700, letterSpacing: 1.5, marginBottom: 5, textTransform: 'uppercase' }}>
                Otomatik Tur
              </div>
              <Button
                block size="small"
                type={topo3dTourActive ? 'primary' : 'default'}
                style={topo3dTourActive ? { background: '#7c3aed', borderColor: '#7c3aed' } : {}}
                onClick={() => {
                  if (topo3dTourActive) {
                    topo3dRef.current?.stopTour()
                    setTopo3dTourActive(false)
                  } else {
                    topo3dRef.current?.startTour()
                    setTopo3dTourActive(true)
                  }
                }}
              >
                {topo3dTourActive ? '⏹ Turu Durdur' : '▶ Turu Başlat'}
              </Button>
            </div>

            {/* Path tracing */}
            <div>
              <div style={{ fontSize: 9, color: '#00d4ff', fontWeight: 700, letterSpacing: 1.5, marginBottom: 5, textTransform: 'uppercase' }}>
                Yol Bul
              </div>
              <Button
                block size="small"
                type={topo3dPathMode ? 'primary' : 'default'}
                style={topo3dPathMode ? { background: '#d97706', borderColor: '#d97706' } : {}}
                onClick={() => {
                  const next = !topo3dPathMode
                  setTopo3dPathMode(next)
                  if (!next) topo3dRef.current?.clearPath()
                }}
              >
                {topo3dPathMode ? '🔶 Yol Modu Aktif' : '🔀 Yol Bul Modu'}
              </Button>
              {topo3dPathMode && (
                <div style={{ fontSize: 10, color: '#fbbf24', marginTop: 4, lineHeight: 1.4 }}>
                  1. cihaza tıkla → kaynak<br />2. cihaza tıkla → yol gösterilir
                </div>
              )}
            </div>

            {/* Isolate hint */}
            <div style={{ borderTop: '1px solid rgba(0,195,255,0.10)', paddingTop: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 9, color: '#94a3b8', letterSpacing: 0.5 }}>
                  🖱 Sağ tık → cihazı izole et
                </span>
                <Button
                  size="small" type="text"
                  style={{ fontSize: 9, color: '#94a3b8', padding: '0 4px', height: 18 }}
                  onClick={() => topo3dRef.current?.clearIsolate()}
                >
                  Temizle
                </Button>
              </div>
            </div>

            {/* Layer toggles */}
            <div style={{ borderTop: '1px solid rgba(0,195,255,0.10)', paddingTop: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                <span style={{ fontSize: 9, color: '#00d4ff', fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase' }}>
                  Katmanlar
                </span>
                <div
                  onClick={() => setHiddenLayers((prev) =>
                    prev.size === 0
                      ? new Set(['core', 'distribution', 'access', 'edge', 'wireless', 'ap'])
                      : new Set()
                  )}
                  style={{
                    fontSize: 9, cursor: 'pointer', padding: '2px 6px',
                    borderRadius: 3, border: '1px solid rgba(0,195,255,0.25)',
                    color: hiddenLayers.size === 0 ? '#94a3b8' : '#00d4ff',
                    background: hiddenLayers.size === 0 ? 'transparent' : 'rgba(0,195,255,0.08)',
                    userSelect: 'none', transition: 'all 0.15s',
                  }}
                >
                  {hiddenLayers.size === 0 ? '○ Gizle' : '● Göster'}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {([
                  { key: 'core',         label: 'Core',         color: '#ef4444' },
                  { key: 'distribution', label: 'Distribution', color: '#f97316' },
                  { key: 'access',       label: 'Access',       color: '#3b82f6' },
                  { key: 'edge',         label: 'Edge',         color: '#22c55e' },
                  { key: 'wireless',     label: 'Wireless',     color: '#a855f7' },
                  { key: 'ap',           label: 'AP',           color: '#00bcd4' },
                ] as const).map(({ key, label, color }) => {
                  const visible = !hiddenLayers.has(key)
                  return (
                    <div
                      key={key}
                      onClick={() => setHiddenLayers((prev) => {
                        const next = new Set(prev)
                        if (next.has(key)) next.delete(key); else next.add(key)
                        return next
                      })}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                        padding: '3px 6px', borderRadius: 4, userSelect: 'none',
                        background: visible ? `${color}18` : 'transparent',
                        border: `1px solid ${visible ? color + '44' : 'rgba(255,255,255,0.06)'}`,
                        opacity: visible ? 1 : 0.4,
                        transition: 'all 0.15s',
                      }}
                    >
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: visible ? color : '#334155', flexShrink: 0 }} />
                      <span style={{ fontSize: 10, color: visible ? color : '#64748b', flex: 1 }}>{label}</span>
                      <span style={{ fontSize: 10, color: visible ? '#94a3b8' : '#475569' }}>{visible ? '●' : '○'}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        <div style={{ display: viewMode === '3d' ? 'none' : 'contents' }}>
        {selectMode && (
          <div style={{
            position: 'absolute', top: 12, left: 12, zIndex: 20,
            background: 'rgba(21,128,61,0.92)', borderRadius: 8,
            padding: '5px 12px', fontSize: 12, fontWeight: 600, color: '#fff',
            border: '1px solid #22c55e', pointerEvents: 'none',
          }}>
            ✓ Seçim Modu — cihaza tıkla
          </div>
        )}
        <ReactFlow
          nodes={displayNodes as any} edges={displayEdges as any}
          onNodesChange={onNodesChange as any} onEdgesChange={onEdgesChange as any}
          onNodeClick={onNodeClick}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView fitViewOptions={{ padding: 0.1 }}
          minZoom={0.05} maxZoom={3}
          attributionPosition="bottom-right"
          colorMode={isDark ? 'dark' : 'light'}
          style={{ cursor: selectMode ? 'crosshair' : undefined }}
        >
          <Background color={bgDotColor} gap={20} />
          <Controls style={{ background: panelCardBg, border: `1px solid ${panelCardBorder}` }} />
          <MiniMap nodeColor={minimapNodeColor} pannable zoomable
            style={{ background: isDark ? '#0f172a' : '#f8fafc', border: `1px solid ${panelCardBorder}` }} />

          <Panel position="top-right" style={{ maxHeight: 'calc(100vh - 80px)', overflowY: 'auto', overflowX: 'hidden' }}>
            <Space direction="vertical" size={8} style={{ width: 220 }}>
              {/* Controls card */}
              <div className="topo-card" style={{
                background: panelCardBg,
                borderColor: panelCardBorder,
                padding: '10px 12px',
                backdropFilter: 'blur(10px)',
              }}>
                <div style={{ fontSize: 10, color: '#00d4ff', fontWeight: 700, marginBottom: 8, letterSpacing: 1.8, textTransform: 'uppercase' }}>
                  {t('topology.view_section')}
                </div>
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <div>
                    <Input.Search
                      placeholder="Hostname veya IP ara…"
                      allowClear
                      size="small"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onSearch={handleSearchFit}
                      style={{ width: '100%' }}
                    />
                    {searchMatchCount !== null && (
                      <div style={{ fontSize: 10, marginTop: 2, color: searchMatchCount > 0 ? '#00d4ff' : '#ff4d4f' }}>
                        {searchMatchCount > 0 ? `${searchMatchCount} cihaz eşleşti` : 'Eşleşme yok'}
                      </div>
                    )}
                  </div>
                  <Select
                    placeholder={t('topology.filter_group')}
                    allowClear style={{ width: '100%' }}
                    onChange={setFilterGroup} size="small"
                    options={groups?.map((g) => ({ label: g.name, value: g.id })) || []}
                  />
                  <Select
                    placeholder={t('topology.filter_layer')}
                    allowClear style={{ width: '100%' }}
                    onChange={setFilterLayer} size="small"
                    options={[
                      { label: '🔴 Core', value: 'core' },
                      { label: '🟠 Distribution', value: 'distribution' },
                      { label: '🔵 Access', value: 'access' },
                      { label: '🟢 Edge', value: 'edge' },
                      { label: '🟣 Wireless', value: 'wireless' },
                    ]}
                  />
                  {(locationOptions?.sites?.length ?? 0) > 0 && (
                    <>
                      <Select
                        placeholder="Site Filtrele"
                        allowClear style={{ width: '100%' }}
                        onChange={(v) => { setFilterSite(v); setFilterBuilding(undefined); setFilterFloor(undefined) }}
                        value={filterSite}
                        size="small"
                        options={locationOptions!.sites.map((s) => ({ label: s, value: s }))}
                      />
                      {filterSite && (locationOptions?.buildings.filter((b) => b.site === filterSite).length ?? 0) > 0 && (
                        <Select
                          placeholder="Bina Filtrele"
                          allowClear style={{ width: '100%' }}
                          onChange={(v) => { setFilterBuilding(v); setFilterFloor(undefined) }}
                          value={filterBuilding}
                          size="small"
                          options={locationOptions!.buildings
                            .filter((b) => b.site === filterSite)
                            .map((b) => ({ label: b.name, value: b.name }))}
                        />
                      )}
                      {filterBuilding && (locationOptions?.floors.filter((f) => f.site === filterSite && f.building === filterBuilding).length ?? 0) > 0 && (
                        <Select
                          placeholder="Kat Filtrele"
                          allowClear style={{ width: '100%' }}
                          onChange={setFilterFloor}
                          value={filterFloor}
                          size="small"
                          options={locationOptions!.floors
                            .filter((f) => f.site === filterSite && f.building === filterBuilding)
                            .map((f) => ({ label: f.name, value: f.name }))}
                        />
                      )}
                    </>
                  )}
                  <div style={{ fontSize: 10, color: subColor, fontWeight: 600, marginBottom: 4, letterSpacing: '0.05em' }}>
                    {t('topology.view_section')} — Dizilim
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 6 }}>
                    {([
                      { value: 'force'  as LayoutType, label: '⬡ Kuvvet' },
                      { value: 'TB'     as LayoutType, label: '↕ Hiyerarşi' },
                      { value: 'LR'     as LayoutType, label: '↔ Yatay' },
                      { value: 'grid'   as LayoutType, label: '⊞ Izgara' },
                      { value: 'circle' as LayoutType, label: '⭕ Daire' },
                    ]).map(({ value, label }) => (
                      <Button
                        key={value}
                        size="small"
                        type={layout === value ? 'primary' : 'default'}
                        onClick={() => setLayout(value)}
                        style={{ fontSize: 10, padding: '0 6px' }}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  <Tooltip title={t('topology.refresh_cache')}>
                    <Button block size="small" icon={<ReloadOutlined />} loading={refreshGraph.isPending} onClick={() => refreshGraph.mutate()}>
                      Önbelleği Yenile
                    </Button>
                  </Tooltip>
                </Space>
              </div>

              {/* Discovery card */}
              <div className="topo-card" style={{
                background: panelCardBg,
                borderColor: panelCardBorder,
                padding: '10px 12px',
                backdropFilter: 'blur(10px)',
              }}>
                <div style={{ fontSize: 10, color: '#00d4ff', fontWeight: 700, marginBottom: 8, letterSpacing: 1.8, textTransform: 'uppercase' }}>
                  {t('topology.discovery_section')}
                </div>
                <Button
                  block size="small" type="primary"
                  icon={<SyncOutlined />}
                  loading={discoverMutation.isPending}
                  disabled={selectMode}
                  onClick={() => discoverMutation.mutate()}
                >
                  {t('topology.discover_all')}
                </Button>
                <Button
                  block size="small"
                  icon={<CheckCircleOutlined />}
                  type={selectMode ? 'primary' : 'default'}
                  onClick={() => { setSelectMode((v) => !v); setBulkSelected(new Set()) }}
                  style={{
                    marginTop: 6,
                    ...(selectMode
                      ? { background: '#15803d', borderColor: '#22c55e', color: '#fff' }
                      : {}),
                  }}
                >
                  {selectMode ? `Seçim Modu: ${bulkSelected.size} cihaz` : 'Çoklu Seçim'}
                </Button>
                {selectMode && (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 4 }}>
                      <Button
                        size="small"
                        onClick={() => {
                          const allIds = new Set(
                            (nodes as Node[])
                              .filter((n) => n.type !== 'ghostNode' && n.data?.device_id)
                              .map((n) => n.data.device_id as number)
                          )
                          setBulkSelected(allIds)
                        }}
                        style={{ fontSize: 10 }}
                      >
                        Tümünü Seç
                      </Button>
                      <Button
                        size="small"
                        disabled={bulkSelected.size === 0}
                        onClick={() => setBulkSelected(new Set())}
                        style={{ fontSize: 10 }}
                      >
                        Temizle
                      </Button>
                    </div>
                    <Button
                      block size="small" type="primary"
                      icon={<ThunderboltOutlined />}
                      loading={bulkLldpMutation.isPending}
                      disabled={bulkSelected.size === 0}
                      onClick={() => bulkLldpMutation.mutate(Array.from(bulkSelected))}
                      style={{ marginTop: 4 }}
                    >
                      {bulkProgress
                        ? `${bulkProgress.current}/${bulkProgress.total} keşfediliyor…`
                        : `Seçilileri LLDP (${bulkSelected.size})`}
                    </Button>
                  </>
                )}
                <Button
                  block size="small"
                  icon={<BugOutlined />}
                  loading={anomalyMutation.isPending}
                  onClick={() => anomalyMutation.mutate()}
                  style={{ marginTop: 6, borderColor: '#f59e0b', color: '#d97706' }}
                >
                  Anomali Tara
                  {anomalyMutation.data && anomalyMutation.data.warning_count > 0 && (
                    <span style={{
                      marginLeft: 6, background: '#ef4444', color: '#fff',
                      borderRadius: 8, fontSize: 10, padding: '0 5px', fontWeight: 700,
                    }}>
                      {anomalyMutation.data.warning_count}
                    </span>
                  )}
                </Button>
                <Button
                  block size="small"
                  icon={<ExportOutlined />}
                  onClick={() => {
                    if (!graph) return
                    exportTopologyAsHtml(graph)
                  }}
                  disabled={!graph}
                  style={{ marginTop: 6 }}
                >
                  HTML Dışa Aktar
                </Button>
                {selectedDevice && !selectMode && (
                  <Button
                    block size="small" style={{ marginTop: 6 }}
                    icon={<ThunderboltOutlined />}
                    loading={singleDiscoverMutation.isPending}
                    onClick={() => singleDiscoverMutation.mutate(selectedDevice.id)}
                  >
                    {selectedDevice.hostname} LLDP
                  </Button>
                )}
              </div>

              {/* Legend */}
              <div className="topo-card" style={{
                background: panelCardBg,
                borderColor: panelCardBorder,
                padding: '10px 12px',
                fontSize: 11,
                backdropFilter: 'blur(10px)',
              }}>
                <div style={{ fontSize: 10, color: '#00d4ff', fontWeight: 700, marginBottom: 8, letterSpacing: 1.8, textTransform: 'uppercase' }}>
                  {t('topology.legend_section')}
                </div>
                {[
                  ['#1d6fa4', 'Cisco'],
                  ['#ff8300', 'Aruba'],
                  ['#e4002b', 'Ruijie'],
                  ['#64748b', 'Diğer'],
                ].map(([c, v]) => (
                  <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <div style={{ width: 10, height: 10, background: c, borderRadius: 2, flexShrink: 0 }} />
                    <span style={{ color: textColor }}>{v}</span>
                  </div>
                ))}
                <div style={{ borderTop: `1px solid ${legendDivider}`, marginTop: 6, paddingTop: 6 }}>
                  {([[`#22c55e`, t('topology.legend_online')], [`#ef4444`, t('topology.legend_offline')], [`#f59e0b`, t('topology.legend_ghost')]] as [string, string][]).map(([c, label]) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <div style={{ width: 8, height: 8, background: c, borderRadius: '50%', flexShrink: 0 }} />
                      <span style={{ color: textColor }}>{label}</span>
                    </div>
                  ))}
                  <div style={{ color: '#f59e0b', fontSize: 10, marginTop: 4 }}>
                    {t('topology.ghost_click_hint')}
                  </div>
                </div>
                {/* Utilization legend */}
                <div style={{ borderTop: `1px solid ${legendDivider}`, marginTop: 6, paddingTop: 6 }}>
                  <div style={{ fontSize: 10, color: subColor, fontWeight: 600, marginBottom: 5, letterSpacing: '0.05em' }}>
                    BAĞLANTI UTİLİZASYONU
                  </div>
                  {[
                    ['#22c55e', '< 60%', 'Normal'],
                    ['#f97316', '60–80%', 'Yüksek'],
                    ['#ef4444', '≥ 80%', 'Kritik'],
                  ].map(([c, range, label]) => (
                    <div key={range} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                      <div style={{ width: 18, height: 3, background: c, borderRadius: 2, flexShrink: 0 }} />
                      <span style={{ color: textColor, fontSize: 10 }}>{range}</span>
                      <span style={{ color: subColor, fontSize: 10 }}>— {label}</span>
                    </div>
                  ))}
                  <div style={{ color: subColor, fontSize: 9, marginTop: 4 }}>
                    Cihazın üzerine gelin → bağlı kenarlar parlar
                  </div>
                </div>
                {/* Speed legend */}
                <div style={{ borderTop: `1px solid ${legendDivider}`, marginTop: 6, paddingTop: 6 }}>
                  <div style={{ fontSize: 10, color: subColor, fontWeight: 600, marginBottom: 5, letterSpacing: '0.05em' }}>
                    BAĞLANTI HIZI (SNMP)
                  </div>
                  {[
                    ['#a78bfa', '≥ 10G', '10 Gbps+'],
                    ['#38bdf8', '1G', '1 Gbps'],
                    ['#86efac', '100M', '100 Mbps'],
                    ['#fbbf24', '<100M', '10/100 Mbps'],
                  ].map(([c, speed, label]) => (
                    <div key={speed} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                      <div style={{ width: 18, height: 3, background: c, borderRadius: 2, flexShrink: 0 }} />
                      <span style={{ color: textColor, fontSize: 10, minWidth: 32 }}>{speed}</span>
                      <span style={{ color: subColor, fontSize: 10 }}>— {label}</span>
                    </div>
                  ))}
                  <div style={{ color: subColor, fontSize: 9, marginTop: 4 }}>
                    Kenar üzerine gelin → hız rozeti görünür
                  </div>
                </div>
              </div>
            </Space>
          </Panel>
        </ReactFlow>
        </div>
      </div>

      {/* Device detail drawer */}
      <Drawer
        title={
          <Space>
            <ApartmentOutlined style={{ color: '#3b82f6' }} />
            <span>{selectedDevice?.hostname}</span>
          </Space>
        }
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={380}
      >
        {selectedDevice && (
          <>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="IP">{selectedDevice.ip_address}</Descriptions.Item>
              <Descriptions.Item label="Vendor">
                <Tag color="blue" style={{ textTransform: 'capitalize' }}>{selectedDevice.vendor}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="OS">{selectedDevice.os_type}</Descriptions.Item>
              <Descriptions.Item label="Model">{selectedDevice.model || '—'}</Descriptions.Item>
              <Descriptions.Item label="Konum">{selectedDevice.location || '—'}</Descriptions.Item>
              <Descriptions.Item label="Durum">
                <Badge
                  status={selectedDevice.status === 'online' ? 'success' : selectedDevice.status === 'offline' ? 'error' : 'default'}
                  text={selectedDevice.status}
                />
              </Descriptions.Item>
            </Descriptions>
            <Button
              block type="primary" icon={<ThunderboltOutlined />}
              loading={singleDiscoverMutation.isPending}
              onClick={() => singleDiscoverMutation.mutate(selectedDevice.id)}
              style={{ marginTop: 16 }}
            >
              LLDP Keşfet
            </Button>
            <Button
              block icon={<RadarChartOutlined />}
              loading={blastRadiusMutation.isPending}
              onClick={() => blastRadiusMutation.mutate(selectedDevice.id)}
              style={{ marginTop: 8, borderColor: '#ef4444', color: '#ef4444' }}
            >
              Blast Radius Analizi
            </Button>
          </>
        )}
      </Drawer>

      {/* LLDP single-device result modal */}
      <Modal
        title={`LLDP Keşif Sonucu — ${discoverResult?.hostname}`}
        open={discoverModalOpen}
        onCancel={() => setDiscoverModalOpen(false)}
        width={700}
        footer={[
          discoverResult?.new_switches && discoverResult.new_switches.length > 0 && (() => {
            const hopIps = discoverResult.new_switches
              .filter((s) => s.hop_discoverable && s.ip)
              .map((s) => s.ip as string)
            const noIpCount = discoverResult.new_switches.length - hopIps.length
            return (
              <Tooltip key="hop"
                title={hopIps.length === 0
                  ? `${noIpCount} switch'in benzersiz IP'si yok, atlama keşfi yapılamaz`
                  : noIpCount > 0 ? `${noIpCount} switch'in benzersiz IP'si olmadığından atlanacak` : undefined}
              >
                <Button type="primary" icon={<BranchesOutlined />}
                  loading={hopMutation.isPending}
                  disabled={hopIps.length === 0}
                  onClick={() => hopMutation.mutate({ source_id: discoverResult.device_id, ips: hopIps })}>
                  {hopIps.length} Switch'e Atla{noIpCount > 0 ? ` (${noIpCount} IP'siz)` : '!'}
                </Button>
              </Tooltip>
            )
          })(),
          <Button key="close" onClick={() => setDiscoverModalOpen(false)}>Kapat</Button>,
        ].filter(Boolean)}
      >
        {discoverResult && (
          <>
            {discoverResult.new_switches.length > 0 && (() => {
              const hopCount = discoverResult.new_switches.filter((s) => s.hop_discoverable).length
              const noIpCount = discoverResult.new_switches.length - hopCount
              return (
                <Alert type="warning" style={{ marginBottom: 12 }}
                  message={`${discoverResult.new_switches.length} yeni switch envanterde yok`}
                  description={
                    hopCount > 0
                      ? `${hopCount} tanesi benzersiz IP'ye sahip, atlama keşfi başlatılabilir.${noIpCount > 0 ? ` ${noIpCount} tanesinin IP'si yok veya paylaşımlı.` : ''}`
                      : 'Tüm switch\'lerin benzersiz IP\'si yok — atlama keşfi yapılamaz.'
                  }
                  showIcon />
              )
            })()}
            <Table dataSource={discoverResult.neighbors} rowKey={(r) => `${r.local_port}-${r.hostname}`}
              size="small" pagination={false} scroll={{ y: 300 }} columns={neighborColumns} />
          </>
        )}
      </Modal>

      {/* Ghost switch connect modal */}
      <Modal
        title={`🔀 ${ghostTarget?.hostname} — Ghost Switch`}
        open={ghostConnectModalOpen}
        onCancel={() => setGhostConnectModalOpen(false)}
        footer={[
          <Button key="connect" type="primary" icon={<LoginOutlined />}
            loading={discoverGhostMutation.isPending}
            onClick={() => ghostTarget && discoverGhostMutation.mutate({
              hostname: ghostTarget.hostname,
              ip: ghostTarget.ip,
              source_device_id: ghostTarget.source_device_id,
            })}>
            Bağlan ve Keşfet
          </Button>,
          <Button key="cancel" onClick={() => setGhostConnectModalOpen(false)}>İptal</Button>,
        ]}
      >
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="Hostname">{ghostTarget?.hostname}</Descriptions.Item>
          <Descriptions.Item label="IP">{ghostTarget?.ip || '—'}</Descriptions.Item>
        </Descriptions>
        <Alert
          type="info" style={{ marginTop: 12 }}
          message="Aynı vendor'a ait kayıtlı kullanıcı bilgileri denecek."
          description="Bağlantı başarılı olursa cihaz envantere eklenir ve LLDP komşuları keşfedilir. Başarısız olursa kullanıcı bilgisi girmeniz istenecek."
          showIcon
        />
      </Modal>

      {/* Credential input modal */}
      <Modal
        title={`Kullanıcı Bilgisi Gir — ${ghostTarget?.hostname}`}
        open={credModalOpen}
        onCancel={() => { setCredModalOpen(false); credForm.resetFields() }}
        footer={[
          <Button key="submit" type="primary" icon={<LoginOutlined />}
            loading={discoverGhostMutation.isPending}
            onClick={handleCredSubmit}>
            Bağlan
          </Button>,
          <Button key="cancel" onClick={() => { setCredModalOpen(false); credForm.resetFields() }}>İptal</Button>,
        ]}
      >
        <Alert type="warning" message="Otomatik giriş başarısız oldu" style={{ marginBottom: 16 }}
          description={`${ghostTarget?.ip} adresine bağlanmak için kullanıcı adı ve şifre girin.`} showIcon />
        <Form form={credForm} layout="vertical">
          <Form.Item name="username" label="Kullanıcı Adı" rules={[{ required: true }]}>
            <Input placeholder="admin" autoComplete="off" />
          </Form.Item>
          <Form.Item name="password" label="Şifre" rules={[{ required: true }]}>
            <Input.Password placeholder="••••••••" autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="os_type" label="OS Tipi" rules={[{ required: true }]}
            initialValue={ghostTarget?.source_device_id ? undefined : 'ruijie_os'}>
            <Select options={OS_TYPE_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Blast Radius Modal */}
      <Modal
        title={
          <Space>
            <RadarChartOutlined style={{ color: '#ef4444' }} />
            <span>Blast Radius — {selectedDevice?.hostname}</span>
          </Space>
        }
        open={blastModalOpen}
        onCancel={() => setBlastModalOpen(false)}
        width={680}
        footer={<Button onClick={() => setBlastModalOpen(false)}>Kapat</Button>}
      >
        {blastRadiusMutation.data && (() => {
          const br = blastRadiusMutation.data
          const VENDOR_COLORS_BR: Record<string, string> = { cisco: 'blue', aruba: 'cyan', ruijie: 'red', other: 'default' }
          const LAYER_COLORS_BR: Record<string, string> = { core: 'red', distribution: 'orange', access: 'blue', edge: 'green', wireless: 'purple' }
          return (
            <>
              {br.is_critical ? (
                <Alert
                  type="error"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message={`KRİTİK — Bu cihaz devre dışı kalırsa ${br.affected_count} cihaz bağlantısını kaybeder`}
                  description="Bu switch bir ağ bölümünün tek bağlantı noktasıdır (articulation point). Yedeklilik planlaması önerilir."
                />
              ) : (
                <Alert
                  type="success"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message="Ağ dayanıklı — Bu cihaz devre dışı kalsa bile alt ağlar bağlantısını korur"
                />
              )}
              <Row gutter={12} style={{ marginBottom: 16 }}>
                {[
                  { label: 'Doğrudan Bağlantı', value: br.direct_neighbors, color: '#3b82f6' },
                  { label: 'Etkilenen Cihaz', value: br.affected_count, color: br.is_critical ? '#ef4444' : '#22c55e' },
                  { label: 'Toplam Topoloji', value: br.total_nodes_in_topology, color: '#64748b' },
                ].map(s => (
                  <Col span={8} key={s.label}>
                    <Card size="small" style={{ textAlign: 'center', border: `1px solid ${s.color}33` }}>
                      <div style={{ fontSize: 28, fontWeight: 700, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 11, color: '#8c8c8c' }}>{s.label}</div>
                    </Card>
                  </Col>
                ))}
              </Row>
              {br.affected_devices.length > 0 && (
                <Table
                  dataSource={br.affected_devices}
                  rowKey="id"
                  size="small"
                  pagination={false}
                  scroll={{ y: 240 }}
                  columns={[
                    { title: 'Hostname', dataIndex: 'hostname', render: (v: string) => <strong>{v}</strong> },
                    { title: 'IP', dataIndex: 'ip_address', render: (v: string) => <code style={{ fontSize: 11 }}>{v}</code> },
                    { title: 'Vendor', dataIndex: 'vendor', width: 80, render: (v: string) => <Tag color={VENDOR_COLORS_BR[v] || 'default'} style={{ textTransform: 'capitalize' }}>{v}</Tag> },
                    { title: 'Katman', dataIndex: 'layer', width: 90, render: (v: string) => v ? <Tag color={LAYER_COLORS_BR[v] || 'default'}>{v}</Tag> : <span style={{ color: '#bfbfbf' }}>—</span> },
                    {
                      title: 'Durum', dataIndex: 'status', width: 80,
                      render: (v: string) => <Tag color={v === 'online' ? 'success' : v === 'offline' ? 'error' : 'default'}>{v}</Tag>,
                    },
                  ]}
                />
              )}
            </>
          )
        })()}
      </Modal>

      {/* Anomaly Detection Modal */}
      <Modal
        title={
          <Space>
            <BugOutlined style={{ color: '#f59e0b' }} />
            <span>L2 Anomali Raporu</span>
            {anomalyMutation.data && (
              <span style={{ fontSize: 12, color: subColor }}>
                — {anomalyMutation.data.count} anomali bulundu
              </span>
            )}
          </Space>
        }
        open={anomalyModalOpen}
        onCancel={() => setAnomalyModalOpen(false)}
        width={720}
        footer={<Button onClick={() => setAnomalyModalOpen(false)}>Kapat</Button>}
      >
        {anomalyMutation.data && (() => {
          const { anomalies, warning_count, info_count, count } = anomalyMutation.data

          const ANOMALY_TYPE_LABEL: Record<string, string> = {
            duplicate_hostname: 'Çift Hostname',
            asymmetric_link: 'Asimetrik Bağlantı',
            stale_links: 'Eski Bağlantı',
            ghost_overload: 'Ghost Yoğunluğu',
          }

          return (
            <>
              <Row gutter={12} style={{ marginBottom: 16 }}>
                {[
                  { label: 'Toplam Anomali', value: count, color: count > 0 ? '#f59e0b' : '#22c55e' },
                  { label: 'Uyarı', value: warning_count, color: '#ef4444' },
                  { label: 'Bilgi', value: info_count, color: '#3b82f6' },
                ].map((s) => (
                  <Col span={8} key={s.label}>
                    <Card size="small" style={{ textAlign: 'center', border: `1px solid ${s.color}33` }}>
                      <div style={{ fontSize: 26, fontWeight: 700, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 11, color: '#8c8c8c' }}>{s.label}</div>
                    </Card>
                  </Col>
                ))}
              </Row>

              {count === 0 ? (
                <Alert type="success" showIcon message="Anomali bulunamadı — topoloji temiz görünüyor" />
              ) : (
                <Table
                  dataSource={anomalies}
                  rowKey={(r, i) => `${r.type}-${i}`}
                  size="small"
                  pagination={false}
                  scroll={{ y: 340 }}
                  expandable={{
                    expandedRowRender: (r) => (
                      <div style={{ fontSize: 11, color: subColor, padding: '4px 8px' }}>
                        {r.type === 'duplicate_hostname' && (
                          <>
                            <strong>IP'ler:</strong> {(r.details.ips as string[]).join(', ')}<br />
                            <strong>Kaynaklar:</strong>{' '}
                            {(r.details.sources as any[]).map((s, i) => (
                              <span key={i}>{s.source} ({s.port}){i < (r.details.sources as any[]).length - 1 ? ', ' : ''}</span>
                            ))}
                          </>
                        )}
                        {r.type === 'asymmetric_link' && (
                          <>{r.details.source_hostname as string} ({r.details.source_ip as string}) → {r.details.target_hostname as string} ({r.details.target_ip as string})</>
                        )}
                        {(r.type === 'stale_links' || r.type === 'ghost_overload') && (
                          <>{r.details.hostname as string} — {r.details.ip as string}</>
                        )}
                      </div>
                    ),
                    rowExpandable: () => true,
                  }}
                  columns={[
                    {
                      title: 'Şiddet', dataIndex: 'severity', width: 90,
                      render: (v: string) => (
                        <Tag color={v === 'warning' ? 'warning' : 'processing'} style={{ fontWeight: 600 }}>
                          {v === 'warning' ? '⚠ UYARI' : 'ℹ BİLGİ'}
                        </Tag>
                      ),
                    },
                    {
                      title: 'Tür', dataIndex: 'type', width: 140,
                      render: (v: string) => (
                        <span style={{ fontSize: 11, fontWeight: 600 }}>
                          {ANOMALY_TYPE_LABEL[v] || v}
                        </span>
                      ),
                    },
                    { title: 'Mesaj', dataIndex: 'message', render: (v: string) => <span style={{ fontSize: 12 }}>{v}</span> },
                  ]}
                />
              )}
            </>
          )
        })()}
      </Modal>

      {/* Ghost discovery result modal */}
      <Modal
        title={
          <Space>
            <CheckCircleOutlined style={{ color: '#22c55e' }} />
            <span>{ghostResult?.hostname} Keşfedildi</span>
          </Space>
        }
        open={ghostResultModalOpen}
        onCancel={() => setGhostResultModalOpen(false)}
        width={700}
        footer={[
          ghostResult?.new_switches && ghostResult.new_switches.length > 0 && (() => {
            const hopIps = ghostResult.new_switches!
              .filter((s) => s.hop_discoverable && s.ip)
              .map((s) => s.ip as string)
            const noIpCount = ghostResult.new_switches!.length - hopIps.length
            return (
              <Tooltip key="hop"
                title={hopIps.length === 0
                  ? `${noIpCount} switch'in benzersiz IP'si yok, atlama keşfi yapılamaz`
                  : noIpCount > 0 ? `${noIpCount} switch'in benzersiz IP'si olmadığından atlanacak` : undefined}
              >
                <Button type="primary" icon={<BranchesOutlined />}
                  loading={hopMutation.isPending}
                  disabled={hopIps.length === 0}
                  onClick={() => {
                    if (!ghostResult) return
                    hopMutation.mutate({ source_id: ghostResult.device_id!, ips: hopIps })
                  }}>
                  {hopIps.length} Switch'e Atla{noIpCount > 0 ? ` (${noIpCount} IP'siz)` : '!'}
                </Button>
              </Tooltip>
            )
          })(),
          <Button key="close" onClick={() => setGhostResultModalOpen(false)}>Kapat</Button>,
        ].filter(Boolean)}
      >
        {ghostResult && (
          <>
            <Alert type="success" style={{ marginBottom: 12 }}
              message={`${ghostResult.is_new ? 'Yeni cihaz envantere eklendi' : 'Mevcut cihaz güncellendi'} — ${ghostResult.neighbor_count} komşu bulundu`}
              showIcon />
            {ghostResult.new_switches && ghostResult.new_switches.length > 0 && (
              <Alert type="warning" style={{ marginBottom: 12 }}
                message={`${ghostResult.new_switches.length} yeni switch envanterde yok`}
                description="Atlama keşfi başlatarak haritayı genişletebilirsiniz."
                showIcon />
            )}
            <Table
              dataSource={ghostResult.neighbors || []}
              rowKey={(r) => `${r.local_port}-${r.hostname}`}
              size="small" pagination={false} scroll={{ y: 300 }}
              columns={neighborColumns}
            />
          </>
        )}
      </Modal>

      {/* Bulk LLDP Results Modal */}
      <Modal
        title={<span><ThunderboltOutlined style={{ color: '#22c55e', marginRight: 8 }} />Toplu LLDP Keşif Sonuçları</span>}
        open={bulkResultModal}
        onCancel={() => setBulkResultModal(false)}
        footer={<Button type="primary" onClick={() => setBulkResultModal(false)}>Kapat</Button>}
        width={560}
      >
        <div style={{ marginBottom: 12, display: 'flex', gap: 12 }}>
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '8px 16px', flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 900, color: '#16a34a' }}>{bulkResults.filter(r => r.success).length}</div>
            <div style={{ fontSize: 11, color: '#15803d' }}>Başarılı</div>
          </div>
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 16px', flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 900, color: '#dc2626' }}>{bulkResults.filter(r => !r.success).length}</div>
            <div style={{ fontSize: 11, color: '#b91c1c' }}>Başarısız</div>
          </div>
          <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '8px 16px', flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 900, color: '#2563eb' }}>{bulkResults.reduce((s, r) => s + r.neighbor_count, 0)}</div>
            <div style={{ fontSize: 11, color: '#1d4ed8' }}>Toplam Komşu</div>
          </div>
        </div>
        <Table
          size="small"
          dataSource={bulkResults.map((r, i) => ({ ...r, key: i }))}
          pagination={false}
          scroll={{ y: 320 }}
          columns={[
            {
              title: 'Cihaz',
              dataIndex: 'hostname',
              render: (v: string, r: any) => (
                <span style={{ fontWeight: 600 }}>{r.success ? '🟢' : '🔴'} {v}</span>
              ),
            },
            {
              title: 'Komşu',
              dataIndex: 'neighbor_count',
              width: 70,
              align: 'center' as const,
              render: (v: number) => <Tag color="blue">{v}</Tag>,
            },
            {
              title: 'Durum',
              dataIndex: 'success',
              width: 110,
              render: (v: boolean, r: any) =>
                v ? <Tag color="success">Başarılı</Tag> : <Tag color="error">{r.error || 'Hata'}</Tag>,
            },
          ]}
        />
      </Modal>
    </div>
  )
}

export default function TopologyPage() {
  const { isDark } = useTheme()
  const TV = mkTV(isDark)
  const accentColor = isDark ? '#00d4ff' : '#3b82f6'
  const accentGlow  = isDark ? 'rgba(0,212,255,0.4)' : 'rgba(59,130,246,0.3)'

  return (
    <div style={{
      margin: -24, padding: 24,
      minHeight: '100vh',
      background: isDark
        ? `radial-gradient(ellipse at 10% 5%, rgba(0,80,160,0.15) 0%, transparent 40%),
           radial-gradient(ellipse at 90% 95%, rgba(80,0,160,0.10) 0%, transparent 40%),
           #030c1e`
        : TV.page,
    }}>
      <style>{`
        ${mkTopoCSS(isDark)}
        @keyframes topoNodeLed     { 0%,100%{box-shadow:0 0 4px 1px #00e67660} 50%{box-shadow:0 0 10px 2px #00e67690} }
        @keyframes topoNodeOffline { 0%,100%{opacity:1} 50%{opacity:0.55} }
        @keyframes edgeFlow        { from{stroke-dashoffset:0} to{stroke-dashoffset:-20} }
      `}</style>

      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        {isDark && (
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: accentColor, boxShadow: `0 0 10px ${accentColor}`,
            animation: 'topoNodeLed 2.5s ease-in-out infinite',
          }} />
        )}
        <span style={{
          color: accentColor, fontWeight: 900, fontSize: 16,
          letterSpacing: isDark ? 2.5 : 1,
          textShadow: isDark ? `0 0 20px ${accentGlow}` : undefined,
        }}>
          AĞ TOPOLOJİSİ
        </span>
        <div style={{
          flex: 1, height: 1,
          background: isDark
            ? 'linear-gradient(90deg,rgba(0,195,255,0.3),transparent)'
            : 'linear-gradient(90deg,#e2e8f0,transparent)',
        }} />
      </div>

      <ReactFlowProvider>
        <TopologyFlow />
      </ReactFlowProvider>
    </div>
  )
}
