// CustomizePanel — Drawer-based Phase 2 UI customization (Aşama 1).
// Tema / Yoğunluk / Aksent rengi / Menü pozisyonu. Trigger: top bar
// SettingOutlined icon. Preset layouts ve dashboard edit mode Aşama 2.
import { Drawer, ColorPicker } from 'antd'
import { SunOutlined, MoonOutlined, MenuOutlined, BgColorsOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTheme } from '@/contexts/ThemeContext'
import { useCustomize, ACCENT_PRESETS, type Density, type MenuPosition } from '@/contexts/CustomizeContext'

interface Props {
  open: boolean
  onClose: () => void
}

export default function CustomizePanel({ open, onClose }: Props) {
  const { isDark, toggle } = useTheme()
  const { density, setDensity, menuPosition, setMenuPosition, accent, setAccent, reset } = useCustomize()

  const DENSITIES: { id: Density; label: string; sub: string }[] = [
    { id: 'compact',  label: 'Sıkı',   sub: 'Daha fazla içerik, dar boşluklar' },
    { id: 'regular',  label: 'Normal', sub: 'Dengeli — varsayılan' },
    { id: 'spacious', label: 'Geniş',  sub: 'Hava bol, daha okunaklı' },
  ]
  const MENUS: { id: MenuPosition; label: string; sub: string }[] = [
    { id: 'side', label: 'Yan',  sub: 'Sol kenar (varsayılan)' },
    { id: 'top',  label: 'Üst',  sub: 'Üst banner (yatay)' },
  ]

  return (
    <Drawer open={open} onClose={onClose} title={
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <BgColorsOutlined /> Özelleştir
      </span>
    } width={420} closable styles={{ body: { padding: 0 } }}>
      <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 22 }}>

        {/* Tema */}
        <Section title="Tema" sub="Karanlık veya açık görünüm">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <ChoiceCard active={isDark} onClick={() => { if (!isDark) toggle() }}
              icon={<MoonOutlined />} label="Karanlık" sub="NOC için ideal" />
            <ChoiceCard active={!isDark} onClick={() => { if (isDark) toggle() }}
              icon={<SunOutlined />} label="Aydınlık" sub="Gündüz/raporlar" />
          </div>
        </Section>

        {/* Yoğunluk */}
        <Section title="Yoğunluk" sub="Boşluk ve padding ayarı">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {DENSITIES.map((d) => (
              <ChoiceCard key={d.id} active={density === d.id} onClick={() => setDensity(d.id)}
                label={d.label} sub={d.sub} />
            ))}
          </div>
        </Section>

        {/* Aksent rengi */}
        <Section title="Aksent Rengi" sub="Vurgu ve aktif öğeler için">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 8, marginBottom: 10 }}>
            {ACCENT_PRESETS.map((p) => {
              const isActive = accent.toLowerCase() === p.hex.toLowerCase()
              return (
                <div key={p.hex}
                  title={`${p.name} · ${p.hex}`}
                  onClick={() => setAccent(p.hex)}
                  style={{
                    aspectRatio: '1',
                    background: p.hex,
                    borderRadius: 8,
                    cursor: 'pointer',
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

        {/* Menü pozisyonu */}
        <Section title="Menü Pozisyonu" sub="Navigasyonun yerleşimi"
          icon={<MenuOutlined />}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {MENUS.map((m) => (
              <ChoiceCard key={m.id} active={menuPosition === m.id} onClick={() => setMenuPosition(m.id)}
                label={m.label} sub={m.sub} />
            ))}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--fg-3)', marginTop: 6 }}>
            ℹ Menü pozisyonu değişikliği için sayfayı yenilemen gerekebilir.
          </div>
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

function ChoiceCard({ active, onClick, icon, label, sub }:
  { active: boolean; onClick: () => void; icon?: React.ReactNode; label: string; sub?: string }) {
  return (
    <div onClick={onClick} style={{
      padding: '10px 12px',
      borderRadius: 8,
      border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
      background: active ? 'var(--accent-soft)' : 'var(--bg-1)',
      cursor: 'pointer',
      transition: 'all 0.12s',
      display: 'flex', flexDirection: 'column', gap: 2,
    }}>
      <div style={{
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        color: active ? 'var(--accent)' : 'var(--fg-0)',
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}>{icon}{label}</div>
      {sub && <div style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{sub}</div>}
    </div>
  )
}
