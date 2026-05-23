// NocServices — T8.4 NOC design Servisler page (mockup pages-rest.jsx
// ServicesPage). Mockup chrome: nm-page-hd + 6-stat nm-statbar + service
// card grid (priority pill / status dot / 3-stat ETKİ-CİHAZ-SAĞLIKLI) +
// detail drawer (Açıklama / Bağımlı Cihazlar / Etki Detayı). Tüm CRUD
// gerçek servicesApi'ya bağlı; per-servis etki paralel useQueries ile.
//
// Mockup'taki "SLA Trend · 30g" backend'de henüz computed değil (per-service
// SLA hesabı için ayrı bir job lazım — mevcut sla_policy/sla servisi farklı
// model). SLA görsel olarak EKLENMEDİ; bunun yerine "Sağlıklı Cihaz"
// (impact.healthy_count) gösteriliyor — bu gerçek veri.
import { useMemo, useState } from 'react'
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query'
import { App, Drawer, Form, Input, Select, Transfer, Popconfirm } from 'antd'
import { PlusOutlined, DeleteOutlined, EditOutlined, AppstoreOutlined } from '@ant-design/icons'
import { servicesApi, type Service, type ServiceImpact } from '@/api/services'
import { devicesApi } from '@/api/devices'

const PRIORITY_TO_TIER = (p: string): 'P0' | 'P1' | 'P2' | 'P3' => {
  switch (p) {
    case 'critical': return 'P0'
    case 'high':     return 'P1'
    case 'medium':   return 'P2'
    default:         return 'P3'
  }
}
const TIER_LABEL: Record<string, string> = {
  critical: 'Kritik', high: 'Yüksek', medium: 'Orta', low: 'Düşük',
}

// Status: getImpact'tan türetiliyor (impact_pct).
type Status = 'ok' | 'warn' | 'crit' | 'unknown'
const STATUS_OF = (imp?: ServiceImpact): Status => {
  if (!imp) return 'unknown'
  if (imp.impact_pct >= 50) return 'crit'
  if (imp.impact_pct > 0) return 'warn'
  return 'ok'
}

