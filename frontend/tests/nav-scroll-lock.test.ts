// Run: cd frontend && npx --yes tsx tests/nav-scroll-lock.test.ts
// Spec: the landing nav locks body scroll ONLY while the mobile sheet is open
// below Tailwind lg (1024px). Regression: iPad rotate 834 -> 1194 crosses lg,
// CSS hides the sheet and hamburger, and the lock used to stay on.
import {
  LANDING_DESKTOP_MIN_WIDTH,
  LANDING_DESKTOP_QUERY,
  isLandingDesktop,
  shouldLockBodyScroll,
} from '../src/lib/nav-scroll-lock'

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(a === b, `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

t('breakpoint matches Tailwind lg', () => {
  eq(LANDING_DESKTOP_MIN_WIDTH, 1024, 'min width')
  eq(LANDING_DESKTOP_QUERY, '(min-width: 1024px)', 'media query')
})

t('iPad widths classify correctly', () => {
  eq(isLandingDesktop(768), false, 'iPad mini portrait')
  eq(isLandingDesktop(834), false, 'iPad Air/Pro 11 portrait')
  eq(isLandingDesktop(1023), false, 'just under lg')
  eq(isLandingDesktop(1024), true, 'exactly lg (iPad Pro 12.9 portrait)')
  eq(isLandingDesktop(1194), true, 'iPad Pro 11 landscape')
})

t('degenerate widths are not desktop', () => {
  eq(isLandingDesktop(NaN), false, 'NaN')
  eq(isLandingDesktop(Infinity), false, 'Infinity')
  eq(isLandingDesktop(0), false, 'zero')
})

t('lock only when open below lg', () => {
  eq(shouldLockBodyScroll(true, false), true, 'open on tablet/phone')
  eq(shouldLockBodyScroll(false, false), false, 'closed on tablet/phone')
  eq(shouldLockBodyScroll(true, true), false, 'open but rotated into desktop')
  eq(shouldLockBodyScroll(false, true), false, 'closed on desktop')
})

t('rotate sequence releases the lock', () => {
  // portrait, open -> locked; rotate to landscape -> released even if open lingers
  ok(shouldLockBodyScroll(true, isLandingDesktop(834)), 'locked in portrait')
  ok(!shouldLockBodyScroll(true, isLandingDesktop(1194)), 'released in landscape')
})

let fail = 0
for (const [n, p, m] of results) { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? `\n      ${m}` : ''}`); if (!p) fail++ }
console.log(`\n${results.length - fail}/${results.length} passed`)
process.exit(fail ? 1 : 0)
