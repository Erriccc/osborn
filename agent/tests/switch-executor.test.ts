// Run: npx tsx agent/tests/switch-executor.test.ts
// #74 phase 2 — §6.1 unit regressions for the switch executor path, driving the
// REAL chat() → run() → pushMessage path against a fake SDK query (queryFn).
//   4.1  idle switch A→B: the next turn cold-starts with resume:B; no session_resume_failed
//   4.1  cross-project: sdkOptions.cwd is B's cwd after setWorkingDirectory
//   4.8  forced switch with a pending permission denies it; a late watch approve is a no-op
//   4.17 executor resets (source-anchored: index.ts closures)
//   S5/S4 wiring: switch_session / legacy handlers route through requestSessionSwitch
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fakeHome = mkdtempSync(join(tmpdir(), 'osb-switch-exec-'))
process.env.HOME = fakeHome
process.env.CLAUDE_CONFIG_DIR = join(fakeHome, '.claude')

const { PipelineDirectLLM } = await import('../src/pipeline-direct-llm.js')
const { llm, initializeLogger } = await import('@livekit/agents')
initializeLogger({ pretty: false, level: 'warn' })

let pass = 0, fail = 0
async function t(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log('PASS', name) }
  catch (e: any) { fail++; console.log('FAIL', name, '-', String(e?.message).split('\n')[0].slice(0, 300)) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 4000) {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error('timeout waiting for condition'); await sleep(10) }
}

function makeFakeQueryFn() {
  const spawned: any[] = []
  const fn = ({ options }: { prompt: any; options: any }) => {
    const queue: any[] = []
    let wake: (() => void) | null = null
    const q: any = {
      options, closed: false,
      emit(msg: any) { queue.push(msg); wake?.(); wake = null },
      close() { q.closed = true; wake?.(); wake = null },
      interrupt: async () => {},
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length) { yield queue.shift(); continue }
          if (q.closed) return
          await new Promise<void>((r) => { wake = r })
        }
      },
    }
    spawned.push(q)
    return q
  }
  return { fn, spawned }
}

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

function turn(pd: any, text: string) {
  const ctx = new llm.ChatContext()
  ctx.addMessage({ role: 'user', content: text })
  const stream = pd.chat({ chatCtx: ctx })
  ;(async () => { try { for await (const _ of stream) { /* drain */ } } catch { /* aborted */ } })()
}

// Mirrors performSessionSwitch steps 4-6 on the LLM (the index.ts closure parts
// are anchored separately below).
function executeSwitch(pd: any, target: string, cwd?: string) {
  pd.resetForSessionSwitch()
  if (cwd) pd.setWorkingDirectory(cwd)
  pd.setResumeSessionId(target)
}

await t('4.1 idle switch A→B: next turn cold-starts resume:B, no session_resume_failed', async () => {
  const fq = makeFakeQueryFn()
  const pd: any = new PipelineDirectLLM({ workingDirectory: fakeHome, voiceMode: 'direct', skipTTSQueue: true, resumeSessionId: A, queryFn: fq.fn as any })
  const failures: any[] = []
  pd.events.on('session_resume_failed', (d: any) => failures.push(d))
  turn(pd, 'first')
  await until(() => fq.spawned.length === 1)
  assert.equal(fq.spawned[0].options.resume, A)
  fq.spawned[0].emit({ type: 'system', subtype: 'init', session_id: A })
  fq.spawned[0].emit({ type: 'result', result: 'ok' })
  await until(() => pd.sessionId === A && pd.busyState().idle)

  executeSwitch(pd, B)
  assert.equal(fq.spawned[0].closed, true, 'A closed (it was idle)')
  turn(pd, 'second')
  await until(() => fq.spawned.length === 2)
  assert.equal(fq.spawned[1].options.resume, B, 'cold start resumes B')
  fq.spawned[1].emit({ type: 'system', subtype: 'init', session_id: B })
  fq.spawned[1].emit({ type: 'result', result: 'ok' })
  await until(() => pd.sessionId === B)
  assert.deepEqual(failures, [], 'no session_resume_failed')
})

await t('4.1 cross-project switch: B cold-starts with B\'s cwd', async () => {
  const fq = makeFakeQueryFn()
  const projB = mkdtempSync(join(tmpdir(), 'osb-proj-b-'))
  const pd: any = new PipelineDirectLLM({ workingDirectory: fakeHome, voiceMode: 'direct', skipTTSQueue: true, queryFn: fq.fn as any })
  executeSwitch(pd, B, projB)
  turn(pd, 'hello B')
  await until(() => fq.spawned.length === 1)
  assert.equal(fq.spawned[0].options.resume, B)
  assert.equal(fq.spawned[0].options.cwd, projB)
})