export default function NocServices() {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const [active, setActive] = useState<Service | null>(null)   // detay drawer
  const [editing, setEditing] = useState<Service | null>(null) // create/edit drawer
  const [createOpen, setCreateOpen] = useState(false)
  const [form] = Form.useForm()
  const [targetKeys, setTargetKeys] = useState<string[]>([])

  const { data: servicesResp, isLoading } = useQuery({
    queryKey: ['services'], queryFn: servicesApi.list, refetchInterval: 60000,
  })
  const services = servicesResp?.items || []
  const { data: devicesData } = useQuery({
    queryKey: ['devices-for-services'], queryFn: () => devicesApi.list({ limit: 1000 }),
  })

  // Per-servis impact paralel — card'ların durum/etki tile'ı için gerçek veri.
  const impactQueries = useQueries({
    queries: services.map((s) => ({
      queryKey: ['service-impact', s.id],
      queryFn: () => servicesApi.getImpact(s.id),
      refetchInterval: 60000,
    })),
  })
  const impactById = useMemo(() => {
    const m: Record<number, ServiceImpact> = {}
    services.forEach((s, i) => {
      const d = impactQueries[i]?.data
      if (d) m[s.id] = d
    })
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, impactQueries.map((q) => q.dataUpdatedAt).join(',')])

  // ── stats ────────────────────────────────────────────────────────────────
  const total = services.length
  let okCount = 0, warnCount = 0, critCount = 0
  services.forEach((s) => {
    const st = STATUS_OF(impactById[s.id])
    if (st === 'ok') okCount++
    else if (st === 'warn') warnCount++
    else if (st === 'crit') critCount++
  })
  const p0Count = services.filter((s) => s.priority === 'critical' || s.priority === 'high').length
  const totalDevices = services.reduce((a, s) => a + (s.device_ids?.length || 0), 0)
  const avgImpact = total > 0
    ? Math.round(services.reduce((a, s) => a + (impactById[s.id]?.impact_pct ?? 0), 0) / total)
    : 0

  // ── mutations ────────────────────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: servicesApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['services'] })
      message.success('Servis oluşturuldu'); closeForm()
    },
    onError: (e) => message.error((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Oluşturulamadı'),
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof servicesApi.update>[1] }) => servicesApi.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['services'] })
      message.success('Servis güncellendi'); closeForm()
    },
    onError: (e) => message.error((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Güncellenemedi'),
  })
  const deleteMut = useMutation({
    mutationFn: servicesApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['services'] })
      message.success('Servis silindi')
      setActive(null)
    },
    onError: (e) => message.error((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Silinemedi'),
  })

  const openCreate = () => {
    setEditing(null); form.resetFields(); setTargetKeys([])
    setCreateOpen(true)
  }
  const openEdit = (svc: Service) => {
    setEditing(svc)
    setTargetKeys((svc.device_ids || []).map(String))
    form.setFieldsValue({
      name: svc.name,
      description: svc.description,
      priority: svc.priority || 'medium',
      business_owner: svc.business_owner,
      vlan_ids: (svc.vlan_ids || []).join(', '),
    })
    setCreateOpen(true)
  }
  const closeForm = () => { setCreateOpen(false); setEditing(null) }
  const submitForm = () => {
    form.validateFields().then((v) => {
      const payload = {
        name: v.name,
        description: v.description || undefined,
        priority: v.priority || 'medium',
        business_owner: v.business_owner || undefined,
        device_ids: targetKeys.map(Number),
        vlan_ids: v.vlan_ids ? v.vlan_ids.split(',').map((x: string) => parseInt(x.trim())).filter((n: number) => !isNaN(n)) : [],
      }
      if (editing) updateMut.mutate({ id: editing.id, data: payload })
      else createMut.mutate(payload)
    }).catch(() => {})
  }

  const allDevices = devicesData?.items || []
  const transferSource = allDevices.map((d) => ({ key: String(d.id), title: d.hostname, description: d.ip_address }))

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>Envanter</span><span>Servisler</span></div>
          <h1 className="nm-page-title">
            İş Servisleri
            <span className="nm-pill mono">{total} servis</span>
            {critCount > 0 && <span className="nm-pill crit">{critCount} kesinti</span>}
          </h1>
          <div className="nm-page-sub">Servis-cihaz eşlemeleri · iş etkisi analizi (gerçek-zamanlı, devicelar üzerinden) · sorumlu atama.</div>
        </div>
        <div className="nm-page-actions">
          <button className="nm-btn primary" onClick={openCreate}><PlusOutlined /> Servis Tanımla</button>
        </div>
      </div>

      <div className="nm-statbar">
        <div className="nm-stat ok"><div className="nm-stat-label">Stabil</div><div className="nm-stat-val">{okCount}<small>/ {total}</small></div></div>
        <div className="nm-stat crit"><div className="nm-stat-label">Kesinti</div><div className="nm-stat-val">{critCount}</div></div>
        <div className="nm-stat warn"><div className="nm-stat-label">Bozulmuş</div><div className="nm-stat-val">{warnCount}</div></div>
        <div className="nm-stat"><div className="nm-stat-label">Kritik · Yüksek</div><div className="nm-stat-val">{p0Count}</div><div className="nm-stat-delta">P0 · P1</div></div>
        <div className="nm-stat"><div className="nm-stat-label">Toplam Cihaz</div><div className="nm-stat-val">{totalDevices}</div></div>
        <div className="nm-stat"><div className="nm-stat-label">Ort. Etki</div><div className="nm-stat-val">{avgImpact}<small>%</small></div></div>
      </div>

      {isLoading ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--fg-3)' }}>Yükleniyor…</div>
      ) : services.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--fg-3)' }}>
          <AppstoreOutlined style={{ fontSize: 28, opacity: 0.4 }} />
          <div style={{ marginTop: 10 }}>Henüz servis tanımlanmamış —
            <button className="nm-btn ghost" style={{ height: 24, fontSize: 11, padding: '0 10px', marginLeft: 6 }}
              onClick={openCreate}>+ Servis Tanımla</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 14 }}>
          {services.map((s) => (
            <ServiceCard key={s.id} svc={s} impact={impactById[s.id]} onClick={() => setActive(s)} />
          ))}
        </div>
      )}

      <ServiceDetailDrawer
        service={active}
        impact={active ? impactById[active.id] : undefined}
        onClose={() => setActive(null)}
        onEdit={(s) => { setActive(null); openEdit(s) }}
        onDelete={(id) => deleteMut.mutate(id)}
      />

      {/* Create / Edit drawer */}
      <Drawer
        open={createOpen} onClose={closeForm}
        title={editing ? `${editing.name} — Düzenle` : 'Yeni Servis Tanımla'}
        width={620} destroyOnClose
        footer={
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button className="nm-btn ghost" onClick={closeForm}>İptal</button>
            <button className="nm-btn primary" onClick={submitForm}>{editing ? 'Kaydet' : 'Oluştur'}</button>
          </div>
        }>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Servis Adı" rules={[{ required: true, message: 'Servis adı gerekli' }]}>
            <Input placeholder='örn. "ERP — SAP"' autoFocus />
          </Form.Item>
          <Form.Item name="description" label="Açıklama">
            <Input.TextArea rows={2} placeholder="Bu servisin iş kapsamı, kullanıcı sayısı, vb." />
          </Form.Item>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="priority" label="Öncelik" style={{ flex: 1 }} initialValue="medium">
              <Select options={[
                { value: 'critical', label: 'Kritik (P0)' },
                { value: 'high',     label: 'Yüksek (P1)' },
                { value: 'medium',   label: 'Orta (P2)' },
                { value: 'low',      label: 'Düşük (P3)' },
              ]} />
            </Form.Item>
            <Form.Item name="business_owner" label="Sahibi" style={{ flex: 1 }}>
              <Input placeholder='örn. "Finans", "Operasyon"' />
            </Form.Item>
          </div>
          <Form.Item name="vlan_ids" label="VLAN ID'leri" tooltip="virgülle ayır">
            <Input placeholder="örn. 10, 20, 30" />
          </Form.Item>
          <Form.Item label="Bağımlı Cihazlar">
            <Transfer
              dataSource={transferSource}
              targetKeys={targetKeys}
              onChange={(keys) => setTargetKeys(keys as string[])}
              render={(it) => `${it.title} (${it.description})`}
              listStyle={{ width: 250, height: 280 }}
              titles={['Tüm Cihazlar', 'Bu Servise Bağlı']}
              showSearch filterOption={(input, item) =>
                (item.title || '').toLowerCase().includes(input.toLowerCase()) ||
                (item.description || '').toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  )
}

