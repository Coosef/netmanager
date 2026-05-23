// CustomizePanel v2 — Phase 2 zenginleştirilmiş özelleştirme paneli.
// Mockup'a uyumlu: GÖRÜNÜM (Workspace/Mission/Editorial thumbnails) +
// HAZIR LAYOUT'LAR (Operatör/Network Admin/Yönetici/NOC Duvarı) +
// KAYITLI LAYOUT'LAR (named, kullanıcı kaydedebilir) + MEVCUT DÜZENİ
// KAYDET input + TEMA + YOĞUNLUK + AKSAN RENGİ + MENÜ POZİSYONU +
// DÜZENLEME modu toggle + SESLİ ALARM + NOC DUVAR MODU + Varsayılana Sıfırla.
import { useState } from 'react'
import { Drawer, ColorPicker, Switch, Input, Popconfirm } from 'antd'
import {
  SunOutlined, MoonOutlined, MenuOutlined, BgColorsOutlined, ReloadOutlined,
  SoundOutlined, MonitorOutlined, StopOutlined, AppstoreOutlined, EditOutlined,
  SaveOutlined, DeleteOutlined, CheckOutlined,
} from '@ant-design/icons'
import { useTheme } from '@/contexts/ThemeContext'
import {
  useCustomize, ACCENT_PRESETS, PRESET_LAYOUTS,
  type Density, type MenuPosition, type ViewVariant,
} from '@/contexts/CustomizeContext'
import { useNocWall } from '@/contexts/NocWallContext'

interface Props { open: boolean; onClose: () => void }

