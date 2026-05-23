// NocWallOverlay — auto-rotation aktifken ekranın sağ alt köşesinde kalan
// kontrol şeridi (pause/next/stop). nm-rot-overlay noc.css'te tanımlı.
import { useNocWall } from '@/contexts/NocWallContext'
import { PauseOutlined, CaretRightOutlined, StepForwardOutlined, CloseOutlined } from '@ant-design/icons'

export default function NocWallOverlay() {
  const { active, paused, routes, currentIdx, intervalSec, pause, resume, next, stop } = useNocWall()
  if (!active) return null
  const route = routes[currentIdx] || routes[0]
  return (
    <div className="nm-rot-overlay">
      <span className={paused ? '' : 'ring'} style={paused ? { fontSize: 14 } : undefined}>
        {paused ? '⏸' : ''}
      </span>
      <span><strong style={{ color: 'var(--fg-0)' }}>{route?.label || '?'}</strong></span>
      <span style={{ color: 'var(--fg-3)' }}>{currentIdx + 1}/{routes.length}</span>
      <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{intervalSec}s/sayfa</span>
      <button onClick={paused ? resume : pause} title={paused ? 'Devam' : 'Duraklat'}>
        {paused ? <CaretRightOutlined /> : <PauseOutlined />}
      </button>
      <button onClick={next} title="Sonraki"><StepForwardOutlined /></button>
      <button onClick={stop} title="Çık"><CloseOutlined /></button>
    </div>
  )
}