// ── Service card (mockup) ────────────────────────────────────────────────
function ServiceCard({ svc, impact, onClick }:
  { svc: Service; impact?: ServiceImpact; onClick: () => void }) {
  const tier = PRIORITY_TO_TIER(svc.priority || 'medium')
  const st = STATUS_OF(impact)
  const imp = impact?.impact_pct ?? 0
  const devCount = svc.device_ids?.length ?? 0
  const healthy = impact?.healthy_count ?? Math.max(0, devCount - (impact?.affected_count ?? 0))
  const tierCls =
    tier === 'P0' ? 'crit' :
    tier === 'P1' ? 'warn' :
    tier === 'P2' ? '' : ''
  return (
    <div className="nm-card" onClick={onClick} style={{ cursor: 'pointer' }}>
      <div style={{ padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
          <span className={`nm-pill mono ${tierCls}`} style={{ fontWeight: 600 }}>{tier}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 3, color: 'var(--fg-0)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {svc.name}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Sahibi · <span style={{ color: 'var(--fg-1)' }}>{svc.business_owner || '—'}</span>
            </div>
          </div>
          <span className={`nm-status-dot ${st === 'unknown' ? '' : st}`}></span>
        </div>
        {svc.description && (
          <div style={{
            fontSize: 12.5, color: 'var(--fg-2)', marginBottom: 14, lineHeight: 1.5,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            overflow: 'hidden', minHeight: 36,
          }}>{svc.description}</div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
          <CardStat label="ETKİ" value={`${Math.round(imp)}`} unit="%"
            color={imp > 50 ? 'var(--crit)' : imp > 0 ? 'var(--warn)' : 'var(--ok)'} />
          <CardStat label="CİHAZ" value={devCount} />
          <CardStat label="SAĞLIKLI" value={healthy} unit={devCount > 0 ? `/${devCount}` : undefined}
            color={healthy === devCount && devCount > 0 ? 'var(--ok)' : undefined} />
        </div>
      </div>
    </div>
  )
}

function CardStat({ label, value, unit, color }: { label: string; value: string | number; unit?: string; color?: string }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-3)', textTransform: 'uppercase' }}>{label}</div>
      <div className="mono" style={{ fontSize: 18, fontWeight: 500, marginTop: 2, color: color || 'var(--fg-0)' }}>
        {value}{unit && <small style={{ fontSize: 10, color: 'var(--fg-3)' }}>{unit}</small>}
      </div>
    </div>
  )
}

// ── Detail drawer ─────────────────────────────────────────────────────────
function ServiceDetailDrawer({ service, impact, onClose, onEdit, onDelete }: {
  service: Service | null
  impact?: ServiceImpact
  onClose: () => void
  onEdit: (s: Service) => void
  onDelete: (id: number) => void
}) {
  if (!service) return null
  const tier = PRIORITY_TO_TIER(service.priority || 'medium')
  const st = STATUS_OF(impact)
  const stLabel = st === 'ok' ? 'Stabil' : st === 'warn' ? 'Bozulmuş' : st === 'crit' ? 'Kesinti' : 'Bilinmiyor'
  const affected = impact?.affected_devices || []
  const healthy = impact?.healthy_devices || []
  const allDevs = [...affected.map((d) => ({ ...d, _ok: false })), ...healthy.map((d) => ({ ...d, _ok: true }))]
  return (
    <Drawer open onClose={onClose} title={null} width={560} closable={false} styles={{ body: { padding: 0 } }}>
      <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500 }}>{service.name}</h2>
            <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 3 }}>
              {tier} · {TIER_LABEL[service.priority] || service.priority || '—'} · Sahibi {service.business_owner || '—'}
            </div>
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className={`nm-status-dot ${st === 'unknown' ? '' : st}`}></span>
              <span style={{ fontSize: 12.5 }}>{stLabel}</span>
              {impact && impact.impact_pct > 0 && (
                <span className="nm-pill crit" style={{ marginLeft: 4 }}>{Math.round(impact.impact_pct)}% etki</span>
              )}
              <span className="nm-pill mono" style={{ fontSize: 9.5 }}>{service.device_ids?.length ?? 0} cihaz</span>
              {(service.vlan_ids?.length ?? 0) > 0 && (
                <span className="nm-pill mono" style={{ fontSize: 9.5 }}>{service.vlan_ids.length} VLAN</span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button className="nm-btn ghost" style={{ height: 26, fontSize: 11 }} onClick={() => onEdit(service)}>
              <EditOutlined /> Düzenle
            </button>
            <Popconfirm title="Servis silinsin mi?" description="Servis-cihaz eşlemeleri kaldırılır (cihazlar etkilenmez)."
              okText="Sil" cancelText="İptal" okButtonProps={{ danger: true }}
              onConfirm={() => onDelete(service.id)}>
              <button className="nm-btn ghost" style={{ height: 26, fontSize: 11, color: 'var(--crit)' }}><DeleteOutlined /> Sil</button>
            </Popconfirm>
          </div>
        </div>
      </div>

      <div style={{ padding: '18px 22px' }}>
        {service.description && (
          <div style={{ marginBottom: 18 }}>
            <div className="nm-drawer-section-hd">Açıklama</div>
            <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fg-1)' }}>{service.description}</div>
          </div>
        )}

        <div style={{ marginBottom: 18 }}>
          <div className="nm-drawer-section-hd">Etki Detayı</div>
          {impact ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginTop: 6 }}>
              <Stat label="Etkilenen" value={impact.affected_count} color="var(--crit)" />
              <Stat label="Sağlıklı" value={impact.healthy_count} color="var(--ok)" />
              <Stat label="Etki Düzeyi" value={impact.impact_level.toUpperCase()}
                color={impact.impact_level === 'critical' ? 'var(--crit)' : impact.impact_level === 'high' ? 'var(--warn)' : 'var(--fg-1)'} />
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>Etki bilgisi yükleniyor…</div>
          )}
        </div>

        <div>
          <div className="nm-drawer-section-hd">Bağımlı Cihazlar · {allDevs.length}</div>
          {allDevs.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--fg-3)', padding: '12px 0' }}>Henüz cihaz bağlanmamış.</div>
          ) : (
            <table className="nm-table" style={{ marginTop: 6 }}>
              <thead><tr><th>Cihaz</th><th>IP</th><th>Durum</th></tr></thead>
              <tbody>
                {allDevs.map((d) => (
                  <tr key={d.id}>
                    <td><div className="nm-host">{d.hostname}</div></td>
                    <td className="mono" style={{ fontSize: 11 }}>{d.ip_address}</td>
                    <td><span className={`nm-pill ${d._ok ? 'ok' : 'crit'}`}>{d.status || (d._ok ? 'online' : 'offline')}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Drawer>
  )
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--line-soft)', borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-3)', textTransform: 'uppercase' }}>{label}</div>
      <div className="mono" style={{ fontSize: 16, fontWeight: 500, marginTop: 3, color: color || 'var(--fg-0)' }}>{value}</div>
    </div>
  )
}
