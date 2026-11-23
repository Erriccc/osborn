// Voice dispatch: project name -> session, who may call /dispatch, and spoke reports never steering a turn.
// Run: npx tsx agent/tests/dispatch-resolve.test.ts
import assert from 'node:assert/strict'
import { resolveDispatchTarget } from '../src/session-switch.js'
import { SlotRegistry } from '../src/slot-manager.js'
import { dispatchRefusal } from '../src/agent-store.js'
import { getSpokeReport, steersTurn } from '../src/prompts.js'

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}
const s = (sessionId: string, cwd: string, day: number) => ({ sessionId, cwd, timestamp: new Date(2026, 10, day) })
const sessions = [s('old-osborn', '/work/osborn', 1), s('new-osborn', '/work/osborn', 5), s('audos-1', '/work/audos-com', 3), s('web-a', '/a/web', 2), s('web-b', '/b/web', 4)]
const free = (focused: string | null = null, slotState: 'none' | 'idle' | 'busy' = 'none', slots = new SlotRegistry({ max: 2, foregroundId: () => focused })) =>
  ({ seat: (id: string) => slots.admit(id), slotState: () => slotState })

t('matches by folder name, newest session wins, case and punctuation ignored', () => {
  const r = resolveDispatchTarget('Osborn', sessions, free())
  assert.equal(r.ok, true); assert.equal(r.sessionId, 'new-osborn'); assert.equal(r.cwd, '/work/osborn')
  assert.equal(resolveDispatchTarget('audos com', sessions, free()).sessionId, 'audos-1')
})
t('unknown project is 404, empty is 400, two folders with the name are 400', () => {
  assert.equal(resolveDispatchTarget('nope', sessions, free()).status, 404)
  assert.equal(resolveDispatchTarget('  ', sessions, free()).status, 400)
  const amb = resolveDispatchTarget('web', sessions, free())
  assert.equal(amb.ok, false); assert.equal(amb.status, 400); assert.match(amb.error, /\/a\/web/)
})
t('the focused session is refused with 409', () => {
  const r = resolveDispatchTarget('osborn', sessions, free('new-osborn'))
  assert.equal(r.ok, false); assert.equal(r.status, 409)
})
t('a full slot cap is 409; a busy existing slot is 409; an idle one is reused', () => {
  const full = new SlotRegistry({ max: 1 }); full.add({ id: 'x', llm: {}, isFocused: false, workingDir: '/w' })
  assert.equal(resolveDispatchTarget('osborn', sessions, free(null, 'none', full)).status, 409)
  const mine = new SlotRegistry({ max: 2 }); mine.add({ id: 'new-osborn', llm: {}, isFocused: false, workingDir: '/w' })
  assert.equal(resolveDispatchTarget('osborn', sessions, free(null, 'busy', mine)).status, 409)
  assert.equal(resolveDispatchTarget('osborn', sessions, free(null, 'idle', mine)).ok, true)
})

const local = { forwarded: false, host: 'localhost:8741', remote: '127.0.0.1', contentType: 'application/json' }
t('/dispatch takes only JSON from this machine with no browser origin', () => {
  assert.equal(dispatchRefusal(local), null)
  assert.equal(dispatchRefusal({ ...local, contentType: 'application/json; charset=utf-8' }), null)
  assert.equal(dispatchRefusal({ ...local, remote: '10.0.0.5' })?.status, 403)
  assert.equal(dispatchRefusal({ ...local, host: 'abc.fly.dev' })?.status, 403)
  assert.equal(dispatchRefusal({ ...local, forwarded: true })?.status, 403)
  assert.equal(dispatchRefusal({ ...local, origin: 'http://localhost:3000' })?.status, 403, 'even a local page')
  assert.equal(dispatchRefusal({ ...local, contentType: 'text/plain' })?.status, 415)
  assert.equal(dispatchRefusal({ ...local, contentType: undefined })?.status, 415)
})
t('a [NOTIFICATION] never steers a turn, like [MEETING and [SYSTEM; a user turn does', () => {
  for (const p of ['[NOTIFICATION] x', '[MEETING — b]: x', '[SYSTEM] x']) assert.equal(steersTurn(p), false, p)
  assert.equal(steersTurn('have osborn fix it'), true)
  assert.equal(steersTurn(getSpokeReport({ project: 'p', sessionId: 'abcdef123', status: 'done', summary: 'ok' })), false)
})
t('a spoke report names project, session and status and bounds the summary', () => {
  const r = getSpokeReport({ project: 'osborn', sessionId: 'abcdef123456', status: 'failed', summary: 'x'.repeat(5000) })
  assert.match(r, /^\[NOTIFICATION\] Spoke report\. Project: osborn\. Session: abcdef12\. Status: failed\./)
  assert.ok(r.length < 1800)
})
console.log(`${pass} passed`)
