import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'

type ThemeMode = 'dark' | 'light'

interface ThemeCtx {
  mode: ThemeMode
  toggle: () => void
  isDark: boolean
}

const ThemeContext = createContext<ThemeCtx>({
  mode: 'dark',
  toggle: () => {},
  isDark: true,
})

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('nm-theme')
    return (saved === 'light' ? 'light' : 'dark') as ThemeMode
  })

  useEffect(() => {
    localStorage.setItem('nm-theme', mode)
    document.documentElement.setAttribute('data-theme', mode)
    // noc.css'in `.theme-light` token override'ları sadece `.nm-app-shell`
    // altında etkili — ama antd Modal/Drawer Portal ile document.body'ye
    // render oluyor, dolayısıyla shell dışında kalıp dark default'lara
    // düşüyor. `theme-light` class'ını <body>'e de uygulayarak her
    // Portal-child'ın doğru CSS variables'ını almasını sağlıyoruz.
    document.body.classList.toggle('theme-light', mode === 'light')
  }, [mode])

  const toggle = () => setMode((m) => (m === 'dark' ? 'light' : 'dark'))

  return (
    <ThemeContext.Provider value={{ mode, toggle, isDark: mode === 'dark' }}>
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)
