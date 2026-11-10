// Run: npx tsx agent/tests/switch-exec.test.ts
// #74 S4/S7 pure executor helpers (session-switch.ts):
//   resolveSessionCwd      — hint → current dir → session list → slug scan → null
//   keepNonConversationItems — chatCtx rebuild keeps instructions, drops A's turns (4.13)
//   recoverySessionId      — auto-recovery resumes the switched-to session (4.3, D7)
//   warmParkKey            — keep-warm keys a primed-but-uninitialised session (4.3)
import assert from 'node:assert/strict'
import { resolveSessionCwd, keepNonConversationItems, recoverySessionId, warmParkKey } from '../src/session-switch.js'

let pass = 0, fail = 0
async function t(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log('PASS', name) }
  catch (e: any) { fail++; console.log('FAIL', name, '-', String(e?.message).split('\n')[0].slice(0, 300)) }
}

const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const where: Record<string, string> = { [B]: '/w/proj-b' }
const deps = (over: any = {}) => ({
  exists: (id: string, wd: string) => where[id] === wd,
  listCwd: async (id: string) => where[id] ?? null,
  scanCwd: async (_id: string) => null as string | null,
  ...over,
})

await t('cwd: valid hint wins', async () => {
  assert.equal(await resolveSessionCwd(B, '/w/proj-b', '/w/proj-a', deps()), '/w/proj-b')
})
await t('cwd: wrong hint ignored, current dir used when the session lives there', async () => {
  assert.equal(await resolveSessionCwd(B, '/w/nope', '/w/proj-b', deps()), '/w/proj-b')
})
await t('cwd: cross-project with no hint resolves through the session list', async () => {
  let listed = 0
  const r = await resolveSessionCwd(B, undefined, '/w/proj-a', deps({ listCwd: async (id: string) => { listed++; return where[id] } }))
  assert.equal(r, '/w/proj-b')
  assert.equal(listed, 1)
})
await t('cwd: list cwd that does not actually hold the session is not trusted', async () => {
  const r = await resolveSessionCwd(B, undefined, '/w/proj-a', deps({ listCwd: async () => '/w/stale' }))
  assert.equal(r, null)
})
await t('cwd: falls back to the slug scan (sessions the list filters out)', async () => {
  const r = await resolveSessionCwd(B, undefined, '/w/proj-a', deps({ listCwd: async () => null, scanCwd: async () => '/w/proj-b' }))
  assert.equal(r, '/w/proj-b')
})
await t('cwd: unknown session -> null ("Session not found")', async () => {
  assert.equal(await resolveSessionCwd('cccccccc-x', '/w/proj-a', '/w/proj-a', deps()), null)
})
await t('cwd: empty id -> null without lookups', async () => {
  let called = false
  assert.equal(await resolveSessionCwd('', undefined, '/w', deps({ exists: () => { called = true; return true } })), null)
  assert.equal(called, false)
})

await t('chatCtx rebuild keeps instructions/system items, drops user+assistant turns', () => {
  const items = [
    { type: 'message', role: 'system', textContent: 'instructions' },
    { type: 'message', role: 'developer', textContent: 'dev note' },
    { type: 'message', role: 'user', textContent: 'A user turn' },
    { type: 'message', role: 'assistant', textContent: 'A answer' },
    { type: 'function_call', name: 'x' },
    { type: 'agent_handoff' },
  ]
  const kept = keepNonConversationItems(items as any)
  assert.deepEqual(kept.map((i: any) => i.role ?? i.type), ['system', 'developer', 'function_call', 'agent_handoff'])
})
await t('chatCtx rebuild: empty / undefined safe', () => {
  assert.deepEqual(keepNonConversationItems([] as any), [])
  assert.deepEqual(keepNonConversationItems(undefined as any), [])
})

await t('recovery id: live id wins', () => {
  assert.equal(recoverySessionId({ liveSessionId: 'L', switchedTo: 'S', connectTime: 'C' }), 'L')
})
await t('recovery id: after a switch, before B\'s first turn -> B (not the connect-time A)', () => {
  assert.equal(recoverySessionId({ liveSessionId: null, switchedTo: 'B', connectTime: 'A' }), 'B')
})
await t('recovery id: nothing switched -> connect-time id (legacy)', () => {
  assert.equal(recoverySessionId({ liveSessionId: null, switchedTo: undefined, connectTime: 'A' }), 'A')
  assert.equal(recoverySessionId({ liveSessionId: null, switchedTo: undefined, connectTime: undefined }), undefined)
})

await t('warm park key: init id, else the id the query was spawned for', () => {
  assert.equal(warmParkKey({ sessionId: 'X', spawnedResumeId: 'Y' }), 'X')
  assert.equal(warmParkKey({ sessionId: null, spawnedResumeId: 'B' }), 'B')
  assert.equal(warmParkKey({ sessionId: null, spawnedResumeId: null }), null)
  assert.equal(warmParkKey(null), null)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
