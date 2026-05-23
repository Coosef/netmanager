// Locations — NOC redesign (T8.4 B1.2).
// Tablo yerine kart grid: lokasyon zaten "tile" doğasına en uygun veri tipi.
// Header + 6-stat real KPI + nm-grid (renk noktası + isim + şehir/ülke +
// device/user metrikleri + actions). Modal/form korundu — fonksiyonel.
import { useMemo, useState } from 'react'
import {
  App, Button, Col, ColorPicker, Form, Input, Modal, Popconfirm,
  Row, Select, Tooltip,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
  EnvironmentOutlined, LaptopOutlined, ReloadOutlined, TeamOutlined,
  ClockCircleOutlined, GlobalOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { locationsApi, type Location } from '@/api/locations'
import { useTheme } from '@/contexts/ThemeContext'
import dayjs from 'dayjs'

const DEFAULT_COLORS = [
  '#3b82f6', '#22c55e', '#f97316', '#ef4444',
  '#8b5cf6', '#06b6d4', '#eab308', '#ec4899',
]

const TZ_OPTIONS = [
  'Europe/Istanbul', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Europe/Moscow', 'Asia/Dubai', 'Asia/Riyadh', 'America/New_York',
  'America/Chicago', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Singapore',
].map((v) => ({ label: v, value: v }))

export default function LocationsPage() {
  const { message } = App.useApp()
  const { isDark } = useTheme()
  const qc = useQueryClient()

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Location | null>(null)
  const [form] = Form.useForm()
  const [colorValue, setColorValue] = useState<string>('#3b82f6')

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['locations'],
    queryFn: () => locationsApi.list(),
  })

  const createMutation = useMutation({
    mutationFn: locationsApi.create,
    onSuccess: () => {
      message.success('Lokasyon oluşturuldu')
      qc.invalidateQueries({ queryKey: ['locations'] })
      qc.invalidateQueries({ queryKey: ['device-location-options'] })
      closeModal()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Oluşturulamadı'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof locationsApi.update>[1] }) =>
      locationsApi.update(id, data),
    onSuccess: () => {
      message.success('Lokasyon güncellendi')
      qc.invalidateQueries({ queryKey: ['locations'] })
      qc.invalidateQueries({ queryKey: ['device-location-options'] })
      closeModal()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Güncellenemedi'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => locationsApi.delete(id, true),
    onSuccess: () => {
      message.success('Lokasyon silindi')
      qc.invalidateQueries({ queryKey: ['locations'] })
      qc.invalidateQueries({ queryKey: ['device-location-options'] })
    },
    onError: () => message.error('Silinemedi'),
  })

  const openCreate = () => {
    setEditing(null)
    setColorValue('#3b82f6')
    form.resetFields()
    form.setFieldValue('color', '#3b82f6')
    setModalOpen(true)
  }

  const openEdit = (loc: Location) => {
    setEditing(loc)
    const c = loc.color || '#3b82f6'
    setColorValue(c)
    form.setFieldsValue({
      name: loc.name,
      description: loc.description || '',
      address: loc.address || '',
      city: loc.city || '',
      country: loc.country || '',
      timezone: loc.timezone || undefined,
      color: c,
    })
    setModalOpen(true)
  }

  const closeModal = () => {
    setModalOpen(false)
    setEditing(null)
    form.resetFields()
  }

  const handleSubmit = async () => {
    const values = await form.validateFields()
    const payload = { ...values, color: colorValue }
    if (editing) {
      updateMutation.mutate({ id: editing.id, data: payload })
    } else {
      createMutation.mutate(payload)
    }
  }

  const items = data?.items || []

  // ── Real-data stats for the NOC stat bar ──────────────────────────────
  // BOŞ: device_count=0 (operasyonel olmayan / yeni eklenmiş lokasyon)
  // TEK CİHAZ: device_count=1 (kırılgan — yedeği yok)
  // ÜLKE: distinct country (boş olmayan), tek metrik kapsam genişliği için
  const stats = useMemo(() => {
    const totalDevices = items.reduce((s, l) => s + l.device_count, 0)
    const totalUsers = items.reduce((s, l) => s + (l.user_count || 0), 0)
    const empty = items.filter((l) => l.device_count === 0).length
    const single = items.filter((l) => l.device_count === 1).length
    const countries = new Set(items.map((l) => l.country).filter(Boolean)).size
    return {
      total: items.length,
      totalDevices,
      totalUsers,
      empty,
      single,
      countries,
    }
  }, [items])

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      {/* NOC header */}
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>Yönetim</span><span>Lokasyonlar</span></div>
          <h1 className="nm-page-title">
            Lokasyon Yönetimi
            <span className="nm-pill mono">{items.length} lokasyon</span>
          </h1>
          <div className="nm-page-sub">
            Şube / site tanımları · kullanıcılara lokasyon bazl&#x131; yetki ataman&#x131;n temeli · cihazlar buraya bağlanır.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Tooltip title="Yenile">
            <Button icon={<ReloadOutlined />} onClick={() => refetch()} />
          </Tooltip>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Yeni Lokasyon
          </Button>
        </div>
      </div>

      {/* NOC stat bar — 6 real KPIs */}
      <div className="nm-statbar">
        <div className="nm-stat">
          <div className="nm-stat-label">TOPLAM LOKASYON</div>
          <div className="nm-stat-val">{stats.total}</div>
          <div className="nm-stat-delta">{stats.countries || 0} ülke</div>
        </div>
        <div className="nm-stat ok">
          <div className="nm-stat-label">ATANMIŞ CİHAZ</div>
          <div className="nm-stat-val">{stats.totalDevices}</div>
          <div className="nm-stat-delta">{stats.total > 0 ? (stats.totalDevices / stats.total).toFixed(1) : '0'} / lokasyon</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">ATANMIŞ KULLANICI</div>
          <div className="nm-stat-val">{stats.totalUsers}</div>
          <div className="nm-stat-delta">lokasyon-rolleri toplamı</div>
        </div>
        <div className={`nm-stat ${stats.empty > 0 ? 'warn' : 'ok'}`}>
          <div className="nm-stat-label">BOŞ LOKASYON</div>
          <div className="nm-stat-val">{stats.empty}</div>
          <div className="nm-stat-delta">cihazı yok</div>
        </div>
        <div className={`nm-stat ${stats.single > 0 ? 'warn' : ''}`}>
          <div className="nm-stat-label">TEK CİHAZ</div>
          <div className="nm-stat-val">{stats.single}</div>
          <div className="nm-stat-delta">yedeksiz (kırılgan)</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">ÜLKE KAPSAMI</div>
          <div className="nm-stat-val">{stats.countries}</div>
          <div className="nm-stat-delta">distinct country</div>
        </div>
      </div>

      {/* Location cards grid */}
      <div className="nm-card" style={{ padding: 0 }}>
        <div className="nm-card-hd">
          <h3><EnvironmentOutlined /> Lokasyonlar</h3>
          <span className="nm-pill mono">{items.length}</span>
        </div>
        <div style={{ padding: 12 }}>
          {isLoading && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--fg-3)' }}>Yükleniyor…</div>
          )}
          {!isLoading && items.length === 0 && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-3)' }}>
              <EnvironmentOutlined style={{ fontSize: 32, opacity: 0.4, display: 'block', margin: '0 auto 8px' }} />
              Henüz lokasyon eklenmemiş — "Yeni Lokasyon" butonunu kullan&#x131;n
            </div>
          )}
          {!isLoading && items.length > 0 && (
            <div className="nm-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
              {items.map((loc) => (
                <LocationCard
                  key={loc.id}
                  loc={loc}
                  onEdit={openEdit}
                  onDelete={(id) => deleteMutation.mutate(id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Create/Edit Modal — kept functional with antd */}
      <Modal
        title={editing ? 'Lokasyon Düzenle' : 'Yeni Lokasyon'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={closeModal}
        okText={editing ? 'Güncelle' : 'Oluştur'}
        cancelText="İptal"
        confirmLoading={createMutation.isPending || updateMutation.isPending}
        width={520}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            label="Lokasyon Adı"
            name="name"
            rules={[{ required: true, message: 'Lokasyon adı zorunlu' }]}
          >
            <Input placeholder="örn. Merkez Ofis, İstanbul DC, Şube-1" />
          </Form.Item>

          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label="Şehir" name="city">
                <Input placeholder="İstanbul" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="Ülke" name="country">
                <Input placeholder="Türkiye" />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item label="Zaman Dilimi" name="timezone">
            <Select
              options={TZ_OPTIONS}
              allowClear
              showSearch
              placeholder="Europe/Istanbul"
              filterOption={(input, option) =>
                (option?.label as string)?.toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>

          <Form.Item label="Renk" style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {DEFAULT_COLORS.map((c) => (
                <div
                  key={c}
                  onClick={() => setColorValue(c)}
                  style={{
                    width: 28, height: 28, borderRadius: 6,
                    background: c, cursor: 'pointer',
                    border: colorValue === c ? '3px solid #fff' : '3px solid transparent',
                    boxShadow: colorValue === c ? `0 0 0 2px ${c}` : undefined,
                    transition: 'all 0.15s',
                  }}
                />
              ))}
              <ColorPicker value={colorValue} onChange={(_, hex) => setColorValue(hex)} size="small" />
            </div>
          </Form.Item>

          <Form.Item label="Açıklama" name="description">
            <Input.TextArea rows={2} placeholder="İsteğe bağlı açıklama" />
          </Form.Item>

          <Form.Item label="Adres" name="address">
            <Input placeholder="örn. Maslak, İstanbul" />
          </Form.Item>
        </Form>

        {editing && editing.device_count > 0 && (
          <div style={{
            background: isDark ? '#0c2040' : '#eff6ff',
            border: `1px solid ${isDark ? '#1a3458' : '#bfdbfe'}`,
            borderRadius: 6, padding: '8px 12px', marginTop: 8,
            fontSize: 12, color: isDark ? '#94a3b8' : '#475569',
          }}>
            <LaptopOutlined style={{ marginRight: 6 }} />
            Bu lokasyona <strong>{editing.device_count}</strong> cihaz atanmış.
            İsim değiştirilirse cihazların site alanı otomatik güncellenir.
          </div>
        )}
      </Modal>
    </div>
  )
}

function LocationCard({
  loc, onEdit, onDelete,
}: { loc: Location; onEdit: (l: Location) => void; onDelete: (id: number) => void }) {
  const color = loc.color || '#3b82f6'
  const status = loc.device_count === 0 ? 'empty' : loc.device_count === 1 ? 'fragile' : 'ok'

  return (
    <div className="nm-card" style={{ padding: 12, position: 'relative' }}>
      {/* Header: color dot + name + city/country */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: `${color}22`, border: `1px solid ${color}55`,
          display: 'grid', placeItems: 'center', flexShrink: 0,
        }}>
          <EnvironmentOutlined style={{ color, fontSize: 16 }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-0)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {loc.name}
          </div>
          {(loc.city || loc.country) && (
            <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              <GlobalOutlined style={{ marginRight: 4, fontSize: 10 }} />
              {[loc.city, loc.country].filter(Boolean).join(', ')}
            </div>
          )}
        </div>
        {/* Status pill */}
        {status === 'empty' && (
          <span className="nm-pill" style={{ color: 'var(--warn)', borderColor: 'var(--warn)', fontSize: 9.5 }}>BOŞ</span>
        )}
        {status === 'fragile' && (
          <span className="nm-pill" style={{ color: 'var(--warn)', borderColor: 'var(--warn)', fontSize: 9.5 }}>YEDEKSİZ</span>
        )}
      </div>

      {/* Address line (optional) */}
      {loc.address && (
        <div style={{
          fontSize: 11, color: 'var(--fg-3)', marginBottom: 10,
          padding: '6px 8px', background: 'var(--bg-2)', borderRadius: 4,
          borderLeft: `2px solid ${color}`,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {loc.address}
        </div>
      )}

      {/* Metrics row */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8,
        padding: '8px 0', borderTop: '1px solid var(--border-0)',
        borderBottom: '1px solid var(--border-0)', marginBottom: 10,
      }}>
        <Metric icon={<LaptopOutlined />} label="CİHAZ" value={loc.device_count}
          color={loc.device_count === 0 ? 'var(--fg-3)' : loc.device_count === 1 ? 'var(--warn)' : 'var(--accent)'} />
        <Metric icon={<TeamOutlined />} label="KULLANICI" value={loc.user_count || 0}
          color={(loc.user_count || 0) === 0 ? 'var(--fg-3)' : 'var(--ok)'} />
        <Metric icon={<ClockCircleOutlined />} label="ZAMAN DİLİMİ"
          value={loc.timezone ? loc.timezone.split('/').pop() || '—' : '—'}
          color="var(--fg-2)" small />
      </div>

      {/* Footer: created + actions */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 10.5, color: 'var(--fg-3)' }} className="mono">
          {dayjs(loc.created_at).format('DD.MM.YYYY')}
        </span>
        <span className="nm-rowact" onClick={(e) => e.stopPropagation()}>
          <Tooltip title="Düzenle">
            <button onClick={() => onEdit(loc)}><EditOutlined /></button>
          </Tooltip>
          <Popconfirm
            title="Lokasyonu sil"
            description={loc.device_count > 0
              ? `${loc.device_count} cihazın site alanı temizlenecek. Emin misiniz?`
              : 'Bu lokasyonu silmek istediğinize emin misiniz?'}
            okText="Sil"
            cancelText="İptal"
            okButtonProps={{ danger: true }}
            onConfirm={() => onDelete(loc.id)}
          >
            <button><DeleteOutlined style={{ color: 'var(--crit)' }} /></button>
          </Popconfirm>
        </span>
      </div>
    </div>
  )
}

function Metric({
  icon, label, value, color, small,
}: {
  icon: React.ReactNode
  label: string
  value: string | number
  color: string
  small?: boolean
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
      <span style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: 0.4 }}>{label}</span>
      <span style={{
        fontSize: small ? 11 : 16, fontWeight: small ? 400 : 600, color,
        marginTop: 2,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%',
      }} className={small ? 'mono' : ''}>
        <span style={{ marginRight: 4, opacity: 0.7 }}>{icon}</span>{value}
      </span>
    </div>
  )
}
