// NocRacks — T8.4 NOC design Kabinler page (mockup pages-racks.jsx).
// Mockup-faithful chrome (nm-page / nm-statbar / nm-rack-grid cards with
// U-elevation mini-bar + 3-stat / nm-rack-detail with nm-rack-3d full frame +
// tabs) wired to REAL data via racksApi. Tabs are pruned to features that
// exist in our backend (Cihazlar + Items) — güç / sıcaklık / kablolama tabs
// from the mockup are NOT added because the backend has no such data
// (uydurma yapmıyoruz). Full rack management (create/delete rack, delete
// item, remove device placement) is wired to real endpoints. Detailed
// drag-drop / port panel from the legacy page is preserved in git and
// reachable as a later iteration.
import { useMemo, useState } from 'react'
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query'
import { App, Modal, Input, InputNumber, Popconfirm, Tag, Select } from 'antd'
import { DeleteOutlined, AppstoreOutlined, HddOutlined, PlusOutlined } from '@ant-design/icons'
import { racksApi, type RackSummary, type RackDetail, type RackDeviceSummary, type RackItem } from '@/api/racks'

type DevStatus = 'ok' | 'warn' | 'crit' | 'offline'
const STATUS_OF = (d: RackDeviceSummary): DevStatus => {
  const s = (d.status || '').toLowerCase()
  if (s === 'critical' || s === 'crit') return 'crit'
  if (s === 'warning' || s === 'warn') return 'warn'
  if (s === 'offline' || s === 'down') return 'offline'
  return 'ok'
}

// Aggregate worst status across a rack's devices.
const RACK_STATUS = (devices: RackDeviceSummary[]): DevStatus | 'empty' => {
  if (devices.length === 0) return 'empty'
  if (devices.some((d) => STATUS_OF(d) === 'crit')) return 'crit'
  if (devices.some((d) => STATUS_OF(d) === 'warn' || STATUS_OF(d) === 'offline')) return 'warn'
  return 'ok'
}

// Build the per-U status map for the mini elevation bar (top → bottom).
const buildMiniMap = (totalU: number, devices: RackDeviceSummary[], items: RackItem[]): string[] => {
  const map = Array<string>(totalU).fill('empty')
  for (const d of devices) {
    const st = STATUS_OF(d)
    for (let i = 0; i < (d.rack_height || 1); i++) {
      // mockup: idx = totalU - u + i - (size - 1) — same as our column-reverse layout.
      const idx = totalU - d.rack_unit + i - ((d.rack_height || 1) - 1)
      if (idx >= 0 && idx < totalU) map[idx] = st
    }
  }
  for (const it of items) {
    for (let i = 0; i < (it.unit_height || 1); i++) {
      const idx = totalU - it.unit_start + i - ((it.unit_height || 1) - 1)
      if (idx >= 0 && idx < totalU && map[idx] === 'empty') map[idx] = 'ok'
    }
  }
  return map
}

