// TopNav — menu pozisyonu "top" iken yatay üst nav. noc.css'in
// nm-topnav + nm-tn-group + nm-tn-dropdown CSS pattern'i kullanılıyor
// (pure CSS hover dropdown; antd Dropdown gerektirmiyor).
//
// Faz 3: 12 ana grup düz liste. Her grup dropdown'da yetkili tab'ları
// gösterir; grup adı tıklanınca ilk yetkili tab'a yönlenir.
import { useNavigate, useLocation } from 'react-router-dom'
import { useNavGroups } from './useNavGroups'
import CharonLogo from '@/components/CharonLogo'
import { getActiveGroup } from '@/utils/menuGroups'

export default function TopNav() {
  const navigate = useNavigate()
  const location = useLocation()
  const NAV_ITEMS = useNavGroups()
  const activeGroup = getActiveGroup(location.pathname)

  return (
    <div className="nm-topnav">
      {/* Brand */}
      <div className="nm-brand" onClick={() => navigate('/dashboard')} style={{ cursor: 'pointer' }}>
        <CharonLogo size={26} glow={false} />
        <div className="nm-brand-name" style={{ fontWeight: 600, fontSize: 14, color: 'var(--fg-0)' }}>
          Charon
        </div>
      </div>

      {NAV_ITEMS.map((item) => {
        const isActiveGroup = item.groupKey === activeGroup
        const badgeCount = item.badgeCount ?? 0
        const badgeCls = item.badgeKind === 'warn' ? 'warn' : 'crit'
        const hasTabs = item.tabs.length > 0
        return (
          <div key={item.groupKey} className={`nm-tn-group ${isActiveGroup ? 'active' : ''}`} tabIndex={0}>
            <button className="nm-tn-grouplbl" onClick={() => navigate(item.route)}>
              <span className="nm-navicon" style={{ marginRight: 6 }}>{item.icon}</span>
              {item.label}
              {badgeCount > 0 && (
                <span className={`nm-navbadge ${badgeCls}`} style={{ marginLeft: 6 }}>{badgeCount}</span>
              )}
              {hasTabs && <span style={{ marginLeft: 6, fontSize: 9, opacity: 0.5 }}>▾</span>}
            </button>
            {hasTabs && (
              <div className="nm-tn-dropdown">
                <div className="nm-tn-dd-label">{item.label}</div>
                {item.tabs.map((tab) => {
                  const active = location.pathname === tab.route ||
                    (tab.route !== '/' && location.pathname.startsWith(tab.route))
                  return (
                    <div key={tab.key}
                      className={`nm-tn-dd-item ${active ? 'active' : ''}`}
                      onClick={() => navigate(tab.route)}>
                      <span>{tab.label}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
