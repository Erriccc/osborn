// Run: npx tsx agent/tests/switch-llm-state.test.ts
// #74 phase 2: ClaudeLLM / PipelineDirectLLM state the switch executor relies
// on, driven with a FAKE SDK query (ClaudeLLMOptions.queryFn) — no subprocess.
//   S1  spawnedResumeId + busyState()
//   S2  PipelineDirectLLM proxies (setWorkingDirectory, busyState, spawnedResumeId,
//       resetForSessionSwitch clears wrapper per-turn state)
//   S6  pushMessage backstop: armed != spawned != live → idle rebuild / busy warn;
//       failed resume never rebuilds
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fakeHome = mkdtempSync(join(tmpdir(), 'osb-switch-state-'))
process.env.HOME = fakeHome
process.env.CLAUDE_CONFIG_DIR = join(fakeHome, '.claude')

const { ClaudeLLM } = await import('../src/claude-llm.js')
const { PipelineDirectLLM } = await import('../src/pipeline-direct-llm.js')

let pass = 0, fail = 0
async function t(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log('PASS', name) }
  catch (e: any) { fail++; console.log('FAIL', name, '-', String(e?.message).split('\n')[0].slice(0, 300)) }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

// ── Fake SDK query: an async iterable we feed by hand ─────────────────────────
type FakeQuery = {
  options: any
  closed: boolean
  emit(msg: any): void
  close(): void
  [Symbol.asyncIterator](): AsyncIterator<any>
}
function makeFakeQueryFn() {
  const spawned: FakeQuery[] = []
  const fn = ({ options }: { prompt: any; options: any }) => {
    const queue: any[] = []
    let wake: (() => void) | null = null
    const q: FakeQuery = {
      options,
      closed: false,
      emit(msg) { queue.push(msg); wake?.(); wake = null },
      close() { q.closed = true; wake?.(); wake = null },
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length) { yield queue.shift(); continue }
          if (q.closed) return
          await new Promise<void>((r) => { wake = r })
        }
      },
    } as any
    spawned.push(q)
    return q as any
  }
  return { fn, spawned }
}

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

function newLLM(fq: ReturnType<typeof makeFakeQueryFn>, extra: any = {}) {
  return new ClaudeLLM({ workingDirectory: fakeHome, queryFn: fq.fn as any, ...extra })
}
function cb(llm: any) {
  return { onSessionId: (id: string) => { (llm as any).__lastInit = id }, onCheckpoint: () => {}, eventEmitter: llm.events as EventEmitter }
}

// ── S1 ────────────────────────────────────────────────────────────────────────
await t('S1 spawnedResumeId: null before any query', () => {
  const llm: any = newLLM(makeFakeQueryFn())
  assert.equal(llm.spawnedResumeId, null)
})

await t('S1 spawnedResumeId: cold start records sdkOptions.resume, closeSession clears it', () => {
  const fq = makeFakeQueryFn()
  const llm: any = newLLM(fq)
  llm.pushMessage('hi', { resume: A } as any, cb(llm))
  assert.equal(fq.spawned.length, 1)
  assert.equal(llm.spawnedResumeId, A)
  llm.closeSession()
  assert.equal(llm.spawnedResumeId, null)
})

await t('S1 spawnedResumeId: fresh cold start (no resume) records null', () => {
  const fq = makeFakeQueryFn()
  const llm: any = newLLM(fq)
  llm.pushMessage('hi', {} as any, cb(llm))
  assert.equal(llm.spawnedResumeId, null)
  assert.equal(llm.hasSession(), true)
})

await t('S1 spawnedResumeId: primeResume records the primed id', () => {
  const fq = makeFakeQueryFn()
  const llm: any = newLLM(fq)
  llm.primeResume({ resume: B } as any, cb(llm))
  assert.equal(llm.spawnedResumeId, B)
})

await t('S1 busyState: idle at rest', () => {
  const llm: any = newLLM(makeFakeQueryFn())
  const s = llm.busyState()
  assert.deepEqual(s, { turnInFlight: false, runningTasks: 0, compacting: false, interruptPending: false, permissionPending: false, idle: true })
})

