// Run: cd frontend && npx --yes tsx tests/panel-registry.test.ts
// Spec (build plan L4 step 2): duplicate id rejected, order stable, unknown tab id
// falls back to Outputs. Also pins the `vn-panel` localStorage state parser.
import {
  registerTab, getTabs, getTab, resolveTabId, DEFAULT_TAB_ID, _resetRegistryForTests,
  type PanelTabDef,
} from '../src/components/panel/registry'
import {
  PANEL_STORAGE_KEY, DEFAULT_PANEL_STATE, MIN_PANEL_WIDTH_PCT, MAX_PANEL_WIDTH_PCT,
  PANEL_DESKTOP_MIN_WIDTH, PANEL_SHEET_QUERY, isPanelSheet,
  parsePanelState, serializePanelState, clampPanelWidth,
} from '../src/lib/panel-state'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', 'src')
const readSrc = (p: string) => readFileSync(join(SRC, p), 'utf8')

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { _resetRegistryForTests(); fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const Dummy = () => null
const tab = (id: string, extra: Partial<PanelTabDef> = {}): PanelTabDef => ({ id, label: id, component: Dummy, ...extra })

t('default tab id is outputs', () => eq(DEFAULT_TAB_ID, 'outputs', 'DEFAULT_TAB_ID'))

t('registerTab accepts a new tab and getTab finds it', () => {
  ok(registerTab(tab('outputs')) === true, 'accepted')
  eq(getTab('outputs')?.label, 'outputs', 'getTab')
  eq(getTab('nope'), undefined, 'unknown getTab')
})

t('duplicate id is rejected and the first registration wins', () => {
  const origWarn = console.warn; console.warn = () => {}
  try {
    ok(registerTab(tab('outputs', { label: 'First' })), 'first accepted')
    ok(registerTab(tab('outputs', { label: 'Second' })) === false, 'duplicate rejected')
    eq(getTabs().length, 1, 'still one tab')
    eq(getTab('outputs')?.label, 'First', 'first kept')
  } finally { console.warn = origWarn }
})

t('invalid definitions are rejected', () => {
  const origWarn = console.warn; console.warn = () => {}
  try {
    ok(registerTab(tab('')) === false, 'empty id')
    ok(registerTab({ id: 'x', label: 'x' } as any) === false, 'missing component')
    eq(getTabs().length, 0, 'nothing registered')
  } finally { console.warn = origWarn }
})

t('order is stable: registration order, then explicit order wins', () => {
  registerTab(tab('outputs'))
  registerTab(tab('timeline'))
  registerTab(tab('preview'))
  eq(getTabs().map(x => x.id), ['outputs', 'timeline', 'preview'], 'registration order')
  eq(getTabs().map(x => x.id), ['outputs', 'timeline', 'preview'], 'same order on every read')
  registerTab(tab('diagram', { order: -1 }))
  registerTab(tab('browser', { order: 99 }))
  eq(getTabs().map(x => x.id), ['diagram', 'outputs', 'timeline', 'preview', 'browser'], 'explicit order, ties keep registration order')
})

t('getTabs returns a snapshot that callers cannot corrupt', () => {
  registerTab(tab('outputs'))
  const snap = getTabs() as PanelTabDef[]
  try { (snap as any).push(tab('evil')) } catch { /* frozen is fine too */ }
  eq(getTabs().map(x => x.id), ['outputs'], 'registry unchanged')
})

t('resolveTabId: known id kept, unknown/empty falls back to outputs', () => {
  registerTab(tab('timeline'))
  registerTab(tab('outputs'))
  eq(resolveTabId('timeline'), 'timeline', 'known')
  eq(resolveTabId('browser'), 'outputs', 'unknown -> outputs')
  eq(resolveTabId(null), 'outputs', 'null -> outputs')
  eq(resolveTabId(undefined), 'outputs', 'undefined -> outputs')
  eq(resolveTabId(''), 'outputs', 'empty -> outputs')
})

t('resolveTabId: without an outputs tab, falls back to the first tab, then to outputs', () => {
  eq(resolveTabId('anything'), 'outputs', 'empty registry still answers outputs')
  registerTab(tab('timeline'))
  eq(resolveTabId('anything'), 'timeline', 'first registered tab')
})

t('panel state: key, defaults and round trip', () => {
  eq(PANEL_STORAGE_KEY, 'vn-panel', 'storage key')
  eq(DEFAULT_PANEL_STATE, { open: false, tab: 'outputs', widthPct: 45 }, 'defaults')
  const s = { open: true, tab: 'timeline', widthPct: 52 }
  eq(parsePanelState(serializePanelState(s)), s, 'round trip')
})

t('panel state: corrupt or partial storage never throws and falls back per field', () => {
  eq(parsePanelState(null), DEFAULT_PANEL_STATE, 'null')
  eq(parsePanelState('not json'), DEFAULT_PANEL_STATE, 'garbage')
  eq(parsePanelState('[]'), DEFAULT_PANEL_STATE, 'array')
  eq(parsePanelState('{"open":"yes","tab":7,"widthPct":"wide"}'), DEFAULT_PANEL_STATE, 'wrong types')
  eq(parsePanelState('{"open":true}'), { ...DEFAULT_PANEL_STATE, open: true }, 'partial')
  eq(parsePanelState('{"widthPct":5}').widthPct, MIN_PANEL_WIDTH_PCT, 'too narrow clamped')
  eq(parsePanelState('{"widthPct":500}').widthPct, MAX_PANEL_WIDTH_PCT, 'too wide clamped')
  eq(clampPanelWidth(NaN), DEFAULT_PANEL_STATE.widthPct, 'NaN width -> default')
})

// --- sheet breakpoint and tablet layout (issue #118 follow-up) --------------

t('sheet breakpoint is named once and matches Tailwind xl', () => {
  eq(PANEL_DESKTOP_MIN_WIDTH, 1280, 'xl')
  eq(PANEL_SHEET_QUERY, '(max-width: 1279px)', 'media query')
  eq([isPanelSheet(390), isPanelSheet(834), isPanelSheet(1279), isPanelSheet(1280), isPanelSheet(1440)],
    [true, true, true, false, false], 'phone/tablet are sheet, xl+ is drawer')
})

t('RightPanel reads the breakpoint from panel-state, never a literal query', () => {
  const src = readSrc('components/panel/RightPanel.tsx')
  ok(src.includes('PANEL_SHEET_QUERY'), 'RightPanel should import PANEL_SHEET_QUERY')
  ok(!/matchMedia\(\s*['"`]/.test(src), 'matchMedia called with a literal query string (it can drift from the xl: classes)')
})

t('the panel anchor exists at every width below xl, not only on the phone', () => {
  const src = readSrc('components/VoiceRoom.tsx')
  const anchor = src.split('\n').find(l => l.includes('PANEL_ANCHOR_ATTR') && l.includes('<div'))
  ok(!!anchor, 'no element carries PANEL_ANCHOR_ATTR in VoiceRoom')
  // `sm:hidden` / `md:hidden` here means no layout box at tablet widths, which
  // is exactly how the sheet ended up overlaying the composer on an iPad.
  ok(!/\b(sm|md|lg):hidden\b/.test(anchor!), 'the panel anchor is hidden below xl, so the sheet has no edge to sit above')
})

t('the chat column can still shrink at the xl boundary (no horizontal overflow)', () => {
  const src = readSrc('components/VoiceRoom.tsx')
  const col = src.split('\n').find(l => l.includes('flex-1 min-w-0') && l.includes('flex flex-col bg-gray-900'))
  ok(!!col, 'chat column not found')
  ok(!/\bxl:min-w-\[/.test(col!), 'chat column has an xl min-width floor; with the 15rem rail and a 70% shrink-0 aside the row cannot fit 1280px')
})

const failed = results.filter(r => !r[1])
for (const [name, pass, msg] of results) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${msg ? `\n      ${msg}` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
