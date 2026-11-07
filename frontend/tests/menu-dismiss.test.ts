// Run: cd frontend && npx --yes tsx tests/menu-dismiss.test.ts
// Spec (bug 1ae9496a): menus close on Escape and on a pointerdown outside the
// menu + toggle; a pointerdown on the toggle or inside the menu is "inside"
// (the toggle's onClick handles closing).
import { isDismissKey, isOutsideTarget } from '../src/lib/menu-dismiss'

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(a === b, `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

// Tiny fake tree: a node "contains" itself and its descendants.
type N = { id: string; parent?: N }
const box = (root: N) => ({ contains: (n: N) => { for (let c: N | undefined = n; c; c = c.parent) if (c === root) return true; return false } })
const page: N = { id: 'page' }
const wrap: N = { id: 'wrap', parent: page }
const toggle: N = { id: 'toggle', parent: wrap }
const menu: N = { id: 'menu', parent: wrap }
const item: N = { id: 'item', parent: menu }
const elsewhere: N = { id: 'elsewhere', parent: page }

t('Escape is a dismiss key; others are not', () => {
  eq(isDismissKey('Escape'), true, 'Escape')
  eq(isDismissKey('Esc'), true, 'legacy Esc')
  eq(isDismissKey('Enter'), false, 'Enter')
  eq(isDismissKey(' '), false, 'Space')
  eq(isDismissKey(undefined), false, 'undefined')
})

t('pointerdown on the toggle or inside the menu is inside', () => {
  eq(isOutsideTarget(toggle, [box(wrap)]), false, 'toggle')
  eq(isOutsideTarget(item, [box(wrap)]), false, 'menu item')
  eq(isOutsideTarget(menu, [box(menu), box(toggle)]), false, 'separate menu ref')
  eq(isOutsideTarget(toggle, [box(menu), box(toggle)]), false, 'separate toggle ref')
})

t('pointerdown elsewhere on the page is outside', () => {
  eq(isOutsideTarget(elsewhere, [box(wrap)]), true, 'elsewhere')
  eq(isOutsideTarget(page, [box(wrap)]), true, 'page root')
})

t('null containers are skipped; none mounted => never outside', () => {
  eq(isOutsideTarget(elsewhere, [null, box(wrap), undefined]), true, 'mixed')
  eq(isOutsideTarget(elsewhere, [null, undefined]), false, 'nothing mounted')
  eq(isOutsideTarget(elsewhere, []), false, 'empty list')
})

t('null target counts as outside when a container is mounted', () => {
  eq(isOutsideTarget(null, [box(wrap)]), true, 'null target')
})

let fail = 0
for (const [n, p, m] of results) { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? `\n      ${m}` : ''}`); if (!p) fail++ }
console.log(`\n${results.length - fail}/${results.length} passed`)
process.exit(fail ? 1 : 0)
