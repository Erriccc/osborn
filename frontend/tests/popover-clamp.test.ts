// Run: cd frontend && npx --yes tsx tests/popover-clamp.test.ts
// Spec: clampPopoverShift(left, width, viewportWidth, margin) returns the
// horizontal px shift that keeps an anchored popover inside the viewport with a
// `margin` gutter. Regression: iPad portrait (834px) wraps the voice header so
// the right-anchored "More" menu's trigger lands at the LEFT; the menu's
// natural box starts off-screen (negative left) and must be shifted right.
import { clampPopoverShift } from '../src/lib/popover-clamp'

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(a === b, `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

t('fits already -> no shift', () => {
  eq(clampPopoverShift(100, 240, 834), 0, 'inside')
  eq(clampPopoverShift(8, 240, 834), 0, 'exactly at left gutter')
  eq(clampPopoverShift(834 - 8 - 240, 240, 834), 0, 'exactly at right gutter')
})

t('iPad portrait: right-anchored w-60 menu under a left trigger shifts right', () => {
  // trigger right edge ~ x=170, menu right-0 w-60 => left = 170 - 240 = -70
  const dx = clampPopoverShift(-70, 240, 834)
  eq(dx, 78, 'shift to the 8px gutter')
  eq(-70 + dx, 8, 'final left')
})

t('left-anchored popover near the right edge shifts left', () => {
  const dx = clampPopoverShift(700, 288, 834)
  eq(700 + dx + 288, 834 - 8, 'final right at gutter')
  ok(dx < 0, 'negative shift')
})

t('landscape: right-aligned menu at the far right is untouched', () => {
  // 1194 wide, trigger right edge ~ 1100 => left 860
  eq(clampPopoverShift(860, 240, 1194), 0, 'landscape no-op')
})

t('full-width bottom sheet (inset-x-0) is untouched', () => {
  eq(clampPopoverShift(0, 390, 390), 0, 'phone sheet')
  eq(clampPopoverShift(0, 834, 834), 0, 'wide sheet')
})

t('wider than viewport minus gutters -> centred', () => {
  eq(clampPopoverShift(-50, 380, 390), 5 + 50, 'centred')
})

t('custom margin honoured', () => {
  eq(clampPopoverShift(-10, 200, 800, 16), 26, 'margin 16')
})

t('degenerate input -> 0', () => {
  eq(clampPopoverShift(-10, 0, 800), 0, 'zero width')
  eq(clampPopoverShift(-10, 200, 0), 0, 'zero viewport')
  eq(clampPopoverShift(-10, 200, NaN), 0, 'NaN viewport')
})

t('result is always an integer', () => {
  ok(Number.isInteger(clampPopoverShift(-70.4, 240.3, 834.5)), 'integer')
})

let fail = 0
for (const [n, p, m] of results) { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? `\n      ${m}` : ''}`); if (!p) fail++ }
console.log(`\n${results.length - fail}/${results.length} passed`)
process.exit(fail ? 1 : 0)
