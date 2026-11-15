// Run: cd frontend && npx --yes tsx tests/drawer-height.test.ts
// Activity-log drawer height (#305): opens at ~40% of the viewport (max 256px),
// never exceeds 65%, and re-fits when the viewport changes.
import { clampDrawerHeight, defaultDrawerHeight } from '../src/lib/drawer-height'

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(a === b, `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

t('opens at 256px on a tall screen and ~40% on a phone', () => {
  eq(defaultDrawerHeight(1000), 256, 'desktop')
  eq(defaultDrawerHeight(600), 240, 'phone portrait')
  eq(defaultDrawerHeight(375), 150, 'phone landscape')
})
t('rotating portrait → landscape keeps a dragged height within 65%', () => {
  ok(clampDrawerHeight(256, 375) <= 375 * 0.65, 'within the cap')
  eq(clampDrawerHeight(256, 375), 243, 'clamped to 65%')
})
t('a height inside the band is kept', () => eq(clampDrawerHeight(200, 800), 200, 'kept'))
t('the 120px floor gives way on a very short viewport, so 65% always holds', () => {
  eq(clampDrawerHeight(50, 800), 120, 'floor')
  ok(clampDrawerHeight(50, 150) <= 150 * 0.65, 'short viewport')
  ok(defaultDrawerHeight(150) <= 150 * 0.65, 'short viewport default')
})

let failed = 0
for (const [name, pass, err] of results) {
  console.log(`${pass ? '✅' : '❌'} ${name}${err ? ` — ${err}` : ''}`)
  if (!pass) failed++
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
