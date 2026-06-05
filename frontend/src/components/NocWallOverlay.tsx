// NocWallOverlay — auto-rotation aktifken ekranın sağ alt köşesinde kalan
// kontrol şeridi (pause/next/stop). nm-rot-overlay noc.css'te tanımlı.
import { useNocWall } from '@/contexts/NocWallContext'
import { PauseOutlined, CaretRightOutlined, StepForwardOutlined, CloseOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

export default function NocWallOverlay() {
  const { active, paused, routes, currentIdx, intervalSec, pause, resume, next, stop } = useNocWall()
  const { t } = useTranslation()
  if (!active) return null
  const route = routes[currentIdx] || routes[0]
  return (
    <div className="nm-rot-overlay">
      <span className={paused ? '' : 'ring'} style={paused ? { fontSize: 14 } : undefined}>
        {paused ? '⏸' : ''}
      </span>
      <span><strong style={{ color: 'var(--fg-0)' }}>{route?.label || '?'}</strong></span>
      <span style={{ color: 'var(--fg-3)' }}>{currentIdx + 1}/{routes.length}</span>
      <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{t('noc_wall.seconds_per_page', { count: intervalSec })}</span>
      <button onClick={paused ? resume : pause} title={paused ? t('noc_wall.resume') : t('noc_wall.pause')}>
        {paused ? <CaretRightOutlined /> : <PauseOutlined />}
      </button>
      <button onClick={next} title={t('noc_wall.next')}><StepForwardOutlined /></button>
      <button onClick={stop} title={t('noc_wall.exit')}><CloseOutlined /></button>
    </div>
  )
}
