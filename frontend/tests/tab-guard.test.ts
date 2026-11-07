// Run: cd frontend && npx --yes tsx tests/tab-guard.test.ts
// Spec (bug 619af155, frontend minimum; listen-only is lane L12): when a second
// tab of the same browser opens a chat while another tab controls the session,
// it does NOT join the room (no greeting, no mic, no send) and shows "This
// session is active in another tab" with "Take over". Take over moves control:
// this tab connects, the other tab drops its room (without making the agent
// leave) and shows the mirror notice. Browsers without the Web Locks API keep
// the old single-tab behaviour (always active).
import { tabGuardReducer, shouldConnectOnTransition, tabGuardCopy, controlsEnabled, type TabRole } from '../src/lib/tab-guard'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) } catch (e: any) { fail++; console.log('FAIL', name, String(e?.message || e).slice(0, 400)) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

t('first tab: probing -> active', () => eq(tabGuardReducer('probing', { type: 'acquired' }), 'active', 'acquired'))
t('second tab: probing -> standby', () => eq(tabGuardReducer('probing', { type: 'unavailable' }), 'standby', 'unavailable'))
t('no Web Locks: active (old behaviour)', () => eq(tabGuardReducer('probing', { type: 'unsupported' }), 'active', 'unsupported'))
t('take over from standby', () => {
  const s = tabGuardReducer('standby', { type: 'take-over' })
  eq(s, 'taking', 'taking')
  eq(tabGuardReducer(s, { type: 'acquired' }), 'active', 'then active')
})
t('the controlling tab loses control when stolen', () => eq(tabGuardReducer('active', { type: 'stolen' }), 'taken-over', 'stolen'))
t('take back from taken-over', () => eq(tabGuardReducer('taken-over', { type: 'take-over' }), 'taking', 'taking'))
t('a stale "unavailable" never demotes an active tab', () => eq(tabGuardReducer('active', { type: 'unavailable' }), 'active', 'kept'))
t('take-over while active is a no-op', () => eq(tabGuardReducer('active', { type: 'take-over' }), 'active', 'kept'))

t('connect exactly when becoming active', () => {
  ok(shouldConnectOnTransition('probing', 'active'), 'first tab')
  ok(shouldConnectOnTransition('taking', 'active'), 'after take over')
  ok(!shouldConnectOnTransition('active', 'active'), 'already active')
  ok(!shouldConnectOnTransition('probing', 'standby'), 'standby never connects (no greeting)')
  ok(!shouldConnectOnTransition('active', 'taken-over'), 'taken over')
})

t('mic and send only for the controlling tab', () => {
  const roles: TabRole[] = ['probing', 'standby', 'taking', 'active', 'taken-over']
  eq(roles.filter(controlsEnabled), ['active'], 'only active')
})

t('copy', () => {
  eq(tabGuardCopy('standby')?.title, 'This session is active in another tab', 'standby title')
  eq(tabGuardCopy('standby')?.action, 'Take over', 'standby action')
  eq(tabGuardCopy('taken-over')?.action, 'Take over', 'taken-over action')
  ok(/another tab/i.test(tabGuardCopy('taken-over')!.title), 'taken-over title')
  eq(tabGuardCopy('active'), null, 'no notice when active')
  eq(tabGuardCopy('probing'), null, 'no notice while probing')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
