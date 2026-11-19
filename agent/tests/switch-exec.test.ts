// Run: npx tsx agent/tests/switch-exec.test.ts
// #74 S4/S7 pure executor helpers (session-switch.ts):
//   resolveSessionCwd      — hint → current dir → ONE cheap slug scan → null
//   keepNonConversationItems — chatCtx rebuild keeps instructions, drops A's turns (4.13)
//   recoverySessionId      — auto-recovery resumes the switched-to session (4.3, D7)
//   warmParkKey            — keep-warm keys a primed-but-uninitialised session (4.3)
import assert from 'node:assert/strict'
import { resolveSessionCwd, keepNonConversationItems, recoverySessionId, warmParkKey, sessionMessagesDir, createSwitchGuard, scanSlugCwd, connectWorkingDir } from '../src/session-switch.js'
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
// REGRESSION (connect latency): the connect path awaits this, so a usable hint
// must cost ZERO lookups and a full miss exactly ONE — no room for a sweep.
await t('cwd: at most ONE cheap lookup — connect never awaits a full session-list sweep', async () => {
  let calls = 0
  const counted = (ret: string | null) => deps({ lookupCwd: async () => { calls++; return ret } })
  await resolveSessionCwd(B, '/w/proj-b', '/w/proj-a', counted(null))
  assert.equal(calls, 0, 'a hint that holds the session must not trigger any lookup')
  await resolveSessionCwd(B, '/w/nope', '/w/proj-a', counted('/w/proj-b'))
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
// decodeSlug = config.ts slugToPath ('' when the decode misses); readCwd = extractCwd.
const noCwd = async () => ''
await t('scanSlugCwd: decoded path that does not exist is not returned (no mkdir of scan paths)', async () => {
  const jsonl = (slug: string) => '/p/' + slug + '/' + B + '.jsonl'
  const fsx = {
    readdir: () => ['-w-projb', '-w-ghost'],
    exists: (p: string) => p === jsonl('-w-projb') || p === jsonl('-w-ghost') || p === '/p',
    decodeSlug: (s: string) => (s === '-w-projb' ? '/w/projb' : ''), readCwd: noCwd,
  }
  assert.equal(await scanSlugCwd(B, '/p', fsx), '/w/projb')
  assert.equal(await scanSlugCwd(B, '/p', { ...fsx, readdir: () => ['-w-ghost'] }), null)
  assert.equal(await scanSlugCwd(B, '/missing', { ...fsx, readdir: () => [], exists: () => false }), null)
})
await t('scanSlugCwd: lossy slug (project dir whose name contains "-") falls back to the JSONL cwd', async () => {
  // `-w-my-app` decodes to /w/my/app, which does not exist → slugToPath ''.
  // The one case the full session-list sweep recovered.
  const base = {
    readdir: () => ['-w-my-app'],
    exists: (p: string) => p === '/p' || p === '/p/-w-my-app/' + B + '.jsonl' || p === '/w/my-app',
    decodeSlug: () => '', readCwd: noCwd,
  }
  assert.equal(await scanSlugCwd(B, '/p', { ...base, readCwd: async () => '/w/my-app' }), '/w/my-app')
  assert.equal(await scanSlugCwd(B, '/p', base), null, 'no recorded cwd → null')
  assert.equal(await scanSlugCwd(B, '/p', { ...base, readCwd: async () => { throw new Error('unreadable') } }), null)
  // An imported session's JSONL can name ANOTHER machine's path, and
  // sessionExists only checks the slug — so the dir must exist to be returned.
  assert.equal(await scanSlugCwd(B, '/p', { ...base, readCwd: async () => '/Users/elsewhere/proj' }), null)
})

// #181: the slug decode is lossy, so the cwd the JSONL records must outrank it.
// `-w-my-app` decodes to /w/my/app; here that unrelated dir EXISTS.
const collide = (over: any = {}) => ({
  readdir: () => ['-w-my-app'],
  exists: (p: string) => ['/p', '/p/-w-my-app/' + B + '.jsonl', '/w/my-app', '/w/my/app'].includes(p),
  decodeSlug: (s: string) => (s === '-w-my-app' ? '/w/my/app' : ''),
  readCwd: async () => '/w/my-app',
  ...over,
})
await t('scanSlugCwd #181: dash-named project beats a colliding decoded dir that exists', async () => {
  assert.equal(await scanSlugCwd(B, '/p', collide()), '/w/my-app')
})
await t('scanSlugCwd #181: recorded dir deleted -> null, never the colliding decoded dir', async () => {
  const fsx = collide()
  assert.equal(await scanSlugCwd(B, '/p', { ...fsx, exists: (p: string) => p !== '/w/my-app' && fsx.exists(p) }), null)
})
await t('scanSlugCwd #181: imported session (recorded cwd from another machine) still uses the decode', async () => {
  assert.equal(await scanSlugCwd(B, '/p', collide({ readCwd: async () => '/Users/bob/my-app' })), '/w/my/app')
})
await t('scanSlugCwd #181: duplicate id in two slugs is order-independent and reads every copy', async () => {
  // Copy 1 (-a-gone) records a deleted dir; copy 2 (-b-live) is valid.
  const files = ['/p/-a-gone/' + B + '.jsonl', '/p/-b-live/' + B + '.jsonl']
  const rec: Record<string, string> = { [files[0]]: '/a/gone', [files[1]]: '/b/live' }
  const fsx = (order: string[]) => ({
    readdir: () => order,
    exists: (p: string) => p === '/p' || files.includes(p) || p === '/b/live',
    decodeSlug: () => '',
    readCwd: async (f: string) => rec[f],
  })
  assert.equal(await scanSlugCwd(B, '/p', fsx(['-a-gone', '-b-live'])), '/b/live')
  assert.equal(await scanSlugCwd(B, '/p', fsx(['-b-live', '-a-gone'])), '/b/live')
})
await t('scanSlugCwd #181: an id only under a -subagents slug is not resolved', async () => {
  const fsx = {
    readdir: () => ['-w-proj-subagents'],
    exists: (p: string) => p === '/p' || p === '/p/-w-proj-subagents/' + B + '.jsonl' || p === '/w/proj/subagents',
    decodeSlug: () => '/w/proj/subagents',
    readCwd: async () => '/w/proj/subagents',
  }
  assert.equal(await scanSlugCwd(B, '/p', fsx), null)
})
await t('resolveSessionCwd #181: a hint/current dir that only matches through the lossy slug loses to the recorded cwd', async () => {
  const d = {
    exists: (id: string, wd: string) => id === B && (wd === '/w/my-app' || wd === '/w/my/app'),
    recordedCwd: async () => '/w/my-app',
    lookupCwd: async () => '/w/my-app',
  }
  assert.equal(await resolveSessionCwd(B, '/w/my/app', '/w/x', d), '/w/my-app')
  assert.equal(await resolveSessionCwd(B, undefined, '/w/my/app', d), '/w/my-app')
  assert.equal(await resolveSessionCwd(B, '/w/my-app', '/w/x', d), '/w/my-app')
  // Imported session: recorded cwd encodes to another slug, so the hint stands.
  assert.equal(await resolveSessionCwd(B, '/w/my/app', '/w/x', { ...d, recordedCwd: async () => '/Users/bob/proj' }), '/w/my/app')
})
await t('config.ts: session list routes by the recorded cwd when it encodes to the slug', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/config.ts'), 'utf8')
  assert.ok(/cwd: \(cwd && projectPathToClaudeFolderName\(cwd\) === c\.slug \? cwd : ''\) \|\| slugPath \|\| cwd/.test(src))
})

// #183: never create a hint for a session that did not resolve, or a hint that
// is not a plausible path on this machine.
const dirs = new Set(['/', '/workspace', '/workspace/old', '/home', '/home/sprite'])
const has = (p: string) => dirs.has(p)
await t('connectWorkingDir #183: resolved dir wins and is never created', () => {
  assert.deepEqual(connectWorkingDir('/workspace/old', '/x/y', B, '/workspace', has), { dir: '/workspace/old', create: false })
})
await t('connectWorkingDir #183: an existing hint is used as-is', () => {
  assert.deepEqual(connectWorkingDir(null, '/workspace/old', B, '/workspace', has), { dir: '/workspace/old', create: false })
})
await t('connectWorkingDir #183: a missing hint for an unresolved session falls back, not mkdir', () => {
  assert.deepEqual(connectWorkingDir(null, '/workspace/typo', B, '/workspace', has), { dir: '/workspace', create: false })
})
await t('connectWorkingDir #183: a new project (no session id) under an existing parent is created', () => {
  assert.deepEqual(connectWorkingDir(null, '/workspace/new-app', null, '/workspace', has), { dir: '/workspace/new-app', create: true })
})
await t('connectWorkingDir #183: junk hints are never created', () => {
  for (const h of ['/Users/bob/proj', 'relative/dir', '/workspace/../etc/x', '/workspace/./x', '/workspace/a/b']) {
    assert.deepEqual(connectWorkingDir(null, h, null, '/workspace', has), { dir: '/workspace', create: false }, h)
  }
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
