// Library on session end: npx tsx agent/tests/library-session-end.test.ts
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tmp = mkdtempSync(join(tmpdir(), 'library-session-end-'))
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude')
delete process.env.OPENROUTER_API_KEY
delete process.env.OSBORN_CONTENT_LENS
delete process.env.OSBORN_SYNC_TOKEN
const { launchLibraryOnSessionEnd, lastLibraryRun, launchCompactionLens, sessionEndRetry, librarySweepHealth } =
  await import('../src/content/lens-launch.js')
const { acquireLock, releaseLock, libraryHomeDir, readSweepStatus, LOCK_FILE } = await import('../src/content/lens-paths.js')

assert.equal(launchLibraryOnSessionEnd(null, '/w', 'disconnect'), null, 'no session, nothing to do')
const r = launchLibraryOnSessionEnd('abcdef12-0000-full-uuid', '/w', 'disconnect')!
assert.equal(r.status, 'no-key', 'a missing key is reported, not hidden')
assert.deepEqual({ s: lastLibraryRun()?.session, why: lastLibraryRun()?.reason }, { s: 'abcdef12', why: 'disconnect' }, 'only 8 chars of the id are kept (it is shown on public /health)')

// #269: every session-end call site keys the session the way keep-warm parking does (warmParkKey),
// so a primed / just-switched session (no SDK init id yet) still gets its launch.
const index = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf-8')
const calls = [...index.matchAll(/launchLibraryOnSessionEnd\(([^,]+),/g)].map(m => m[1].trim())
assert.ok(calls.length >= 3, 'all call sites found')
for (const a of calls) assert.ok(/^warmParkKey\(|^warmSessionId$/.test(a), `call site passes ${a}, not warmParkKey(...)`)
assert.ok(!/KEEP_WARM && currentLLM && \(currentLLM as any\)\.sessionId/.test(index), 'keep-warm gate uses warmParkKey too')

// A real project with this session's transcript; the agent's cwd slugs to a different one.
process.env.OPENROUTER_API_KEY = 'dummy-not-a-key'
const sid = 'sessend-0000-1111'
const realProject = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-real-project')
mkdirSync(realProject, { recursive: true })
writeFileSync(join(realProject, `${sid}.jsonl`), '{}\n')
const wrongCwd = '/some/other/dir'

// #272: the lock is taken on the session's own project, not on slugDir(cwd).
assert.ok(acquireLock(realProject))
try {
  const l = launchCompactionLens({ sessionId: sid, cwd: wrongCwd, skipLens: true })
  assert.deepEqual([l.status, (l as any).projectDir], ['locked', realProject], 'resolved from the transcript, so the held lock is seen')
  assert.ok(!existsSync(join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-some-other-dir', LOCK_FILE)), 'no lock on the cwd project')
} finally { releaseLock(realProject) }

// #270: a spawned run stays visible after later failed attempts, and the worker's own outcome lands in the status file.
const spawned = launchLibraryOnSessionEnd(sid, wrongCwd, 'disconnect', [])!
assert.equal(spawned.status, 'spawned')
const deadline = Date.now() + 90_000
while (existsSync(join(realProject, LOCK_FILE)) && Date.now() < deadline) await new Promise(res => setTimeout(res, 250))
assert.ok(!existsSync(join(realProject, LOCK_FILE)), 'worker finished and released the lock')
for (let i = 0; i < 40 && existsSync(join(libraryHomeDir(), LOCK_FILE)); i++) await new Promise(res => setTimeout(res, 250))
const st = readSweepStatus()!
assert.equal(st.lastStep?.status, 'no-db', 'the step outcome (not just "spawned") is recorded') // no session.db in this fixture
assert.equal(st.lastStep?.session, sid.slice(0, 8))
assert.equal(st.status, 'done', 'the sweep ran after the step')

// #268: a launch that finds the project locked is retried (bounded), and the spawned record survives.
sessionEndRetry.delayMs = 30
sessionEndRetry.max = 2
assert.ok(acquireLock(realProject))
assert.ok(acquireLock(libraryHomeDir())) // keep the fallback sweep from spawning too
try {
  const locked = launchLibraryOnSessionEnd(sid, wrongCwd, 'session_switch', [])!
  assert.equal(locked.status, 'locked')
  const health = () => librarySweepHealth() as any
  assert.equal(health().pendingRetries, 1, "a retry is pending (a count: /health carries no ids)")
  assert.equal(health().lastSpawned?.status, 'spawned', 'not overwritten by the locked attempt')
  await new Promise(res => setTimeout(res, 300))
  assert.equal(lastLibraryRun()?.attempt, 2, 'retried up to the max')
  assert.equal(health().pendingRetries, 0, 'and then stops')
  const h = health()
  assert.equal(h.lastSpawned.status, 'spawned')
  assert.equal(h.lastStep.status, 'no-db')
} finally {
  releaseLock(realProject)
  releaseLock(libraryHomeDir())
}
console.log('library-session-end: all assertions passed')