export default function CustomizePanel({ open, onClose }: Props) {
  const { isDark, toggle } = useTheme()
  const {
    density, setDensity, menuPosition, setMenuPosition, accent, setAccent,
    viewVariant, setViewVariant, soundEnabled, setSoundEnabled,
    editMode, setEditMode, savedLayouts, saveLayout, applyLayout, deleteLayout, reset,
  } = useCustomize()
  const wall = useNocWall()
  const [layoutName, setLayoutName] = useState('')

  const DENSITIES: { id: Density; label: string; sub: string }[] = [
    { id: 'compact',  label: 'Sıkı',   sub: 'Daha fazla içerik, dar boşluklar' },
    { id: 'regular',  label: 'Normal', sub: 'Dengeli — varsayılan' },
    { id: 'spacious', label: 'Geniş',  sub: 'Hava bol, daha okunaklı' },
  ]

  const VIEWS: { id: ViewVariant; label: string; sub: string; thumb: React.ReactNode }[] = [
    {
      id: 'workspace', label: 'Workspace', sub: 'modüler',
      thumb: (
        <svg viewBox="0 0 60 36" fill="none" style={{ width: '100%', height: 38 }}>
          <rect x="0" y="0" width="14" height="36" fill="currentColor" opacity="0.1" />
          <rect x="17" y="3" width="20" height="12" rx="2" stroke="currentColor" strokeWidth="0.8" />
          <rect x="40" y="3" width="17" height="12" rx="2" stroke="currentColor" strokeWidth="0.8" />
          <rect x="17" y="18" width="13" height="14" rx="2" stroke="currentColor" strokeWidth="0.8" />
          <rect x="33" y="18" width="11" height="14" rx="2" stroke="currentColor" strokeWidth="0.8" />
          <rect x="47" y="18" width="10" height="14" rx="2" stroke="currentColor" strokeWidth="0.8" />
        </svg>
      ),
    },
    {
      id: 'mission', label: 'Mission', sub: 'NOC duvarı',
      thumb: (
        <svg viewBox="0 0 60 36" fill="none" style={{ width: '100%', height: 38 }}>
          <line x1="20" y1="0" x2="20" y2="36" stroke="currentColor" strokeWidth="0.5" opacity="0.5" />
          <line x1="46" y1="0" x2="46" y2="36" stroke="currentColor" strokeWidth="0.5" opacity="0.5" />
          <text x="3" y="11" fill="currentColor" fontSize="8" fontFamily="monospace">7</text>
          <text x="3" y="22" fill="currentColor" fontSize="8" fontFamily="monospace">3</text>
          <circle cx="33" cy="16" r="1.2" fill="currentColor" />
          <circle cx="29" cy="22" r="1" fill="currentColor" />
          <circle cx="38" cy="11" r="1" fill="currentColor" />
        </svg>
      ),
    },
    {
      id: 'editorial', label: 'Editorial', sub: 'brief',
      thumb: (
        <svg viewBox="0 0 60 36" fill="none" style={{ width: '100%', height: 38 }}>
          <line x1="22" y1="3" x2="22" y2="33" stroke="currentColor" strokeWidth="0.5" opacity="0.5" />
          <line x1="42" y1="3" x2="42" y2="33" stroke="currentColor" strokeWidth="0.5" opacity="0.5" />
          <text x="4" y="20" fill="currentColor" fontSize="14" fontFamily="monospace">7</text>
          <line x1="25" y1="7" x2="40" y2="7" stroke="currentColor" strokeWidth="0.5" />
          <line x1="25" y1="11" x2="40" y2="11" stroke="currentColor" strokeWidth="0.5" />
          <line x1="25" y1="15" x2="38" y2="15" stroke="currentColor" strokeWidth="0.5" />
          <line x1="44" y1="7" x2="56" y2="7" stroke="currentColor" strokeWidth="0.5" />
          <line x1="44" y1="11" x2="56" y2="11" stroke="currentColor" strokeWidth="0.5" />
        </svg>
      ),
    },
  ]

  const MENUS: { id: MenuPosition; label: string; sub: string; thumb: React.ReactNode }[] = [
    {
      id: 'side', label: 'Sol Sidebar', sub: 'Varsayılan',
      thumb: (
        <svg viewBox="0 0 60 30" fill="none" style={{ width: '100%', height: 32 }}>
          <rect x="0" y="0" width="14" height="30" fill="currentColor" opacity="0.18" />
          <rect x="17" y="3" width="40" height="6" rx="1" fill="currentColor" opacity="0.1" />
          <rect x="17" y="13" width="40" height="14" rx="1" stroke="currentColor" strokeWidth="0.6" />
        </svg>
      ),
    },
    {
      id: 'top', label: 'Üst Bar', sub: 'Yatay',
      thumb: (
        <svg viewBox="0 0 60 30" fill="none" style={{ width: '100%', height: 32 }}>
          <rect x="0" y="0" width="60" height="6" fill="currentColor" opacity="0.18" />
          <rect x="0" y="8" width="60" height="6" rx="1" fill="currentColor" opacity="0.1" />
          <rect x="2" y="16" width="56" height="13" rx="1" stroke="currentColor" strokeWidth="0.6" />
        </svg>
      ),
    },
  ]

  return (
    <Drawer open={open} onClose={onClose} title={
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <BgColorsOutlined /> Özelleştir
      </span>
    } width={460} closable styles={{ body: { padding: 0 } }}>
      <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 22 }}>

        {/* HAZIR LAYOUT'LAR */}
        <Section title="Hazır Layout'lar" sub="Rol bazlı preset'ler — tek tıkla uygula">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {PRESET_LAYOUTS.map((p) => (
              <PresetRow key={p.id} name={p.name} sub={p.sub} accent={p.config.accent || '#22d3c5'}
                onClick={() => applyLayout(p.id)} />
            ))}
          </div>
        </Section>

        {/* KAYITLI LAYOUT'LAR */}
        <Section title="Kayıtlı Layout'lar" sub="Kendi düzenini kaydet, sonra geri yükle">
          {savedLayouts.length === 0 ? (
            <div style={{ fontSize: 11.5, color: 'var(--fg-3)', padding: '6px 0' }}>
              Henüz kaydedilmiş düzen yok.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
              {savedLayouts.map((s) => (
                <div key={s.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px', background: 'var(--bg-1)',
                  border: '1px solid var(--line)', borderRadius: 6,
                }}>
                  <AppstoreOutlined style={{ color: 'var(--fg-3)' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 500 }}>{s.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--fg-3)' }}>
                      {s.config.viewVariant} · menu-{s.config.menuPosition} · {s.config.density}
                    </div>
                  </div>
                  <button className="nm-btn ghost" style={{ height: 24, fontSize: 11 }}
                    onClick={() => applyLayout(s.id)}>
                    <CheckOutlined /> Uygula
                  </button>
                  <Popconfirm title="Silinsin mi?" okText="Sil" cancelText="İptal" okButtonProps={{ danger: true }}
                    onConfirm={() => deleteLayout(s.id)}>
                    <button className="nm-btn ghost" style={{ height: 24, fontSize: 11, color: 'var(--crit)' }}>
                      <DeleteOutlined />
                    </button>
                  </Popconfirm>
                </div>
              ))}
            </div>
          )}
          {/* Mevcut Düzeni Kaydet */}
          <div style={{ display: 'flex', gap: 6 }}>
            <Input placeholder="Düzene isim ver…" value={layoutName} size="small"
              onChange={(e) => setLayoutName(e.target.value)}
              onPressEnter={() => { if (layoutName.trim()) { saveLayout(layoutName); setLayoutName('') } }} />
            <button className="nm-btn primary" style={{ height: 28, fontSize: 11.5, padding: '0 12px' }}
              disabled={!layoutName.trim()}
              onClick={() => { saveLayout(layoutName); setLayoutName('') }}>
              <SaveOutlined /> Kaydet
            </button>
          </div>
        </Section>

        {/* GÖRÜNÜM */}
        <Section title="Görünüm" sub="Dashboard yerleşim varyantı (yakında — Dashboard rewrite)">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, color: 'var(--fg-2)' }}>
            {VIEWS.map((v) => (
              <ChoiceCard key={v.id} active={viewVariant === v.id} onClick={() => setViewVariant(v.id)}
                label={v.label} sub={v.sub} thumb={v.thumb} />
            ))}
          </div>
        </Section>

        {/* MENÜ POZİSYONU */}
        <Section title="Menü Pozisyonu" sub="Navigasyonun yerleşimi" icon={<MenuOutlined />}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, color: 'var(--fg-2)' }}>
            {MENUS.map((m) => (
              <ChoiceCard key={m.id} active={menuPosition === m.id} onClick={() => setMenuPosition(m.id)}
                label={m.label} sub={m.sub} thumb={m.thumb} />
            ))}
          </div>
        </Section>

        {/* TEMA */}
        <Section title="Tema" sub="Karanlık veya açık görünüm">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <ChoiceCard active={isDark} onClick={() => { if (!isDark) toggle() }}
              icon={<MoonOutlined />} label="Karanlık" sub="NOC için ideal" />
            <ChoiceCard active={!isDark} onClick={() => { if (isDark) toggle() }}
              icon={<SunOutlined />} label="Aydınlık" sub="Gündüz / raporlar" />
          </div>
        </Section>

        {/* YOĞUNLUK */}
        <Section title="Yoğunluk" sub="Boşluk ve padding ayarı">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {DENSITIES.map((d) => (
              <ChoiceCard key={d.id} active={density === d.id} onClick={() => setDensity(d.id)}
                label={d.label} sub={d.sub} />
            ))}
          </div>
        </Section>

        {/* AKSAN RENGİ */}
        <Section title="Aksan Rengi" sub="Vurgu ve aktif öğeler">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 8, marginBottom: 10 }}>
            {ACCENT_PRESETS.map((p) => {
              const isActive = accent.toLowerCase() === p.hex.toLowerCase()
              return (
                <div key={p.hex} title={`${p.name} · ${p.hex}`} onClick={() => setAccent(p.hex)}
                  style={{
                    aspectRatio: '1', background: p.hex, borderRadius: 8, cursor: 'pointer',
                    border: `2px solid ${isActive ? 'var(--fg-0)' : 'transparent'}`,
                    boxShadow: isActive ? `0 0 0 1px ${p.hex}` : 'none',
                    transition: 'all 0.12s',
                  }} />
              )
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--fg-2)' }}>
            <span>Veya özel:</span>
            <ColorPicker value={accent} onChange={(c) => setAccent(c.toHexString())} size="small" />
            <span className="mono" style={{ color: 'var(--fg-3)' }}>{accent.toUpperCase()}</span>
          </div>
        </Section>

        {/* DÜZENLEME MODU */}
        <Section title="Düzenleme Modu" sub="Dashboard widget reorder + gizle/göster (Dashboard rewrite ile)" icon={<EditOutlined />}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0' }}>
            <div style={{ fontSize: 12, color: 'var(--fg-2)', maxWidth: '70%' }}>
              {editMode
                ? 'Açık — kartlar sürüklenebilir / gizle-göster modu aktif'
                : 'Kapalı — Aç ve kartların yerini değiştir'}
            </div>
            <Switch checked={editMode} onChange={setEditMode} />
          </div>
        </Section>

        {/* SESLİ ALARM */}
        <Section title="Sesli Alarm" sub="Kritik olaylarda bildirim sesi (kısa ding)" icon={<SoundOutlined />}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0' }}>
            <div style={{ fontSize: 12, color: 'var(--fg-2)', maxWidth: '70%' }}>
              {soundEnabled ? 'Açık — kritik olayda Web Audio beep' : 'Kapalı — sadece görsel bildirim'}
            </div>
            <Switch checked={soundEnabled} onChange={setSoundEnabled} />
          </div>
        </Section>

        {/* NOC DUVAR MODU */}
        <Section title="NOC Duvar Modu" sub="Sayfalar arası otomatik dönüşüm (auto-rotation)" icon={<MonitorOutlined />}>
          {wall.active ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12, color: 'var(--accent)' }}>
                Aktif: <strong>{wall.routes[wall.currentIdx]?.label || '?'}</strong> ({wall.currentIdx + 1}/{wall.routes.length}) · {wall.intervalSec}s/sayfa
              </div>
              <button className="nm-btn ghost" style={{ width: '100%', height: 30, fontSize: 12 }}
                onClick={() => { wall.stop(); onClose() }}>
                <StopOutlined /> Durdur
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button className="nm-btn primary" style={{ width: '100%', height: 32, fontSize: 12 }}
                onClick={() => { wall.start(); onClose() }}>
                <MonitorOutlined /> Başlat ({wall.intervalSec}s/sayfa)
              </button>
              <div style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
                Default rota: {wall.routes.map((r) => r.label).join(' → ')}
              </div>
            </div>
          )}
        </Section>

        {/* Sıfırla */}
        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          <button className="nm-btn ghost" onClick={reset} style={{ width: '100%', height: 32, fontSize: 12 }}>
            <ReloadOutlined /> Varsayılana Sıfırla
          </button>
          <div style={{ fontSize: 10.5, color: 'var(--fg-3)', marginTop: 8, textAlign: 'center' }}>
            Bu seçimler bu tarayıcıda saklanır.
          </div>
        </div>
      </div>
    </Drawer>
  )
}

