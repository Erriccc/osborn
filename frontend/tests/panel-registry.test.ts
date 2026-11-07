// Run: cd frontend && npx --yes tsx tests/panel-registry.test.ts
// Spec (build plan L4 step 2): duplicate id rejected, order stable, unknown tab id
// falls back to Outputs. Also pins the `vn-panel` localStorage state parser.
import {
  registerTab, getTabs, getTab, resolveTabId, DEFAULT_TAB_ID, _resetRegistryForTests,
  type PanelTabDef,
} from '../src/components/panel/registry'
import {
  PANEL_STORAGE_KEY, DEFAULT_PANEL_STATE, MIN_PANEL_WIDTH_PCT, MAX_PANEL_WIDTH_PCT,
  parsePanelState, serializePanelState, clampPanelWidth,
} from '../src/lib/panel-state'

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

const failed = results.filter(r => !r[1])
for (const [name, pass, msg] of results) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${msg ? `\n      ${msg}` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