await t('4.8 forced switch denies a pending permission; a late watch approve finds nothing pending', async () => {
  const fq = makeFakeQueryFn()
  const pd: any = new PipelineDirectLLM({ workingDirectory: fakeHome, voiceMode: 'direct', skipTTSQueue: true, queryFn: fq.fn as any })
  turn(pd, 'run something')
  await until(() => fq.spawned.length === 1)
  const canUseTool = fq.spawned[0].options.canUseTool
  assert.equal(typeof canUseTool, 'function')
  const decision = canUseTool('Bash', { command: 'rm -rf /tmp/x' }, { signal: new AbortController().signal, suggestions: [] })
  await until(() => pd.hasPendingPermission())
  assert.equal(pd.busyState().permissionPending, true)
  executeSwitch(pd, B) // forced: the reset denies it
  const r = await decision
  assert.equal(r.behavior, 'deny')
  assert.equal(pd.hasPendingPermission(), false, 'watch handler logs "no pending permission, ignoring"')
})

await t('4.2 THE LIVE LOG SEQUENCE: resume armed B while A is live+idle -> next turn runs in B, no session_resume_failed', async () => {
  const fq = makeFakeQueryFn()
  const pd: any = new PipelineDirectLLM({ workingDirectory: fakeHome, voiceMode: 'direct', skipTTSQueue: true, resumeSessionId: A, queryFn: fq.fn as any })
  const failures: any[] = []
  pd.events.on('session_resume_failed', (d: any) => failures.push(d))
  turn(pd, 'first')
  await until(() => fq.spawned.length === 1)
  fq.spawned[0].emit({ type: 'system', subtype: 'init', session_id: A })
  fq.spawned[0].emit({ type: 'result', result: 'ok' })
  await until(() => pd.sessionId === A && pd.busyState().idle)
  // Exactly what the old resume_session did: arm only (session_resume_set).
  pd.setResumeSessionId(B)
  turn(pd, 'second')
  await until(() => fq.spawned.length === 2)
  assert.equal(fq.spawned[0].closed, true)
  assert.equal(fq.spawned[1].options.resume, B)
  fq.spawned[1].emit({ type: 'system', subtype: 'init', session_id: B })
  fq.spawned[1].emit({ type: 'result', result: 'ok' })
  await until(() => pd.sessionId === B)
  assert.deepEqual(failures, [], 'session_resume_failed must never fire for this sequence')
})

// ── index.ts wiring (closures; source-anchored) ──────────────────────────────
const src = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
function body(fnStart: string, len = 9000) {
  const i = src.indexOf(fnStart)
  assert.ok(i >= 0, `missing: ${fnStart}`)
  return src.slice(i, i + len)
}