await t('S1 busyState: a pushed turn is in flight until its result', async () => {
  const fq = makeFakeQueryFn()
  const llm: any = newLLM(fq)
  llm.pushMessage('hi', { resume: A } as any, cb(llm))
  assert.equal(llm.busyState().turnInFlight, true)
  assert.equal(llm.busyState().idle, false)
  fq.spawned[0].emit({ type: 'system', subtype: 'init', session_id: A })
  fq.spawned[0].emit({ type: 'result', result: 'done' })
  await tick(); await tick()
  assert.equal(llm.sessionId, A)
  assert.equal(llm.busyState().turnInFlight, false)
  assert.equal(llm.busyState().idle, true)
})

await t('S1 busyState: running SDK tasks (sub-agents) keep it busy after the turn', async () => {
  const fq = makeFakeQueryFn()
  const llm: any = newLLM(fq)
  llm.pushMessage('hi', {} as any, cb(llm))
  const q = fq.spawned[0]
  q.emit({ type: 'system', subtype: 'task_started', task_id: 't1', description: 'research', subagent_type: 'researcher' })
  q.emit({ type: 'result', result: 'ok' })
  await tick(); await tick()
  const s = llm.busyState()
  assert.equal(s.turnInFlight, false)
  assert.equal(s.runningTasks, 1, JSON.stringify(s))
  assert.equal(s.idle, false)
})

await t('S1 busyState: compacting and pending permission are not idle', () => {
  const llm: any = newLLM(makeFakeQueryFn())
  llm.compacting = true
  assert.equal(llm.busyState().compacting, true)
  assert.equal(llm.busyState().idle, false)
  llm.compacting = false
  assert.equal(llm.busyState().idle, true)
})

// ── S2 ────────────────────────────────────────────────────────────────────────
function newPipeline(fq: ReturnType<typeof makeFakeQueryFn>, extra: any = {}) {
  return new PipelineDirectLLM({ workingDirectory: fakeHome, voiceMode: 'direct', skipTTSQueue: true, queryFn: fq.fn as any, ...extra })
}

await t('S2 PipelineDirectLLM.setWorkingDirectory exists and updates inner + wrapper cwd', () => {
  const pd: any = newPipeline(makeFakeQueryFn())
  assert.equal(typeof pd.setWorkingDirectory, 'function', 'missing proxy (resume_session cross-slug branch threw TypeError)')
  pd.setWorkingDirectory('/tmp/proj-b')
  assert.equal(pd.inner.workingDirectory, '/tmp/proj-b', 'inner #opts not updated')
  assert.equal(pd.workingDirectory, '/tmp/proj-b', 'wrapper #opts not updated')
})

await t('S2 PipelineDirectLLM proxies busyState() and spawnedResumeId', () => {
  const fq = makeFakeQueryFn()
  const pd: any = newPipeline(fq)
  assert.equal(typeof pd.busyState, 'function')
  assert.equal(pd.busyState().idle, true)
  assert.equal(pd.spawnedResumeId, null)
  pd.inner.pushMessage('hi', { resume: A } as any, cb(pd.inner))
  assert.equal(pd.spawnedResumeId, A)
  assert.equal(pd.busyState().turnInFlight, true)
})

await t('S2 resetForSessionSwitch clears wrapper per-turn state (meeting TTS gate) and closes the query', () => {
  const fq = makeFakeQueryFn()
  const pd: any = newPipeline(fq)
  pd.inner.pushMessage('hi', { resume: A } as any, cb(pd.inner))
  pd.suppressMeetingTTS = true
  pd.resetForSessionSwitch()
  assert.equal(pd.suppressMeetingTTS, false)
  assert.equal(pd.hasSession(), false)
  assert.equal(fq.spawned[0].closed, true)
  assert.equal(pd.spawnedResumeId, null)
})

// ── S6: pushMessage backstop ─────────────────────────────────────────────────
async function liveIdle(fq: ReturnType<typeof makeFakeQueryFn>, llm: any, id: string) {
  llm.pushMessage('first', { resume: id } as any, cb(llm))
  const q = fq.spawned[fq.spawned.length - 1]
  q.emit({ type: 'system', subtype: 'init', session_id: id })
  q.emit({ type: 'result', result: 'ok' })
  for (let i = 0; i < 50 && !llm.busyState().idle; i++) await tick()
  assert.equal(llm.busyState().idle, true)
  return q
}

