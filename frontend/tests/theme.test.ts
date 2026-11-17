// Run: cd frontend && npx --yes tsx tests/theme.test.ts
// The pre-paint script resolves the theme choice: the device by default, a
// stored choice over it, and the meeting canvas and /v2 always dark.
import { parseThemePref, THEME_INIT_SCRIPT, THEME_STORAGE_KEY, THEME_COLOR } from '../src/lib/theme'

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
  return { theme: attrs['data-theme'], meta: meta.content }
}
t('script: no stored choice follows the device', () => {
  eq(runScript(null, true).theme, 'light', 'light device')
  eq(runScript(null, false).theme, 'dark', 'dark device')
})
t('script: a stored choice wins and sets the browser colour', () => {
  const r = runScript('light', false)
  eq(r.theme, 'light', 'theme'); eq(r.meta, THEME_COLOR.light, 'meta')
  eq(runScript('dark', true).theme, 'dark', 'dark')
})
t('script: garbage in storage is system', () => eq(runScript('purple', true).theme, 'light', 'garbage'))
t('script: the meeting canvas (a camera feed) and /v2 are always dark', () => {
  eq(runScript('light', true, '/meeting-canvas').theme, 'dark', 'canvas')
  eq(runScript('light', true, '/meeting-canvas/x').theme, 'dark', 'canvas child')
  eq(runScript('light', true, '/meeting-canvasx').theme, 'light', 'prefix only')
  eq(runScript('light', true, '/v2').theme, 'dark', 'v2')
})

const failed = results.filter(r => !r[1])
for (const [n, ok, m] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${m ? ' — ' + m : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