export default function NocRacks() {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const { data: racks = [], isLoading } = useQuery({
    queryKey: ['racks-list'],
    queryFn: () => racksApi.list(),
    refetchInterval: 60000,
  })
  const [active, setActive] = useState<string | null>(null)
  const [tab, setTab] = useState<'devices' | 'items'>('devices')
  const [addOpen, setAddOpen] = useState(false)
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null)
  // Boş U'ya tıklandığında açılan "Cihaz Yerleştir" modali için seçilen U.
  const [placeAtU, setPlaceAtU] = useState<{ u: number; maxHeight: number } | null>(null)

  // Auto-activate first rack once the list arrives.
  if (active == null && racks.length > 0) {
    setTimeout(() => setActive(racks[0].rack_name), 0)
  }

  // Per-rack detail for the cards' mini-bar / status — parallel queries.
  const detailQueries = useQueries({
    queries: racks.map((r) => ({
      queryKey: ['rack-detail', r.rack_name],
      queryFn: () => racksApi.get(r.rack_name),
      refetchInterval: 60000,
    })),
  })
  const detailByName = useMemo(() => {
    const m: Record<string, RackDetail> = {}
    racks.forEach((r, i) => {
      const d = detailQueries[i]?.data
      if (d) m[r.rack_name] = d
    })
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [racks, detailQueries.map((q) => q.dataUpdatedAt).join(',')])

  const activeDetail = active ? detailByName[active] : undefined

  // ── stats (real data, no faked metrics) ─────────────────────────────────
  const totalU = racks.reduce((s, r) => s + r.total_u, 0)
  const usedU = racks.reduce((s, r) => s + r.used_u, 0)
  const totalDevices = racks.reduce((s, r) => s + r.device_count, 0)
  const totalItems = racks.reduce((s, r) => s + r.item_count, 0)
  // health rollups — computed from per-rack devices when detail is loaded;
  // pending racks count as 'unknown' (excluded from ok/warn/crit).
  let ok = 0, warn = 0, crit = 0
  racks.forEach((r) => {
    const d = detailByName[r.rack_name]
    if (!d) return
    const st = RACK_STATUS(d.devices)
    if (st === 'ok' || st === 'empty') ok++
    else if (st === 'warn') warn++
    else if (st === 'crit') crit++
  })

  // ── mutations ───────────────────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: (vars: { rack_name: string; total_u: number; description?: string }) => racksApi.create(vars),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['racks-list'] })
      setActive(r.rack_name); setAddOpen(false)
      message.success('Kabin oluşturuldu')
    },
    onError: (e) => message.error((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Oluşturulamadı'),
  })
  const deleteRackMut = useMutation({
    mutationFn: (rackName: string) => racksApi.deleteRack(rackName),
    onSuccess: (_d, rackName) => {
      qc.invalidateQueries({ queryKey: ['racks-list'] })
      if (active === rackName) setActive(null)
      message.success('Kabin silindi')
    },
    onError: (e) => message.error((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Silinemedi'),
  })
  const removePlacementMut = useMutation({
    mutationFn: (deviceId: number) => racksApi.removePlacement(deviceId),
    onSuccess: () => {
      if (active) qc.invalidateQueries({ queryKey: ['rack-detail', active] })
      qc.invalidateQueries({ queryKey: ['racks-list'] })
      message.success('Cihaz kabinden çıkarıldı')
    },
    onError: (e) => message.error((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Çıkarılamadı'),
  })
  const deleteItemMut = useMutation({
    mutationFn: ({ rackName, itemId }: { rackName: string; itemId: number }) => racksApi.deleteItem(rackName, itemId),
    onSuccess: () => {
      if (active) qc.invalidateQueries({ queryKey: ['rack-detail', active] })
      qc.invalidateQueries({ queryKey: ['racks-list'] })
      message.success('Item silindi')
    },
    onError: (e) => message.error((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Silinemedi'),
  })
  const placeMut = useMutation({
    mutationFn: (vars: { deviceId: number; rack_name: string; rack_unit: number; rack_height: number }) =>
      racksApi.setPlacement(vars.deviceId, vars.rack_name, vars.rack_unit, vars.rack_height),
    onSuccess: () => {
      if (active) qc.invalidateQueries({ queryKey: ['rack-detail', active] })
      qc.invalidateQueries({ queryKey: ['racks-list'] })
      qc.invalidateQueries({ queryKey: ['rack-unassigned'] })
      setPlaceAtU(null)
      message.success('Cihaz kabine yerleştirildi')
    },
    onError: (e) => message.error((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Yerleştirilemedi'),
  })
  const createItemMut = useMutation({
    mutationFn: (vars: { rackName: string; label: string; item_type: string; unit_start: number; unit_height: number; notes?: string }) =>
      racksApi.createItem(vars.rackName, {
        label: vars.label, item_type: vars.item_type,
        unit_start: vars.unit_start, unit_height: vars.unit_height, notes: vars.notes,
      }),
    onSuccess: () => {
      if (active) qc.invalidateQueries({ queryKey: ['rack-detail', active] })
      qc.invalidateQueries({ queryKey: ['racks-list'] })
      setPlaceAtU(null)
      message.success('Item kabine eklendi')
    },
    onError: (e) => message.error((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Eklenemedi'),
  })

  // Lokasyon kapsamında daha önce kullanılmış item_type değerleri — kullanıcı
  // bir kez "kumanda" yazınca bir sonraki seferde listede görür. Tek DB +
  // RLS (organization_id + location_id) sayesinde başka lokasyon görmüyor.
  const knownItemTypes = useMemo(() => {
    const s = new Set<string>()
    for (const r of Object.values(detailByName)) {
      for (const it of r.items) if (it.item_type) s.add(it.item_type)
    }
    return Array.from(s).sort()
  }, [detailByName])

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>Envanter</span><span>Kabinler</span></div>
          <h1 className="nm-page-title">
            Kabinler &amp; Rack&apos;lar
            <span className="nm-pill mono">{racks.length} kabin · {totalDevices} cihaz · {totalItems} item</span>
          </h1>
          <div className="nm-page-sub">Fiziksel yerleşim · U bazlı cihaz haritası · gerçek envanter (RackItem: PDU/UPS/patch panel/etc.).</div>
        </div>
        <div className="nm-page-actions">
          <button className="nm-btn primary" onClick={() => setAddOpen(true)}>+ Kabin Ekle</button>
        </div>
      </div>

      <div className="nm-statbar">
        <div className="nm-stat">
          <div className="nm-stat-label">Toplam U</div>
          <div className="nm-stat-val">{usedU}<small>/ {totalU}</small></div>
          <div className="nm-stat-delta">{totalU > 0 ? Math.round((usedU / totalU) * 100) : 0}% dolu</div>
        </div>
        <div className="nm-stat ok"><div className="nm-stat-label">Sağlıklı</div><div className="nm-stat-val">{ok}</div></div>
        <div className="nm-stat warn"><div className="nm-stat-label">Dikkat</div><div className="nm-stat-val">{warn}</div></div>
        <div className="nm-stat crit"><div className="nm-stat-label">Kritik</div><div className="nm-stat-val">{crit}</div></div>
        <div className="nm-stat"><div className="nm-stat-label">Toplam Cihaz</div><div className="nm-stat-val">{totalDevices}</div></div>
        <div className="nm-stat"><div className="nm-stat-label">Items</div><div className="nm-stat-val">{totalItems}</div><div className="nm-stat-delta">PDU · UPS · patch · …</div></div>
      </div>

      {isLoading ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--fg-3)' }}>Yükleniyor…</div>
      ) : racks.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--fg-3)' }}>
          <HddOutlined style={{ fontSize: 28, opacity: 0.4 }} />
          <div style={{ marginTop: 10 }}>Henüz kabin yok — <button className="nm-btn ghost" style={{ height: 24, fontSize: 11, padding: '0 10px', marginLeft: 4 }} onClick={() => setAddOpen(true)}>+ Kabin Ekle</button></div>
        </div>
      ) : (
        <div className="nm-rack-grid">
          {racks.map((r) => <RackCard key={r.rack_name} rack={r} detail={detailByName[r.rack_name]}
            active={active === r.rack_name} onSelect={() => setActive(r.rack_name)}
            onDelete={() => deleteRackMut.mutate(r.rack_name)} />)}
        </div>
      )}

      {activeDetail && (
        <div className="nm-rack-detail">
          <div className="nm-rack-3d">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{activeDetail.rack_name}</div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                  {activeDetail.devices.length} cihaz · {activeDetail.items.length} item · {activeDetail.total_u}U
                </div>
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>Boş U'ya tıkla veya</span>
                <button className="nm-btn primary" style={{ height: 26, fontSize: 11 }}
                  onClick={() => {
                    // İlk uygun boş U'yu bul; yoksa U1 fallback.
                    const totalU = activeDetail.total_u
                    const occupied = new Set<number>()
                    for (const d of activeDetail.devices) for (let i = 0; i < (d.rack_height || 1); i++) occupied.add(d.rack_unit + i)
                    for (const it of activeDetail.items) for (let i = 0; i < (it.unit_height || 1); i++) occupied.add(it.unit_start + i)
                    let u = 1; while (u <= totalU && occupied.has(u)) u++
                    if (u > totalU) { message.warning('Kabinde boş U yok'); return }
                    let max = 0; for (let i = u; i <= totalU; i++) { if (occupied.has(i)) break; max++ }
                    setPlaceAtU({ u, maxHeight: max })
                  }}>+ Cihaz / Item Ekle</button>
              </div>
            </div>
            <RackFrame detail={activeDetail}
              selectedDeviceId={selectedDeviceId}
              onSelectDevice={(id) => setSelectedDeviceId(id)}
              onClickEmpty={(u, maxHeight) => setPlaceAtU({ u, maxHeight })} />
          </div>

          <div className="nm-rack-rule">
            <div className="nm-rack-toolbar">
              <button className={`nm-btn ${tab === 'devices' ? 'primary' : 'ghost'}`} onClick={() => setTab('devices')}>
                Cihazlar <span className="nm-pill mono" style={{ marginLeft: 4 }}>{activeDetail.devices.length}</span>
              </button>
              <button className={`nm-btn ${tab === 'items' ? 'primary' : 'ghost'}`} onClick={() => setTab('items')}>
                Items <span className="nm-pill mono" style={{ marginLeft: 4 }}>{activeDetail.items.length}</span>
              </button>
            </div>

            {tab === 'devices' ? (
              <DeviceList detail={activeDetail}
                selectedDeviceId={selectedDeviceId}
                onSelect={(id) => setSelectedDeviceId(id)}
                onRemove={(id) => { removePlacementMut.mutate(id); if (selectedDeviceId === id) setSelectedDeviceId(null) }} />
            ) : (
              <ItemList detail={activeDetail} onRemove={(itemId) => deleteItemMut.mutate({ rackName: activeDetail.rack_name, itemId })} />
            )}
          </div>
        </div>
      )}

      <AddRackModal open={addOpen} onClose={() => setAddOpen(false)}
        onSubmit={(v) => createMut.mutate(v)} loading={createMut.isPending} />

      {placeAtU && activeDetail && (
        <PlaceModal open onClose={() => setPlaceAtU(null)}
          rackName={activeDetail.rack_name} u={placeAtU.u} maxHeight={placeAtU.maxHeight}
          knownItemTypes={knownItemTypes}
          deviceLoading={placeMut.isPending}
          itemLoading={createItemMut.isPending}
          onPlaceDevice={(deviceId, height) => placeMut.mutate({
            deviceId, rack_name: activeDetail.rack_name, rack_unit: placeAtU.u, rack_height: height,
          })}
          onCreateItem={(vars) => createItemMut.mutate({
            rackName: activeDetail.rack_name,
            label: vars.label, item_type: vars.item_type,
            unit_start: placeAtU.u, unit_height: vars.height, notes: vars.notes,
          })}
        />
      )}
    </div>
  )
}

// ── Rack card ─────────────────────────────────────────────────────────────
function RackCard({ rack, detail, active, onSelect, onDelete }:
  { rack: RackSummary; detail?: RackDetail; active: boolean; onSelect: () => void; onDelete: () => void }) {
  const status = detail ? RACK_STATUS(detail.devices) : 'empty'
  const mini = detail ? buildMiniMap(detail.total_u, detail.devices, detail.items) : Array(rack.total_u).fill('empty') as string[]
  const fillPct = rack.total_u > 0 ? Math.round((rack.used_u / rack.total_u) * 100) : 0
  return (
    <div className={`nm-rack-card ${active ? 'active' : ''}`} onClick={onSelect} style={{ cursor: 'pointer' }}>
      <div className="hd">
        <span className={`nm-status-dot ${status === 'empty' ? '' : status}`}></span>
        <span className="name">{rack.rack_name}</span>
        <span className="meta">{rack.used_u}/{rack.total_u}U</span>
        <span onClick={(e) => e.stopPropagation()} style={{ marginLeft: 4 }}>
          <Popconfirm title="Kabin silinsin mi?" description="Cihazların yerleşimi kaldırılır (cihazlar kalır)."
            okText="Sil" cancelText="İptal" okButtonProps={{ danger: true }} onConfirm={onDelete}>
            <button className="nm-btn ghost" style={{ height: 20, fontSize: 10, padding: '0 6px' }} title="Kabini sil">×</button>
          </Popconfirm>
        </span>
      </div>
      <div className="nm-rack-mini">
        {mini.map((s, i) => <div key={i} className={`nm-rack-mini-u ${s}`}></div>)}
      </div>
      <div className="nm-rack-stats">
        <div><div className="v">{rack.device_count}</div><div className="l">CİHAZ</div></div>
        <div><div className="v">{fillPct}<small>%</small></div><div className="l">DOLULUK</div></div>
        <div><div className="v">{rack.item_count}</div><div className="l">ITEMS</div></div>
      </div>
    </div>
  )
}

// ── Full U-elevation frame ────────────────────────────────────────────────
// U1 yukarıda (kullanıcı tercihi — diagram/inventory konvansiyonu, fiziksel
// rack tersine olsa da). Frame'in CSS `column-reverse` default'unu inline
// flexDirection: 'column' ile override ediyoruz; iteration u=1..N olarak
// kalıyor → DOM[0]=U1 görsel olarak en üstte.
function RackFrame({ detail, selectedDeviceId, onSelectDevice, onClickEmpty }: {
  detail: RackDetail
  selectedDeviceId: number | null
  onSelectDevice: (id: number) => void
  onClickEmpty: (u: number, maxHeight: number) => void
}) {
  const totalU = detail.total_u
  type Slot = { kind: 'dev'; dev: RackDeviceSummary } | { kind: 'item'; item: RackItem } | { kind: 'empty' } | { kind: 'continuation' }
  const slots: Slot[] = Array.from({ length: totalU }, () => ({ kind: 'empty' }))
  for (const d of detail.devices) {
    if (d.rack_unit < 1 || d.rack_unit > totalU) continue
    const idx = d.rack_unit - 1
    slots[idx] = { kind: 'dev', dev: d }
    for (let h = 1; h < (d.rack_height || 1); h++) {
      if (idx + h < totalU) slots[idx + h] = { kind: 'continuation' }
    }
  }
  for (const it of detail.items) {
    if (it.unit_start < 1 || it.unit_start > totalU) continue
    const idx = it.unit_start - 1
    if (slots[idx].kind === 'empty') slots[idx] = { kind: 'item', item: it }
    for (let h = 1; h < (it.unit_height || 1); h++) {
      if (idx + h < totalU && slots[idx + h].kind === 'empty') slots[idx + h] = { kind: 'continuation' }
    }
  }

  // Bir U'dan başlayarak kaç ardışık boş U var? (cihaz ekleme yüksekliği için)
  const emptyRunFrom = (startIdx: number): number => {
    let n = 0
    for (let i = startIdx; i < totalU; i++) {
      if (slots[i].kind === 'empty') n++; else break
    }
    return n
  }

  const UH = 18 // bir U için baz yükseklik (px) — okunaklılık için 14→18

  return (
    <div className="nm-rack-frame" style={{ paddingLeft: 36, flexDirection: 'column', minHeight: 0 }}>
      {slots.map((slot, idx) => {
        const u = idx + 1
        if (slot.kind === 'continuation') return null
        if (slot.kind === 'empty') {
          const maxH = emptyRunFrom(idx)
          return (
            <div key={u} className="nm-rack-u empty" title={`U${u} — boş (tıkla → cihaz yerleştir)`}
              onClick={() => onClickEmpty(u, maxH)} style={{ height: UH }}>
              <span className="u-num">U{u}</span>
              <span style={{ fontSize: 10, color: 'var(--fg-3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <PlusOutlined style={{ fontSize: 9 }} /> ekle
              </span>
            </div>
          )
        }
        if (slot.kind === 'item') {
          const h = slot.item.unit_height || 1
          return (
            <div key={u} className="nm-rack-u dev" style={{ height: UH * h + (h - 1) }}
              title={`${slot.item.label} · ${h}U · ${slot.item.item_type}`}>
              <span className="u-num">U{u}</span>
              <span className="vbar" style={{ background: 'var(--info)' }}></span>
              <span style={{ marginLeft: 8, marginRight: 'auto' }}>{slot.item.label}</span>
              <span className="mono" style={{ fontSize: 9.5, color: 'var(--fg-3)' }}>{h}U · {slot.item.item_type}</span>
            </div>
          )
        }
        const d = slot.dev
        const st = STATUS_OF(d)
        const h = d.rack_height || 1
        const isActive = selectedDeviceId === d.id
        return (
          <div key={u} className={`nm-rack-u dev status-${st}${isActive ? ' active' : ''}`}
            style={{ height: UH * h + (h - 1) }}
            onClick={() => onSelectDevice(d.id)}
            title={`${d.hostname} · ${d.ip_address} · ${h}U`}>
            <span className="u-num">U{u}</span>
            <span className="vbar"></span>
            <span style={{ marginLeft: 8, marginRight: 'auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.hostname}</span>
            <span className="mono" style={{ fontSize: 9.5, color: 'var(--fg-3)', marginRight: 8 }}>{h}U · {d.vendor || '—'}</span>
            <span className="leds">
              {Array(4).fill(null).map((_, i) => {
                const c = st === 'offline' ? 'offline'
                  : st === 'crit' && i === 0 ? 'crit'
                  : st === 'warn' && i === 0 ? 'warn'
                  : i < 3 ? 'ok' : ''
                return <span key={i} className={`led ${c}`}></span>
              })}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Device list tab ───────────────────────────────────────────────────────
function DeviceList({ detail, selectedDeviceId, onSelect, onRemove }:
  { detail: RackDetail; selectedDeviceId: number | null; onSelect: (id: number) => void; onRemove: (id: number) => void }) {
  // U numarası küçükten büyüğe (U1 üstte konvansiyonuna uyumlu).
  const devs = [...detail.devices].sort((a, b) => a.rack_unit - b.rack_unit)
  return (
    <>
      <div className="nm-drawer-section-hd" style={{ padding: '8px 0 12px' }}>Cihaz Listesi · {devs.length}</div>
      {devs.length === 0 ? (
        <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--fg-3)', fontSize: 12, border: '1px dashed var(--line)', borderRadius: 8 }}>
          Bu kabinde henüz cihaz yok. Sol taraftaki boş U'lardan birine tıkla → cihaz yerleştir.
        </div>
      ) : (
        <table className="nm-table">
          <thead><tr><th>U</th><th>Cihaz</th><th>Vendor</th><th>Tür</th><th>IP</th><th>Durum</th><th></th></tr></thead>
          <tbody>
            {devs.map((d) => {
              const st = STATUS_OF(d)
              const sel = selectedDeviceId === d.id
              return (
                <tr key={d.id} className={sel ? 'selected' : ''} style={{ cursor: 'pointer' }}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('button')) return
                    onSelect(d.id)
                  }}>
                  <td className="mono">U{d.rack_unit}<small style={{ color: 'var(--fg-3)' }}> · {d.rack_height}U</small></td>
                  <td>
                    <div className="nm-host">{d.hostname}</div>
                    {d.model && <div className="nm-host-ip">{d.model}</div>}
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>{d.vendor || '—'}</td>
                  <td><span className="nm-pill">{d.device_type || '—'}</span></td>
                  <td className="mono" style={{ fontSize: 11 }}>{d.ip_address}</td>
                  <td>
                    <span className={`nm-pill ${st === 'ok' ? 'ok' : st === 'warn' ? 'warn' : st === 'crit' ? 'crit' : ''}`}>{st}</span>
                  </td>
                  <td>
                    <Popconfirm title="Yerleşimi kaldır?" description="Cihaz silinmez — sadece rack yerleşimi temizlenir."
                      okText="Çıkar" cancelText="İptal" okButtonProps={{ danger: true }}
                      onConfirm={() => onRemove(d.id)}>
                      <button className="nm-btn ghost" style={{ height: 24, fontSize: 11 }} title="Kabinden çıkar"
                        onClick={(e) => e.stopPropagation()}>
                        <DeleteOutlined />
                      </button>
                    </Popconfirm>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </>
  )
}

// ── Items tab (PDU / UPS / patch panel / ...) ──────────────────────────────
function ItemList({ detail, onRemove }: { detail: RackDetail; onRemove: (itemId: number) => void }) {
  const items = [...detail.items].sort((a, b) => b.unit_start - a.unit_start)
  return (
    <>
      <div className="nm-drawer-section-hd" style={{ padding: '8px 0 12px' }}>
        Rack Items · {items.length}
        <span style={{ color: 'var(--fg-3)', fontWeight: 400, fontSize: 11, marginLeft: 8 }}>(PDU · UPS · patch panel · fan · KVM · blank · shelf)</span>
      </div>
      {items.length === 0 ? (
        <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--fg-3)', fontSize: 12, border: '1px dashed var(--line)', borderRadius: 8 }}>
          Bu kabinde henüz item yok.
        </div>
      ) : (
        <table className="nm-table">
          <thead><tr><th>U</th><th>Etiket</th><th>Tür</th><th>Not</th><th></th></tr></thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td className="mono">U{it.unit_start}<small style={{ color: 'var(--fg-3)' }}> · {it.unit_height}U</small></td>
                <td>{it.label}</td>
                <td><Tag color="blue" style={{ borderRadius: 4 }}>{it.item_type}</Tag></td>
                <td style={{ color: 'var(--fg-2)', fontSize: 12 }}>{it.notes || '—'}</td>
                <td>
                  <Popconfirm title="Item silinsin mi?" okText="Sil" cancelText="İptal" okButtonProps={{ danger: true }}
                    onConfirm={() => onRemove(it.id)}>
                    <button className="nm-btn ghost" style={{ height: 24, fontSize: 11 }}>
                      <DeleteOutlined />
                    </button>
                  </Popconfirm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

// ── Place modal (dual mode: Cihaz Yerleştir / Item Ekle) ──────────────────
// Boş U'ya tıklanınca veya "+ Cihaz / Item Ekle" butonundan açılır.
//
// Mode A — "Cihaz Yerleştir": atanmamış cihazlardan birini seç + yükseklik
//   gir → racksApi.setPlacement (yeni cihaz oluşturmaz, mevcut envanterden
//   yerleştirir).
// Mode B — "Item Ekle": PDU / UPS / patch panel gibi rack elemanları.
//   item_type bir Select — katalogdaki standart türler + bu lokasyonda daha
//   önce kullanılmış custom türler bir arada. Listede yoksa "Elle yaz" ile
//   istediğin string'i ver — backend free-form kaydeder, bir sonraki sefer
//   katalogda görürsün (RLS sayesinde başka lokasyon görmez).
const STD_ITEM_TYPES = ['pdu', 'ups', 'patch_panel', 'cable_tray', 'fan', 'shelf', 'kvm', 'blank', 'other']

function PlaceModal({
  open, onClose, rackName, u, maxHeight, knownItemTypes,
  deviceLoading, itemLoading, onPlaceDevice, onCreateItem,
}: {
  open: boolean
  onClose: () => void
  rackName: string
  u: number
  maxHeight: number
  knownItemTypes: string[]
  deviceLoading: boolean
  itemLoading: boolean
  onPlaceDevice: (deviceId: number, height: number) => void
  onCreateItem: (vars: { label: string; item_type: string; height: number; notes?: string }) => void
}) {
  const { data: unassigned = [], isLoading: unLoading } = useQuery({
    queryKey: ['rack-unassigned'],
    queryFn: () => racksApi.unassigned(),
    enabled: open,
  })

  const [mode, setMode] = useState<'device' | 'item'>('device')
  // Mode A
  const [deviceId, setDeviceId] = useState<number | undefined>(undefined)
  const [devHeight, setDevHeight] = useState<number>(1)
  // Mode B
  const [itemLabel, setItemLabel] = useState('')
  const [itemTypeMode, setItemTypeMode] = useState<'select' | 'custom'>('select')
  const [itemTypeSel, setItemTypeSel] = useState<string | undefined>(undefined)
  const [itemTypeCustom, setItemTypeCustom] = useState('')
  const [itemHeight, setItemHeight] = useState<number>(1)
  const [itemNotes, setItemNotes] = useState('')

  // Standart türler + bu lokasyondaki daha önce kullanılmış custom türler.
  const typeOptions = useMemo(() => {
    const all = new Set<string>([...STD_ITEM_TYPES, ...knownItemTypes])
    return Array.from(all).sort()
  }, [knownItemTypes])

  const submit = () => {
    if (mode === 'device') {
      if (deviceId != null) onPlaceDevice(deviceId, Math.max(1, Math.min(maxHeight, devHeight)))
      return
    }
    const t = (itemTypeMode === 'custom' ? itemTypeCustom : itemTypeSel || '').trim()
    if (!itemLabel.trim() || !t) return
    onCreateItem({
      label: itemLabel.trim(), item_type: t,
      height: Math.max(1, Math.min(maxHeight, itemHeight)),
      notes: itemNotes.trim() || undefined,
    })
  }
  const okDisabled = mode === 'device'
    ? deviceId == null
    : (!itemLabel.trim() || !(itemTypeMode === 'custom' ? itemTypeCustom.trim() : itemTypeSel))

  return (
    <Modal open={open} onCancel={onClose} onOk={submit}
      okText={mode === 'device' ? 'Yerleştir' : 'Ekle'} cancelText="İptal"
      title={`${rackName} · U${u} — Ekle`}
      confirmLoading={mode === 'device' ? deviceLoading : itemLoading}
      okButtonProps={{ disabled: okDisabled }}
      afterClose={() => {
        setMode('device'); setDeviceId(undefined); setDevHeight(1)
        setItemLabel(''); setItemTypeMode('select'); setItemTypeSel(undefined)
        setItemTypeCustom(''); setItemHeight(1); setItemNotes('')
      }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className={`nm-btn ${mode === 'device' ? 'primary' : 'ghost'}`} style={{ flex: 1, height: 30 }}
            onClick={() => setMode('device')}>Cihaz Yerleştir</button>
          <button className={`nm-btn ${mode === 'item' ? 'primary' : 'ghost'}`} style={{ flex: 1, height: 30 }}
            onClick={() => setMode('item')}>Item Ekle (PDU / UPS / patch / …)</button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
          U{u} için max <strong style={{ color: 'var(--fg-2)' }}>{maxHeight}U</strong> ardışık boşluk var.
        </div>

        {mode === 'device' ? (
          <>
            <div>
              <div style={{ fontSize: 11, color: 'var(--fg-2)', marginBottom: 4 }}>Cihaz</div>
              <Select<number> showSearch placeholder={unLoading ? 'Yükleniyor…' : 'Atanmamış cihazlardan seç…'}
                value={deviceId} onChange={setDeviceId} loading={unLoading} style={{ width: '100%' }}
                options={unassigned.map((d) => ({
                  value: d.id,
                  label: `${d.hostname} — ${d.ip_address}${d.vendor ? ' · ' + d.vendor : ''}${d.model ? ' · ' + d.model : ''}`,
                }))}
                filterOption={(input, opt) => (opt?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())}
                notFoundContent={unLoading ? 'Yükleniyor…' : 'Atanmamış cihaz bulunamadı'} />
              <div style={{ fontSize: 10.5, color: 'var(--fg-3)', marginTop: 4 }}>
                Yerleştirilecek cihaz, "Cihazlar" sayfasında mevcut ama henüz hiçbir kabine atanmamış olmalı
                ({unassigned.length} aday).
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--fg-2)', minWidth: 70 }}>Yükseklik</span>
              <InputNumber min={1} max={maxHeight} value={devHeight}
                onChange={(v) => setDevHeight(typeof v === 'number' ? v : 1)} style={{ width: 100 }} />
              <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>U (1–{maxHeight})</span>
            </div>
          </>
        ) : (
          <>
            <div>
              <div style={{ fontSize: 11, color: 'var(--fg-2)', marginBottom: 4 }}>Etiket</div>
              <Input placeholder='örn. "PDU-A1-Sol" / "Patch Panel 48p"'
                value={itemLabel} onChange={(e) => setItemLabel(e.target.value)} autoFocus />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--fg-2)' }}>Tür</span>
                <button className={`nm-btn ${itemTypeMode === 'select' ? 'primary' : 'ghost'}`}
                  style={{ height: 22, fontSize: 10.5, padding: '0 8px' }}
                  onClick={() => setItemTypeMode('select')}>Listeden seç</button>
                <button className={`nm-btn ${itemTypeMode === 'custom' ? 'primary' : 'ghost'}`}
                  style={{ height: 22, fontSize: 10.5, padding: '0 8px' }}
                  onClick={() => setItemTypeMode('custom')}>Elle yaz</button>
              </div>
              {itemTypeMode === 'select' ? (
                <Select<string> showSearch placeholder="Tür seç (pdu / ups / patch_panel / …)"
                  value={itemTypeSel} onChange={setItemTypeSel} style={{ width: '100%' }}
                  options={typeOptions.map((t) => ({ value: t, label: t }))}
                  filterOption={(input, opt) => (opt?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())}
                  notFoundContent="Tür bulunamadı — 'Elle yaz' ile özel tür ekle" />
              ) : (
                <>
                  <Input placeholder='örn. "kumandalı-switch", "kvm-2u"'
                    value={itemTypeCustom} onChange={(e) => setItemTypeCustom(e.target.value)} />
                  <div style={{ fontSize: 10.5, color: 'var(--fg-3)', marginTop: 4 }}>
                    Eklediğin tür bu lokasyonda kayıtlı kalır, bir sonraki seferde listede çıkar.
                  </div>
                </>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--fg-2)', minWidth: 70 }}>Yükseklik</span>
              <InputNumber min={1} max={maxHeight} value={itemHeight}
                onChange={(v) => setItemHeight(typeof v === 'number' ? v : 1)} style={{ width: 100 }} />
              <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>U (1–{maxHeight})</span>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--fg-2)', marginBottom: 4 }}>Not <span style={{ color: 'var(--fg-3)' }}>(opsiyonel)</span></div>
              <Input.TextArea rows={2} placeholder="örn. seri no, watt, port sayısı…"
                value={itemNotes} onChange={(e) => setItemNotes(e.target.value)} />
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

// ── Add rack modal ────────────────────────────────────────────────────────
function AddRackModal({ open, onClose, onSubmit, loading }:
  { open: boolean; onClose: () => void; onSubmit: (v: { rack_name: string; total_u: number; description?: string }) => void; loading: boolean }) {
  const [name, setName] = useState('')
  const [totalU, setTotalU] = useState<number>(42)
  const [desc, setDesc] = useState('')
  const submit = () => {
    const n = name.trim()
    if (!n) return
    onSubmit({ rack_name: n, total_u: totalU, description: desc.trim() || undefined })
  }
  return (
    <Modal open={open} title="Yeni Kabin Ekle" onCancel={onClose} onOk={submit} okText="Oluştur" cancelText="İptal"
      confirmLoading={loading} okButtonProps={{ disabled: !name.trim() || totalU < 1 }}
      afterClose={() => { setName(''); setTotalU(42); setDesc('') }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Input placeholder="Kabin adı (örn. A1 · Core)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--fg-2)', minWidth: 70 }}>Toplam U</span>
          <InputNumber min={1} max={60} value={totalU} onChange={(v) => setTotalU(typeof v === 'number' ? v : 42)} style={{ width: 100 }} />
          <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>Standart: 42U</span>
        </div>
        <Input.TextArea placeholder="Açıklama (opsiyonel — site, konum, vb.)" value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--fg-3)', marginTop: 4 }}>
          <AppstoreOutlined /> Cihazları sonra Cihazlar sayfasından bu kabine atayabilirsin.
        </div>
      </div>
    </Modal>
  )
}