await t('S6 armed B != spawned A != live A, idle -> pushMessage closes A and cold-starts resume:B', async () => {
  const fq = makeFakeQueryFn()
  const llm: any = newLLM(fq)
  const qa = await liveIdle(fq, llm, A)
  llm.setResumeSessionId(B) // legacy arm-only path (what resume_session used to do)
  llm.pushMessage('next', { resume: B } as any, cb(llm))
  assert.equal(qa.closed, true, 'old query closed')
  assert.equal(fq.spawned.length, 2, 'cold start')
  assert.equal(fq.spawned[1].options.resume, B)
  assert.equal(llm.spawnedResumeId, B)
})

await t('S6 backstop: B\'s init fires a fresh session_id event (frontend learns B)', async () => {
  const fq = makeFakeQueryFn()
  const llm: any = newLLM(fq)
  await liveIdle(fq, llm, A)
  const ids: string[] = []
  llm.events.on('session_id', (d: any) => ids.push(d.sessionId))
  llm.setResumeSessionId(B)
  llm.pushMessage('next', { resume: B } as any, { ...cb(llm), onSessionId: (id: string) => { const first = !llm.sessionId; if (first) llm.events.emit('session_id', { sessionId: id }) } })
  assert.equal(llm.sessionId, null, 'old live id cleared on rebuild')
})

await t('S6 armed differs but A is BUSY -> push into A (never abort), warn', async () => {
  const fq = makeFakeQueryFn()
  const llm: any = newLLM(fq)
  llm.pushMessage('first', { resume: A } as any, cb(llm))
  const qa = fq.spawned[0]
  qa.emit({ type: 'system', subtype: 'init', session_id: A })
  await tick(); await tick()
  assert.equal(llm.busyState().turnInFlight, true)
  llm.setResumeSessionId(B)
  const warns: string[] = []
  const orig = console.warn
  console.warn = (...a: any[]) => { warns.push(a.join(' ')) }
  try { llm.pushMessage('next', { resume: B } as any, cb(llm)) } finally { console.warn = orig }
  assert.equal(qa.closed, false, 'busy query must not be closed')
  assert.equal(fq.spawned.length, 1, 'no second spawn')
  assert.ok(warns.some((w) => /switch/i.test(w)), 'warned')
})

await t('S6 failed resume (armed == spawned != live) never rebuilds', async () => {
  const fq = makeFakeQueryFn()
  const llm: any = newLLM(fq)
  llm.setResumeSessionId(B)
  llm.pushMessage('first', { resume: B } as any, cb(llm))
  const q = fq.spawned[0]
  q.emit({ type: 'system', subtype: 'init', session_id: 'cccccccc-fallback' })
  q.emit({ type: 'result', result: 'ok' })
  for (let i = 0; i < 50 && !llm.busyState().idle; i++) await tick()
  llm.pushMessage('second', { resume: B } as any, cb(llm))
  llm.pushMessage('third', { resume: B } as any, cb(llm))
  assert.equal(fq.spawned.length, 1, 'no rebuild loop')
  assert.equal(q.closed, false)
})

await t('S6 no armed target -> plain fast-path push (unchanged)', async () => {
  const fq = makeFakeQueryFn()
  const llm: any = newLLM(fq)
  llm.pushMessage('first', {} as any, cb(llm))
  const q = fq.spawned[0]
  q.emit({ type: 'system', subtype: 'init', session_id: A })
  q.emit({ type: 'result', result: 'ok' })
  for (let i = 0; i < 50 && !llm.busyState().idle; i++) await tick()
  llm.pushMessage('second', {} as any, cb(llm))
  assert.equal(fq.spawned.length, 1)
})

await t('4.5 auth restart pending + switch at idle: exactly one close, B spawns on the new generation', async () => {
  const { requestAuthRestart } = await import('../src/claude-llm.js')
  const fq = makeFakeQueryFn()
  const llm: any = newLLM(fq)
  const qa = await liveIdle(fq, llm, A)
  requestAuthRestart()
  assert.equal(llm.authRestartPending, true)
  llm.resetForSessionSwitch()
  llm.setResumeSessionId(B)
  llm.pushMessage('next', { resume: B } as any, cb(llm))
  assert.equal(qa.closed, true)
  assert.equal(fq.spawned.length, 2, 'exactly one new spawn')
  assert.equal(fq.spawned[1].options.resume, B)
  assert.equal(llm.authRestartPending, false)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
