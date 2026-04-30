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
  }, [mode])

  const toggle = () => setMode((m) => (m === 'dark' ? 'light' : 'dark'))

  return (
    <ThemeContext.Provider value={{ mode, toggle, isDark: mode === 'dark' }}>
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)