function Section({ title, sub, icon, children }:
  { title: string; sub?: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-0)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {icon}{title}
        </div>
        {sub && <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 2 }}>{sub}</div>}
      </div>
      {children}
    </div>
  )
}

function ChoiceCard({ active, onClick, icon, label, sub, thumb }:
  { active: boolean; onClick: () => void; icon?: React.ReactNode; label: string; sub?: string; thumb?: React.ReactNode }) {
  return (
    <div onClick={onClick} style={{
      padding: '10px 12px',
      borderRadius: 8,
      border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
      background: active ? 'var(--accent-soft)' : 'var(--bg-1)',
      cursor: 'pointer',
      transition: 'all 0.12s',
      display: 'flex', flexDirection: 'column', gap: 4,
      color: active ? 'var(--accent)' : 'var(--fg-2)',
    }}>
      {thumb && <div style={{ marginBottom: 4 }}>{thumb}</div>}
      <div style={{
        fontSize: 13, fontWeight: active ? 600 : 500,
        color: active ? 'var(--accent)' : 'var(--fg-0)',
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}>{icon}{label}</div>
      {sub && <div style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{sub}</div>}
    </div>
  )
}

function PresetRow({ name, sub, accent, onClick }:
  { name: string; sub: string; accent: string; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 12px',
      borderRadius: 8,
      border: '1px solid var(--line)',
      background: 'var(--bg-1)',
      cursor: 'pointer',
      transition: 'all 0.12s',
    }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: accent, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-0)' }}>{name}</div>
        <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>{sub}</div>
      </div>
      <CheckOutlined style={{ color: 'var(--fg-3)', fontSize: 12 }} />
    </div>
  )
}
