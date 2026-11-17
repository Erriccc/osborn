// Run: cd frontend && npx --yes tsx tests/theme.test.ts
// The theme choice resolves the same way in the pre-paint script and in React,
// the meeting canvas is always dark, and the inline script applies a stored choice.
import { parseThemePref, resolveTheme, THEME_INIT_SCRIPT, THEME_STORAGE_KEY, THEME_COLOR } from '../src/lib/theme'

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const eq = (a: any, b: any, m: string) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

t('unknown stored values fall back to system', () => {
  for (const v of [null, undefined, '', 'blue', 1]) eq(parseThemePref(v), 'system', String(v))
  eq(parseThemePref('light'), 'light', 'light')
  eq(parseThemePref('dark'), 'dark', 'dark')
})
t('system follows the device', () => {
  eq(resolveTheme('system', true), 'light', 'system+light')
  eq(resolveTheme('system', false), 'dark', 'system+dark')
})
t('an explicit choice beats the device', () => {
  eq(resolveTheme('light', false), 'light', 'light on dark device')
  eq(resolveTheme('dark', true), 'dark', 'dark on light device')
})
t('the meeting canvas (a camera feed) is always dark', () => {
  eq(resolveTheme('light', true, '/meeting-canvas'), 'dark', 'canvas')
  eq(resolveTheme('light', true, '/meeting-canvas/x'), 'dark', 'canvas child')
  eq(resolveTheme('light', true, '/meeting-canvasx'), 'light', 'prefix only')
})

// Execute the inline script against a minimal DOM.
function runScript(stored: string | null, prefersLight: boolean, pathname = '/dashboard') {
  const attrs: Record<string, string> = {}
  const meta = { content: '', setAttribute(_: string, v: string) { this.content = v } }
  const g: any = {
    localStorage: { getItem: (k: string) => (k === THEME_STORAGE_KEY ? stored : null) },
    matchMedia: () => ({ matches: prefersLight, addEventListener() {} }),
    location: { pathname },
    document: {
      documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v }, style: {} as any },
      querySelectorAll: () => [meta],
      addEventListener() {},
    },
    addEventListener() {},
  }
  g.window = g
  new Function('window', 'document', 'localStorage', 'location', THEME_INIT_SCRIPT)(g, g.document, g.localStorage, g.location)
  return { theme: attrs['data-theme'], pref: attrs['data-theme-pref'], meta: meta.content }
}
t('script: no stored choice follows the device', () => {
  eq(runScript(null, true).theme, 'light', 'light device')
  eq(runScript(null, false).theme, 'dark', 'dark device')
  eq(runScript(null, true).pref, 'system', 'pref')
})
t('script: a stored choice wins and sets the browser colour', () => {
  const r = runScript('light', false)
  eq(r.theme, 'light', 'theme'); eq(r.meta, THEME_COLOR.light, 'meta')
  eq(runScript('dark', true).theme, 'dark', 'dark')
})
t('script: garbage in storage is system', () => eq(runScript('purple', true).theme, 'light', 'garbage'))
t('script: meeting canvas stays dark', () => eq(runScript('light', true, '/meeting-canvas').theme, 'dark', 'canvas'))

const failed = results.filter(r => !r[1])
for (const [n, ok, m] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${m ? ' — ' + m : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
