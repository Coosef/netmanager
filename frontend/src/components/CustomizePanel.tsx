// CustomizePanel v2 — Phase 2 zenginleştirilmiş özelleştirme paneli.
// Mockup'a uyumlu: GÖRÜNÜM (Workspace/Mission/Editorial thumbnails) +
// HAZIR LAYOUT'LAR (Operatör/Network Admin/Yönetici/NOC Duvarı) +
// KAYITLI LAYOUT'LAR (named, kullanıcı kaydedebilir) + MEVCUT DÜZENİ
// KAYDET input + TEMA + YOĞUNLUK + AKSAN RENGİ + MENÜ POZİSYONU +
// DÜZENLEME modu toggle + SESLİ ALARM + NOC DUVAR MODU + Varsayılana Sıfırla.
import { useMemo, useState } from 'react'
import { Drawer, ColorPicker, Switch, Input, Popconfirm } from 'antd'
import {
  SunOutlined, MoonOutlined, MenuOutlined, BgColorsOutlined, ReloadOutlined,
  SoundOutlined, MonitorOutlined, StopOutlined, AppstoreOutlined, EditOutlined,
  SaveOutlined, DeleteOutlined, CheckOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/contexts/ThemeContext'
import {
  useCustomize, ACCENT_PALETTES, PRESET_LAYOUTS, ALL_WIDGETS,
  type Density, type MenuPosition, type ViewVariant,
} from '@/contexts/CustomizeContext'
import { useNocWall } from '@/contexts/NocWallContext'

interface Props { open: boolean; onClose: () => void }

export default function CustomizePanel({ open, onClose }: Props) {
  const { t } = useTranslation()
  const { isDark, toggle } = useTheme()
  const {
    density, setDensity, menuPosition, setMenuPosition,
    accent, accentPalette, setAccent, setAccentPalette,
    viewVariant, setViewVariant, soundEnabled, setSoundEnabled,
    editMode, setEditMode,
    widgetHidden, toggleWidget,
    savedLayouts, saveLayout, applyLayout, deleteLayout, reset,
  } = useCustomize()
  const wall = useNocWall()
  const [layoutName, setLayoutName] = useState('')

  // LANG-FIX-W1: arrays moved into useMemo so labels follow the active language.
  const DENSITIES: { id: Density; label: string; sub: string }[] = useMemo(() => [
    { id: 'compact',  label: t('customize.density.compact_label'),  sub: t('customize.density.compact_sub') },
    { id: 'regular',  label: t('customize.density.regular_label'),  sub: t('customize.density.regular_sub') },
    { id: 'spacious', label: t('customize.density.spacious_label'), sub: t('customize.density.spacious_sub') },
  ], [t])

  /* eslint-disable react-hooks/exhaustive-deps */
  const VIEWS: { id: ViewVariant; label: string; sub: string; thumb: React.ReactNode }[] = useMemo(() => [
    {
      id: 'workspace', label: t('customize.view.workspace_label'), sub: t('customize.view.workspace_sub'),
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
      id: 'mission', label: t('customize.view.mission_label'), sub: t('customize.view.mission_sub'),
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
      id: 'editorial', label: t('customize.view.editorial_label'), sub: t('customize.view.editorial_sub'),
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
  ], [t])
  /* eslint-enable react-hooks/exhaustive-deps */

  const MENUS: { id: MenuPosition; label: string; sub: string; thumb: React.ReactNode }[] = useMemo(() => [
    {
      id: 'side', label: t('customize.menu.side_label'), sub: t('customize.menu.side_sub'),
      thumb: (
        <svg viewBox="0 0 60 30" fill="none" style={{ width: '100%', height: 32 }}>
          <rect x="0" y="0" width="14" height="30" fill="currentColor" opacity="0.18" />
          <rect x="17" y="3" width="40" height="6" rx="1" fill="currentColor" opacity="0.1" />
          <rect x="17" y="13" width="40" height="14" rx="1" stroke="currentColor" strokeWidth="0.6" />
        </svg>
      ),
    },
    {
      id: 'top', label: t('customize.menu.top_label'), sub: t('customize.menu.top_sub'),
      thumb: (
        <svg viewBox="0 0 60 30" fill="none" style={{ width: '100%', height: 32 }}>
          <rect x="0" y="0" width="60" height="6" fill="currentColor" opacity="0.18" />
          <rect x="0" y="8" width="60" height="6" rx="1" fill="currentColor" opacity="0.1" />
          <rect x="2" y="16" width="56" height="13" rx="1" stroke="currentColor" strokeWidth="0.6" />
        </svg>
      ),
    },
  ], [t])

  return (
    <Drawer open={open} onClose={onClose} title={
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <BgColorsOutlined /> {t('customize.panel_title')}
      </span>
    } width={460} closable styles={{ body: { padding: 0 } }}>
      <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 22 }}>

        {/* HAZIR LAYOUT'LAR */}
        <Section title={t('customize.presets.title')} sub={t('customize.presets.subtitle')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {PRESET_LAYOUTS.map((p) => {
              const palette = p.config.paletteName
                ? ACCENT_PALETTES.find((x) => x.name === p.config.paletteName)
                : undefined
              return (
                <PresetRow key={p.id} name={p.name} sub={p.sub}
                  swatchColors={palette?.colors ?? ['#22d3c5', '#22c55e', '#f59e0b']}
                  onClick={() => applyLayout(p.id)} />
              )
            })}
          </div>
        </Section>

        {/* KAYITLI LAYOUT'LAR */}
        <Section title={t('customize.saved.title')} sub={t('customize.saved.subtitle')}>
          {savedLayouts.length === 0 ? (
            <div style={{ fontSize: 11.5, color: 'var(--fg-3)', padding: '6px 0' }}>
              {t('customize.saved.empty')}
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
                    <CheckOutlined /> {t('common.apply')}
                  </button>
                  <Popconfirm title={t('customize.saved.delete_confirm')} okText={t('common.delete')} cancelText={t('common.cancel')} okButtonProps={{ danger: true }}
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
            <Input placeholder={t('customize.saved.name_placeholder')} value={layoutName} size="small"
              onChange={(e) => setLayoutName(e.target.value)}
              onPressEnter={() => { if (layoutName.trim()) { saveLayout(layoutName); setLayoutName('') } }} />
            <button className="nm-btn primary" style={{ height: 28, fontSize: 11.5, padding: '0 12px' }}
              disabled={!layoutName.trim()}
              onClick={() => { saveLayout(layoutName); setLayoutName('') }}>
              <SaveOutlined /> {t('common.save')}
            </button>
          </div>
        </Section>

        {/* GÖRÜNÜM */}
        <Section title={t('customize.view.title')} sub={t('customize.view.subtitle')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, color: 'var(--fg-2)' }}>
            {VIEWS.map((v) => (
              <ChoiceCard key={v.id} active={viewVariant === v.id} onClick={() => setViewVariant(v.id)}
                label={v.label} sub={v.sub} thumb={v.thumb} />
            ))}
          </div>
        </Section>

        {/* MENÜ POZİSYONU */}
        <Section title={t('customize.menu.title')} sub={t('customize.menu.subtitle')} icon={<MenuOutlined />}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, color: 'var(--fg-2)' }}>
            {MENUS.map((m) => (
              <ChoiceCard key={m.id} active={menuPosition === m.id} onClick={() => setMenuPosition(m.id)}
                label={m.label} sub={m.sub} thumb={m.thumb} />
            ))}
          </div>
        </Section>

        {/* TEMA */}
        <Section title={t('customize.theme.title')} sub={t('customize.theme.subtitle')}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <ChoiceCard active={isDark} onClick={() => { if (!isDark) toggle() }}
              icon={<MoonOutlined />} label={t('customize.theme.dark_label')} sub={t('customize.theme.dark_sub')} />
            <ChoiceCard active={!isDark} onClick={() => { if (isDark) toggle() }}
              icon={<SunOutlined />} label={t('customize.theme.light_label')} sub={t('customize.theme.light_sub')} />
          </div>
        </Section>

        {/* YOĞUNLUK */}
        <Section title={t('customize.density.title')} sub={t('customize.density.subtitle')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {DENSITIES.map((d) => (
              <ChoiceCard key={d.id} active={density === d.id} onClick={() => setDensity(d.id)}
                label={d.label} sub={d.sub} />
            ))}
          </div>
        </Section>

        {/* AKSAN RENGİ — 3-renkli paletler */}
        <Section title={t('customize.accent.title')} sub={t('customize.accent.subtitle')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 10 }}>
            {ACCENT_PALETTES.map((p) => {
              const isActive = accentPalette.name === p.name
              return (
                <div key={p.name} onClick={() => setAccentPalette(p)} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                  border: `1px solid ${isActive ? 'var(--accent)' : 'var(--line)'}`,
                  background: isActive ? 'var(--accent-soft)' : 'var(--bg-1)',
                  transition: 'all 0.12s',
                }}>
                  {/* 3 swatch yan yana */}
                  <div style={{ display: 'flex', gap: 3 }}>
                    {p.colors.map((c, i) => (
                      <span key={i} style={{
                        width: 14, height: 14, borderRadius: 3, background: c,
                        boxShadow: '0 0 0 1px rgba(0,0,0,0.15) inset',
                      }} />
                    ))}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12.5, fontWeight: isActive ? 600 : 500,
                      color: isActive ? 'var(--accent)' : 'var(--fg-0)',
                    }}>{p.name}</div>
                    <div className="mono" style={{ fontSize: 9.5, color: 'var(--fg-3)' }}>{p.colors.join(' · ')}</div>
                  </div>
                  {isActive && <CheckOutlined style={{ color: 'var(--accent)', fontSize: 12 }} />}
                </div>
              )
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--fg-2)' }}>
            <span>{t('customize.accent.custom_primary')}</span>
            <ColorPicker value={accent} onChange={(c) => setAccent(c.toHexString())} size="small" />
            <span className="mono" style={{ color: 'var(--fg-3)' }}>{accent.toUpperCase()}</span>
          </div>
        </Section>

        {/* DÜZENLEME MODU */}
        <Section title={t('customize.edit_mode.title')} sub={t('customize.edit_mode.subtitle')} icon={<EditOutlined />}>
          <button onClick={() => setEditMode(!editMode)} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            width: '100%', padding: '12px 14px',
            border: `1px solid ${editMode ? 'var(--accent)' : 'var(--line)'}`,
            background: editMode ? 'var(--accent-soft)' : 'var(--bg-1)',
            borderRadius: 8, cursor: 'pointer', textAlign: 'left',
          }}>
            <span style={{
              width: 32, height: 32, borderRadius: 8,
              background: editMode ? 'var(--accent)' : 'var(--bg-2)',
              color: editMode ? '#000' : 'var(--fg-2)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <EditOutlined />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: editMode ? 'var(--accent)' : 'var(--fg-0)' }}>
                {editMode ? t('customize.edit_mode.on_label') : t('customize.edit_mode.off_label')}
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                {editMode ? t('customize.edit_mode.on_sub') : t('customize.edit_mode.off_sub')}
              </div>
            </div>
          </button>
        </Section>

        {/* WIDGET GÖRÜNÜRLÜĞÜ */}
        <Section title={t('customize.widgets.title')} sub={t('customize.widgets.subtitle')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {ALL_WIDGETS.map((w) => {
              const visible = !widgetHidden.includes(w.id)
              return (
                <div key={w.id} onClick={() => toggleWidget(w.id)} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 10px', borderRadius: 6,
                  border: `1px solid ${visible ? 'var(--accent-line, var(--accent))' : 'var(--line)'}`,
                  background: visible ? 'var(--accent-soft)' : 'var(--bg-1)',
                  cursor: 'pointer', transition: 'all 0.12s',
                }}>
                  <span style={{
                    width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                    border: `1.5px solid ${visible ? 'var(--accent)' : 'var(--fg-3)'}`,
                    background: visible ? 'var(--accent)' : 'transparent',
                    color: '#000',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {visible && <CheckOutlined style={{ fontSize: 10 }} />}
                  </span>
                  <span style={{ flex: 1, fontSize: 12.5, color: visible ? 'var(--fg-0)' : 'var(--fg-2)' }}>
                    {w.label}
                  </span>
                  <span style={{
                    fontSize: 9.5, color: 'var(--fg-3)',
                    fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
                  }}>{w.cat}</span>
                </div>
              )
            })}
          </div>
        </Section>

        {/* SESLİ ALARM */}
        <Section title={t('customize.sound.title')} sub={t('customize.sound.subtitle')} icon={<SoundOutlined />}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0' }}>
            <div style={{ fontSize: 12, color: 'var(--fg-2)', maxWidth: '70%' }}>
              {soundEnabled ? t('customize.sound.on_desc') : t('customize.sound.off_desc')}
            </div>
            <Switch checked={soundEnabled} onChange={setSoundEnabled} />
          </div>
        </Section>

        {/* NOC DUVAR MODU */}
        <Section title={t('customize.wall.title')} sub={t('customize.wall.subtitle')} icon={<MonitorOutlined />}>
          {wall.active ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12, color: 'var(--accent)' }}>
                {t('customize.wall.active_label')} <strong>{wall.routes[wall.currentIdx]?.label || '?'}</strong> ({wall.currentIdx + 1}/{wall.routes.length}) · {wall.intervalSec}{t('customize.wall.seconds_per_page')}
              </div>
              <button className="nm-btn ghost" style={{ width: '100%', height: 30, fontSize: 12 }}
                onClick={() => { wall.stop(); onClose() }}>
                <StopOutlined /> {t('customize.wall.stop')}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button className="nm-btn primary" style={{ width: '100%', height: 32, fontSize: 12 }}
                onClick={() => { wall.start(); onClose() }}>
                <MonitorOutlined /> {t('customize.wall.start')} ({wall.intervalSec}{t('customize.wall.seconds_per_page')})
              </button>
              <div style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
                {t('customize.wall.default_route')} {wall.routes.map((r) => r.label).join(' → ')}
              </div>
            </div>
          )}
        </Section>

        {/* Sıfırla */}
        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          <button className="nm-btn ghost" onClick={reset} style={{ width: '100%', height: 32, fontSize: 12 }}>
            <ReloadOutlined /> {t('customize.reset')}
          </button>
          <div style={{ fontSize: 10.5, color: 'var(--fg-3)', marginTop: 8, textAlign: 'center' }}>
            {t('customize.storage_note')}
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

function PresetRow({ name, sub, swatchColors, onClick }:
  { name: string; sub: string; swatchColors: readonly string[]; onClick: () => void }) {
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
      <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
        {swatchColors.map((c, i) => (
          <span key={i} style={{ width: 11, height: 11, borderRadius: 3, background: c }} />
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-0)' }}>{name}</div>
        <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>{sub}</div>
      </div>
      <CheckOutlined style={{ color: 'var(--fg-3)', fontSize: 12 }} />
    </div>
  )
}