await t('S4 switch_session routes through requestSessionSwitch with cwd hint + force', () => {
  const b = body("data.type === 'switch_session'", 1200)
  assert.ok(/requestSessionSwitch\(sessionId, hint, \{ force: !!data\.force/.test(b))
  assert.ok(!/resetForSessionSwitch\(\)/.test(b.split("data.type === 'cancel_session_switch'")[0]), 'handler must not reset directly')
})

await t('S4 performSessionSwitch: resets in the scoped order (4.17)', () => {
  const b = body('async function performSessionSwitch(')
  const order = [
    'plan.stopSlotFirst',
    'voiceQueue.length = 0',
    'lastInterruption = null',
    'statusManager.upsertDispatch',
    'currentLLM.resetForSessionSwitch()',
    'setWorkingDirectory?.(cwd)',
    'currentLLM.setResumeSessionId(target)',
    'sessionAlwaysAllowPaths = new Set',
    'ensureSessionWorkspace(cwd, target)',
    'keepNonConversationItems(',
    'stopReadyRetries?.()',
    "type: 'session_switched'",
    'prewarmResume',
  ]
  let at = 0
  for (const needle of order) {
    const j = b.indexOf(needle, at)
    assert.ok(j >= 0, `missing or out of order: ${needle}`)
    at = j
  }
})

await t('S4 requestSessionSwitch uses the pure decider + plan with demoteSupported:false', () => {
  const b = body('async function requestSessionSwitch(')
  assert.ok(/decideNextSession\(/.test(b) && /planSwitch\(/.test(b))
  assert.ok(/demoteSupported: false/.test(b))
  assert.ok(/meetingActive: !!activeMeetingBotId/.test(b))
  assert.ok(/session_switch_pending/.test(b))
})

await t('S4 a pending switch is cancelled on disconnect, room destroy and meeting end', () => {
  for (const anchor of ['const handleParticipantDisconnected', 'const destroyRoomSession = async', 'const endMeeting = async']) {
    assert.ok(/cancelPendingSwitch\(/.test(body(anchor, 700)), anchor)
  }
})

// ── S5: legacy entry points + controller gate ────────────────────────────────
const { checkControlSender, CONTROL_MESSAGE_TYPES } = await import('../src/data-sender-auth.js')

await t('4.9 cancel_session_switch / switch_session are controller-only', () => {
  assert.ok(CONTROL_MESSAGE_TYPES.has('cancel_session_switch'), 'listed in CONTROL_MESSAGE_TYPES')
  for (const type of ['cancel_session_switch', 'switch_session']) {
    assert.equal(checkControlSender(type, 'user-ctrl', 'user-ctrl').ok, true)
    assert.equal(checkControlSender(type, 'user-other', 'user-ctrl').ok, false, `${type} from non-controller user`)
    assert.equal(checkControlSender(type, 'osborn-agent', 'user-ctrl').ok, false, `${type} from osborn-agent`)
  }
})

for (const handler of ["data.type === 'resume_session'", "data.type === 'continue_session'", "data.type === 'session_selected'"]) {
  await t(`S5 ${handler.split("'")[1]}: switches only when a live query runs another session`, () => {
    const b = body(handler, 1500)
    assert.ok(/liveSwitchNeeded\(/.test(b), 'must consult liveSwitchNeeded')
    assert.ok(/requestSessionSwitch\(/.test(b), 'must route a live switch through requestSessionSwitch')
  })
}

await t('S5 liveSwitchNeeded: no live query -> legacy arm-only; same session (primed) -> legacy; other -> switch', () => {
  const b = body('function liveSwitchNeeded(', 1200)
  assert.ok(/hasSession\?\.\(\)/.test(b))
  assert.ok(/decideNextSession\(/.test(b))
  assert.ok(/action === 'switch'/.test(b))
})

// ── S7: reconnect / recovery ids ─────────────────────────────────────────────
await t('S7 auto-recovery resumes the switched-to session (pickRecoverySessionId)', () => {
  const b = body('const recoverySessionId = ', 400)
  assert.ok(/pickRecoverySessionId\(\{ liveSessionId: currentLLM\?\.sessionId, switchedTo: currentResumeSessionId, connectTime: resumeSessionId \}\)/.test(b), b.slice(0, 200))
})
await t('S7 keep-warm parks a primed-but-uninitialised session (warmParkKey)', () => {
  const b = body('const parkWarm = (reason: string)', 600)
  assert.ok(/warmParkKey\(currentLLM/.test(b))
})
await t('S7 current_session carries workingDirectory; first session_id adopts a fresh session id', () => {
  const b = body("directLLM.events.on('session_id'", 900)
  assert.ok(/workingDirectory: workingDir/.test(b))
  assert.ok(/if \(!currentResumeSessionId\) currentResumeSessionId = sessionId/.test(b))
})

// ── 4.13 / 4.14 ──
const { keepNonConversationItems } = await import('../src/session-switch.js')
await t('4.13 chatCtx rebuild on a REAL ChatContext keeps instructions, drops A\'s turns', () => {
  const ctx = new llm.ChatContext()
  ctx.addMessage({ role: 'system', content: 'You are Osborn.' })
  ctx.addMessage({ role: 'user', content: 'A: fix the login bug' })
  ctx.addMessage({ role: 'assistant', content: 'A: on it' })
  const c = ctx.copy()
  c.items = keepNonConversationItems(c.items as any) as any
  const roles = c.items.map((i: any) => i.role)
  assert.deepEqual(roles, ['system'])
  assert.equal((c.items[0] as any).textContent, 'You are Osborn.')
  // What getChatHistory() reads after the rebuild: no user/assistant turns.
  assert.equal(c.items.filter((i: any) => i.type === 'message' && (i.role === 'user' || i.role === 'assistant')).length, 0)
})
await t('4.14 housekeeping protects the switched-to session (sessionId ?? currentResumeSessionId)', () => {
  const b = body('const runHousekeeping = () => {', 600)
  assert.ok(/const activeSessionId = currentLLM\?\.sessionId \?\? currentResumeSessionId \?\? null/.test(b))
  // performSessionSwitch arms currentResumeSessionId = target before B has an init id.
  assert.ok(/currentResumeSessionId = target/.test(body('async function performSessionSwitch(')))
})

await t('4.15 an oversized session_switched is resent without its history (50KB cap), so the rail still moves', () => {
  const b = body('async function performSessionSwitch(')
  assert.ok(/await sendToFrontend\(\{ \.\.\.switched, summary, conversationHistory \}\)\s*\|\|\s*await sendToFrontend\(switched\)/.test(b))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
