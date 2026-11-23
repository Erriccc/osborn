// Background slot lifecycle: a dead slot (consumer error / failed resume) is aborted and dropped so it
// stops holding a cap seat, the frontend still hears about it, releaseAll aborts and clears every slot,
// and the live foreground session can never become a slot.
// Run: npx tsx agent/tests/slot-lifecycle.test.ts
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SlotRegistry, cleanUpSlotOnFailure, type SessionSlot, type SlotFailure } from '../src/slot-manager.js'

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

const fakeLLM = () => {
  const calls: string[] = []
  return { calls, abortQuery: () => { calls.push('abortQuery') }, abortAgent: () => { calls.push('abortAgent') }, hasSession: () => true }
}
type FakeSlot = SessionSlot<ReturnType<typeof fakeLLM>>
const spawn = (r: SlotRegistry<FakeSlot>, id: string): FakeSlot => {
  assert.equal(r.admit(id).ok, true, `admit ${id}`)
  return r.add({ id, llm: fakeLLM(), isFocused: false, workingDir: '/w' })
}

t('a consumer error aborts the slot, removes it, frees capacity, and still reports the error', () => {
  const r = new SlotRegistry<FakeSlot>({ max: 2 })
  const em = new EventEmitter()
  const dead = spawn(r, 'aaaaaaaa-1')
  spawn(r, 'bbbbbbbb-2')
  const seen: SlotFailure[] = []
  cleanUpSlotOnFailure(em, r, dead, (f) => seen.push(f))
  assert.equal(r.admit('cccccccc-3').ok, false, 'at cap before the error')
  em.emit('consumer_error', { message: 'spawn ENOENT' })
  assert.equal(r.has('aaaaaaaa-1'), false)
  assert.deepEqual(dead.llm.calls, ['abortQuery', 'abortAgent'])
  assert.equal(seen.length, 1)
  assert.equal(seen[0].kind, 'consumer_error')
  assert.equal(seen[0].error, 'spawn ENOENT')
  assert.equal(r.admit('cccccccc-3').ok, true, 'the seat is free again')
})

t('a consumer error with no message reports the old default text', () => {
  const r = new SlotRegistry<FakeSlot>({ max: 2 })
  const em = new EventEmitter()
  const s = spawn(r, 'aaaaaaaa-1')
  const seen: SlotFailure[] = []
  cleanUpSlotOnFailure(em, r, s, (f) => seen.push(f))
  em.emit('consumer_error', {})
  assert.equal(seen[0].error, 'Background session failed to start')
})

t('a failed resume also aborts and removes the slot, reporting "Session resume failed"', () => {
  const r = new SlotRegistry<FakeSlot>({ max: 2 })
  const em = new EventEmitter()
  const s = spawn(r, 'aaaaaaaa-1')
  const seen: SlotFailure[] = []
  cleanUpSlotOnFailure(em, r, s, (f) => seen.push(f))
  em.emit('session_resume_failed', { requestedSessionId: 'aaaaaaaa-1', actualSessionId: 'zzzzzzzz-9' })
  assert.equal(r.size, 0)
  assert.deepEqual(s.llm.calls, ['abortQuery', 'abortAgent'])
  assert.equal(seen[0].kind, 'session_resume_failed')
  assert.equal(seen[0].error, 'Session resume failed')
})

t('a late error from a stopped slot does not remove a newer slot with the same id', () => {
  const r = new SlotRegistry<FakeSlot>({ max: 2 })
  const oldEm = new EventEmitter()
  const old = spawn(r, 'aaaaaaaa-1')
  let reported = 0
  cleanUpSlotOnFailure(oldEm, r, old, () => { reported++ })
  r.remove('aaaaaaaa-1')
  const fresh = spawn(r, 'aaaaaaaa-1')
  oldEm.emit('consumer_error', { message: 'late' })
  assert.equal(r.get('aaaaaaaa-1'), fresh)
  assert.deepEqual(fresh.llm.calls, [])
  assert.equal(reported, 1, 'the frontend still hears about it')
})

t('releaseAll aborts and clears every slot', () => {
  const r = new SlotRegistry<FakeSlot>({ max: 3 })
  const a = spawn(r, 'aaaaaaaa-1')
  const b = spawn(r, 'bbbbbbbb-2')
  r.releaseAll()
  assert.equal(r.size, 0)
  assert.deepEqual(a.llm.calls, ['abortQuery', 'abortAgent'])
  assert.deepEqual(b.llm.calls, ['abortQuery', 'abortAgent'])
})

t('an abort that throws does not stop releaseAll from clearing the rest', () => {
  const r = new SlotRegistry<any>({ max: 2 })
  r.add({ id: 'aaaaaaaa-1', llm: { abortQuery: () => { throw new Error('boom') } }, isFocused: false, workingDir: '/w' })
  const b = spawn(r, 'bbbbbbbb-2')
  r.releaseAll()
  assert.equal(r.size, 0)
  assert.deepEqual(b.llm.calls, ['abortQuery', 'abortAgent'])
})

t('the foreground session id cannot become a slot (same error text as the old handler)', () => {
  let fg: string | null = 'ffffffff-fg'
  const r = new SlotRegistry<FakeSlot>({ max: 5, foregroundId: () => fg })
  const seat = r.admit('ffffffff-fg')
  assert.equal(seat.ok, false)
  assert.equal(seat.reason, 'foreground')
  assert.equal(seat.error, 'Session ffffffff is the active foreground session — pick a different session to background')
  fg = 'something-else'
  assert.equal(r.admit('ffffffff-fg').ok, true, 'once it is no longer the foreground it may be backgrounded')
})

t('findKey matches a full id or an 8-char prefix; list() gives the slots_list rows', () => {
  const r = new SlotRegistry<FakeSlot>({ max: 2 })
  spawn(r, 'aaaaaaaa-1111')
  assert.equal(r.findKey('aaaaaaaa'), 'aaaaaaaa-1111')
  assert.equal(r.findKey('aaaaaaaa-1111'), 'aaaaaaaa-1111')
  assert.equal(r.findKey('bbbbbbbb'), undefined)
  assert.deepEqual(r.list(), [{ id: 'aaaaaaaa-1111', isFocused: false, workingDir: '/w', hasSession: true }])
})

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')

t('index.ts wires the slot manager: env, failure cleanup, foreground guard, release at hang-up', () => {
  assert.ok(/const bgEnv = buildSlotEnv\(process\.env\)/.test(src), 'slot env comes from buildSlotEnv')
  assert.ok(!/for \(const \[k, v\] of Object\.entries\(process\.env\)\)[\s\S]{0,80}bgEnv/.test(src), 'no raw process.env copy into the slot env')
  assert.ok(/cleanUpSlotOnFailure\(bgEmitter, slots, slot,[\s\S]{0,600}background_session_error/.test(src), 'dead slots are cleaned up and still reported')
  assert.ok(/new SlotRegistry<SessionSlot>\(\{ foregroundId:/.test(src), 'the registry knows the foreground session')
  assert.ok(/const releaseAgents = [\s\S]{0,200}slots\.releaseAll\(\)/.test(src), 'releaseAgents aborts and clears every slot')
  assert.ok(/slots\.admit\(sessionId\)[\s\S]{0,400}background_session_error/.test(src), 'a refused spawn still sends background_session_error')
})

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`)
