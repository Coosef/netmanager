// TopNav — menu pozisyonu "top" iken yatay üst nav. noc.css'in
// nm-topnav + nm-tn-group + nm-tn-dropdown CSS pattern'i kullanılıyor
// (pure CSS hover dropdown; antd Dropdown gerektirmiyor).
import { useNavigate, useLocation } from 'react-router-dom'
import { useNavGroups } from './useNavGroups'
import CharonLogo from '@/components/CharonLogo'

export default function TopNav() {
  const navigate = useNavigate()
  const location = useLocation()
  const GROUPS = useNavGroups()

  const isActiveKey = (key: string) =>
    location.pathname === key || (key !== '/' && location.pathname.startsWith(key))

  return (
    <div className="nm-topnav">
      {/* Brand */}
      <div className="nm-brand" onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>
        <CharonLogo size={26} glow={false} />
        <div className="nm-brand-name" style={{ fontWeight: 600, fontSize: 14, color: 'var(--fg-0)' }}>
          Charon
        </div>
      </div>

      {GROUPS.map((group) => {
        const hasActive = group.items.some((it) => isActiveKey(it.key))
        const totalBadge = group.items.reduce((s, it) => s + (it.badgeCount ?? 0), 0)
        return (
          <div key={group.label} className={`nm-tn-group ${hasActive ? 'active' : ''}`} tabIndex={0}>
            <button className="nm-tn-grouplbl">
              {group.label}
              {totalBadge > 0 && (
                <span className="nm-navbadge crit" style={{ marginLeft: 6 }}>{totalBadge}</span>
              )}
              <span style={{ marginLeft: 6, fontSize: 9, opacity: 0.5 }}>▾</span>
            </button>
            <div className="nm-tn-dropdown">
              <div className="nm-tn-dd-label">{group.label}</div>
              {group.items.map((item) => {
                const active = isActiveKey(item.key)
                return (
                  <div key={item.key}
                    className={`nm-tn-dd-item ${active ? 'active' : ''}`}
                    onClick={() => navigate(item.key)}>
                    <span className="nm-navicon">{item.icon}</span>
                    <span>{item.label}</span>
                    {(item.badgeCount ?? 0) > 0 && (
                      <span className={`nm-navbadge ${item.badge === 'approval' ? 'warn' : 'crit'}`}>{item.badgeCount}</span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
