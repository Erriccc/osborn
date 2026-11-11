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

// ── issue #85: clamp to the VISIBLE chat region, not just the window ──────────
// With the Rooms rail (right edge ~400) and the Outputs panel (left edge ~1040)
// open on a 1280-wide desktop, the usable chat strip is [400, 1040]. A
// right-anchored 22rem (352px) Audio popover whose natural box starts at left=128
// clears the *window* clamp (128 > 8) but sits half under the rail — it must be
// pushed inside the strip.
t('panel open: popover under the pane LEFT edge is pushed inside the strip', () => {
  const dx = clampPopoverShift(128, 352, 1280, 8, 400, 1040)
  eq(dx, 280, 'shift to the pane gutter')
  eq(128 + dx, 408, 'final left at strip left + margin')
})

t('panel open: popover past the pane RIGHT edge is pulled inside the strip', () => {
  // maxLeft = 1040 - 8 - 352 = 680
  const dx = clampPopoverShift(900, 352, 1280, 8, 400, 1040)
  eq(900 + dx, 680, 'final left at strip right - margin - width')
  ok(dx < 0, 'negative shift')
})

t('no region arg -> back-compat window clamp (popover that fits is untouched)', () => {
  eq(clampPopoverShift(128, 352, 1280), 0, 'fits the window, no shift')
})

t('popover already inside the strip -> no shift', () => {
  eq(clampPopoverShift(500, 352, 1280, 8, 400, 1040), 0, 'inside the pane')
})

t('region clamped to the viewport (off-screen/oversized region never pushes out)', () => {
  // A region that runs off the right edge is capped at the viewport; a popover
  // that fits the viewport is left alone rather than shoved past the edge.
  eq(clampPopoverShift(900, 352, 1280, 8, 0, 5000), 0, 'region capped at vw, fits')
  // A degenerate (empty) region is ignored.
  eq(clampPopoverShift(100, 240, 834, 8, 500, 500), 0, 'empty region -> no shift')
})

let fail = 0
for (const [n, p, m] of results) { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? `\n      ${m}` : ''}`); if (!p) fail++ }
console.log(`\n${results.length - fail}/${results.length} passed`)
process.exit(fail ? 1 : 0)
