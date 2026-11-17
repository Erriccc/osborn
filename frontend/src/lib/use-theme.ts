'use client'
// React hooks over src/lib/theme.ts (kept apart so the root layout, a server
// component, can import the theme script without pulling in hooks).
import { useEffect, useState } from 'react'
import { THEME_EVENT, readResolvedTheme, readThemePref, setThemePref, type ResolvedTheme, type ThemePref } from './theme'

/** The stored choice, and a setter that applies it at once. */
export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>('system')
  useEffect(() => {
    setPref(readThemePref())
    const sync = () => setPref(readThemePref())
    window.addEventListener(THEME_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(THEME_EVENT, sync); window.removeEventListener('storage', sync) }
  }, [])
  return [pref, (p: ThemePref) => { setThemePref(p); setPref(p) }]
}

/**
 * The theme on screen now; follows the setting and the system. Starts from the
 * attribute, so use it for effects (mermaid), not for markup the server renders.
 */
export function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(readResolvedTheme)
  useEffect(() => {
    const sync = () => setTheme(readResolvedTheme())
    sync()
    // The attribute is the single source of truth; watch it.
    const obs = new MutationObserver(sync)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return theme
}

/**
 * Mounted once in the root layout. When React has to render the document again
 * on the client (a hydration error replaces <html>), the attribute the pre-paint
 * script set is gone; put it back, and keep it there.
 */
export function ThemeSync() {
  useEffect(() => {
    const root = document.documentElement
    const ensure = () => { if (!root.hasAttribute('data-theme')) window.__osbornApplyTheme?.() }
    ensure()
    const obs = new MutationObserver(ensure)
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return null
}
