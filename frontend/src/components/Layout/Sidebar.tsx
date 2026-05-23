import { Drawer } from 'antd'
import { CloseOutlined } from '@ant-design/icons'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useNavGroups } from './useNavGroups'

interface SidebarProps {
  mobileOpen?: boolean
  onMobileClose?: () => void
}

export default function Sidebar({ mobileOpen = false, onMobileClose }: SidebarProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { user } = useAuthStore()
  const isMobile = useIsMobile()
  const NAV_GROUPS = useNavGroups()

  const initials = (user?.username ?? 'CH').slice(0, 2).toUpperCase()

  const nav = (
    <aside className="nm-sidebar" style={{ height: '100%' }}>
      <div className="nm-brand" onClick={() => { navigate('/'); if (isMobile) onMobileClose?.() }} style={{ cursor: 'pointer' }}>
        <div className="nm-brand-mark" />
        <div className="nm-brand-name">
          Charon
          <small>universal cloud</small>
        </div>
        {isMobile && (
          <CloseOutlined onClick={(e) => { e.stopPropagation(); onMobileClose?.() }}
            style={{ marginLeft: 'auto', fontSize: 14, color: 'var(--fg-2)' }} />
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', margin: '0 -10px', padding: '0 10px' }}>
        {/* NAV_GROUPS hook'tan zaten filtreli geliyor (role/permission). */}
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="nm-navsect">{group.label}</div>
            {group.items.map((item) => {
              const active = location.pathname === item.key ||
                (item.key !== '/' && location.pathname.startsWith(item.key))
              const badgeCount = item.badgeCount ?? 0
              return (
                <div key={item.key}
                  className={`nm-navitem ${active ? 'active' : ''}`}
                  onClick={() => { navigate(item.key); if (isMobile) onMobileClose?.() }}>
                  <span className="nm-navicon">{item.icon}</span>
                  <span>{item.label}</span>
                  {badgeCount > 0 && (
                    <span className={`nm-navbadge ${item.badge === 'approval' ? 'warn' : 'crit'}`}>{badgeCount}</span>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>

      <div className="nm-sidebar-foot">
        <div className="nm-avatar">{initials}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--fg-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {user?.username ?? 'Charon'}
          </div>
          <small>{user?.role ?? ''}</small>
        </div>
      </div>
    </aside>
  )

  if (isMobile) {
    return (
      <Drawer open={mobileOpen} onClose={onMobileClose} placement="left" width={240}
        styles={{ body: { padding: 0, background: 'var(--bg-1)' }, header: { display: 'none' } }}
        style={{ zIndex: 1001 }}>
        {nav}
      </Drawer>
    )
  }
  return nav
}
