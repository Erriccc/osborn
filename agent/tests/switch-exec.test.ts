// Run: npx tsx agent/tests/switch-exec.test.ts
// #74 S4/S7 pure executor helpers (session-switch.ts):
//   resolveSessionCwd      — hint → current dir → ONE cheap slug scan → null
//   keepNonConversationItems — chatCtx rebuild keeps instructions, drops A's turns (4.13)
//   recoverySessionId      — auto-recovery resumes the switched-to session (4.3, D7)
//   warmParkKey            — keep-warm keys a primed-but-uninitialised session (4.3)
import assert from 'node:assert/strict'
import { resolveSessionCwd, keepNonConversationItems, recoverySessionId, warmParkKey, sessionMessagesDir, createSwitchGuard, scanSlugCwd } from '../src/session-switch.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let pass = 0, fail = 0
async function t(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log('PASS', name) }
  catch (e: any) { fail++; console.log('FAIL', name, '-', String(e?.message).split('\n')[0].slice(0, 300)) }
}

const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const where: Record<string, string> = { [B]: '/w/proj-b' }
const deps = (over: any = {}) => ({
  exists: (id: string, wd: string) => where[id] === wd,
  lookupCwd: async (id: string) => where[id] ?? null,
  ...over,
})

await t('cwd: valid hint wins', async () => {
  assert.equal(await resolveSessionCwd(B, '/w/proj-b', '/w/proj-a', deps()), '/w/proj-b')
})
await t('cwd: wrong hint ignored, current dir used when the session lives there', async () => {
  assert.equal(await resolveSessionCwd(B, '/w/nope', '/w/proj-b', deps()), '/w/proj-b')
})
await t('cwd: cross-project with no hint resolves through the one-session scan', async () => {
  const r = await resolveSessionCwd(B, undefined, '/w/proj-a', deps())
  assert.equal(r, '/w/proj-b')
})
await t('cwd: a looked-up cwd that does not actually hold the session is not trusted', async () => {
  const r = await resolveSessionCwd(B, undefined, '/w/proj-a', deps({ lookupCwd: async () => '/w/stale' }))
  assert.equal(r, null)
})
// REGRESSION (connect latency): the connect path awaits this whenever the URL
// pins a session, so it must never fan out to listAllClaudeSessions() — a full
// cross-project metadata sweep, cold after every machine start, which is what
// made resuming a specific session on a freshly-rolled machine take tens of
// seconds. Two pins: a usable hint does ZERO lookups, and a miss does exactly
// ONE (SessionCwdDeps has a single lookup slot, so there is nowhere to hang a
// sweep behind it).
await t('cwd: at most ONE cheap lookup — connect never awaits a full session-list sweep', async () => {
  let calls = 0
  const counted = (ret: string | null) => deps({ lookupCwd: async () => { calls++; return ret } })
  assert.equal(await resolveSessionCwd(B, '/w/proj-b', '/w/proj-a', counted(null)), '/w/proj-b')
  assert.equal(calls, 0, 'a hint that holds the session must not trigger any lookup')
  assert.equal(await resolveSessionCwd(B, undefined, '/w/proj-b', counted(null)), '/w/proj-b')
  assert.equal(calls, 0, 'the current dir holding the session must not trigger any lookup')
  assert.equal(await resolveSessionCwd(B, '/w/nope', '/w/proj-a', counted('/w/proj-b')), '/w/proj-b')
  assert.equal(calls, 1, 'a full miss must cost exactly one lookup')
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

await t('S8 /session-messages dir: a workingDirectory that holds the session is used', () => {
  assert.equal(sessionMessagesDir(B, '/w/proj-b', '/w/boot', (id, wd) => where[id] === wd), '/w/proj-b')
})
await t('S8 /session-messages dir: invalid / foreign / missing workingDirectory falls back to the boot dir', () => {
  const ex = (id: string, wd: string) => where[id] === wd
  assert.equal(sessionMessagesDir(B, '/etc', '/w/boot', ex), '/w/boot')
  assert.equal(sessionMessagesDir(B, '', '/w/boot', ex), '/w/boot')
  assert.equal(sessionMessagesDir(B, null, '/w/boot', ex), '/w/boot')
})
await t('S8 route reads compactions + store from the validated dir', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
  const i = src.indexOf("url.pathname === '/session-messages'")
  const b = src.slice(i, i + 2600)
  assert.ok(/sessionMessagesDir\(sessionId, url\.searchParams\.get\('workingDirectory'\)/.test(b))
  assert.ok(/readCompactionMarkers\(sessionId, readDir\)/.test(b) && /storeExists\(sessionId, readDir\)/.test(b))
})

// ── Review minors ──
await t('guard: a never-resolving acknowledgment does not block the next switch', async () => {
  const g = createSwitchGuard()
  const first = await g.run(async () => 'ack-1', () => new Promise(() => { /* say() never resolves */ }))
  assert.equal(first.ran, true)
  assert.equal(g.busy, false, 'guard released before the acknowledgment')
  const second = await g.run(async () => 'ack-2')
  assert.equal(second.ran, true)
})
await t('guard: a request during the critical section is dropped (caller replies switch_in_progress)', async () => {
  const g = createSwitchGuard()
  let release!: () => void
  const p1 = g.run(() => new Promise<string>((r) => { release = () => r('done') }))
  const p2 = await g.run(async () => 'x')
  assert.equal(p2.ran, false)
  release()
  assert.equal((await p1).ran, true)
  assert.equal(g.busy, false)
})
await t('guard: a throwing critical section still releases the guard', async () => {
  const g = createSwitchGuard()
  await assert.rejects(g.run(async () => { throw new Error('boom') }))
  assert.equal(g.busy, false)
})
await t('guard: a rejecting acknowledgment is swallowed', async () => {
  const g = createSwitchGuard()
  const r = await g.run(async () => 1, () => Promise.reject(new Error('tts down')))
  assert.equal(r.ran, true)
  await new Promise((res) => setTimeout(res, 5))
})
await t('index: performSessionSwitch uses the guard and replies switch_in_progress', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
  const i = src.indexOf('async function performSessionSwitch(')
  const b = src.slice(i, i + 9000)
  assert.ok(/switchGuard\.run\(/.test(b))
  assert.ok(/reason: 'switch_in_progress'/.test(b))
  assert.ok(!/await \(currentSession as any\)\.say\(/.test(b), 'acknowledgment must not be awaited inside the guard')
  const d = src.slice(src.indexOf('async function requestSessionSwitch('), src.indexOf('async function performSessionSwitch('))
  assert.ok(/void requestSessionSwitch\([^)]*\)\.catch\(/.test(d), 'deferred re-request needs .catch')
})
await t('scanSlugCwd: decoded path that does not exist is not returned (no mkdir of scan paths)', async () => {
  const fsx = { readdir: () => ['-w-projb', '-w-ghost'], exists: (p: string) => p === '/w/projb' || p === '/p/-w-projb/' + B + '.jsonl' || p === '/p/-w-ghost/' + B + '.jsonl' || p === '/p' }
  assert.equal(await scanSlugCwd(B, '/p', fsx), '/w/projb')
  const ghostOnly = { readdir: () => ['-w-ghost'], exists: (p: string) => p === '/p' || p === '/p/-w-ghost/' + B + '.jsonl' }
  assert.equal(await scanSlugCwd(B, '/p', ghostOnly), null)
  assert.equal(await scanSlugCwd(B, '/missing', { readdir: () => [], exists: () => false }), null)
})
await t('scanSlugCwd: lossy slug (project dir whose name contains "-") falls back to the JSONL cwd', async () => {
  // `-w-my-app` decodes to /w/my/app, which does not exist. This is the single
  // case the full session-list sweep used to recover; one file read replaces it.
  const base = { readdir: () => ['-w-my-app'], exists: (p: string) => p === '/p' || p === '/p/-w-my-app/' + B + '.jsonl' }
  assert.equal(await scanSlugCwd(B, '/p', { ...base, readCwd: async () => '/w/my-app' }), '/w/my-app')
  assert.equal(await scanSlugCwd(B, '/p', { ...base, readCwd: async () => '' }), null)
  assert.equal(await scanSlugCwd(B, '/p', { ...base, readCwd: async () => { throw new Error('unreadable') } }), null)
  assert.equal(await scanSlugCwd(B, '/p', base), null, 'no reader → no fallback')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
