import assert from 'node:assert'
import { formatTurnTiming, markTranscript, markChat, markPush, markHookDone } from '../src/turn-timing.js'

const line = formatTurnTiming({ speechAt: 1000, finalAt: 1400, chatAt: 2000, pushAt: 2300, deferredMs: 250, hookMs: 120, replayAt: 1200 }, 3)
assert.ok(line.startsWith('[turn-timing] '))
const j = JSON.parse(line.slice('[turn-timing] '.length))
assert.deepStrictEqual(j, { turn: 3, speechToFinal: 400, finalToChat: 600, speechToChat: 1000, chatToPush: 300, deferredWait: 250, hook: 120, speechToPush: 1300, replayBeforeChat: true })

const far = JSON.parse(formatTurnTiming({ chatAt: 9000, replayAt: 5000 }, 1).slice(14))
assert.strictEqual(far.replayBeforeChat, false)
assert.strictEqual(far.speechToChat, null)
assert.strictEqual(far.hook, null)
assert.strictEqual(far.deferredWait, 0)
// replay after chat does not count
assert.strictEqual(JSON.parse(formatTurnTiming({ chatAt: 100, replayAt: 200 }, 1).slice(14)).replayBeforeChat, false)

// The real sequence: interims then a final; the final must not move the speech mark.
const logged: string[] = []
const orig = console.log
console.log = (...a: unknown[]) => { logged.push(a.join(' ')) }
try {
  markTranscript(false, 1000); markTranscript(false, 1500); markTranscript(true, 1900)
  markChat(2100); markPush(40, 2200); markHookDone(15)
  markHookDone(5) // no chat since the last line: nothing logged
} finally { console.log = orig }
assert.strictEqual(logged.length, 1)
const seq = JSON.parse(logged[0].slice(14))
assert.strictEqual(seq.speechToFinal, 400)
assert.strictEqual(seq.finalToChat, 200)
assert.strictEqual(seq.speechToChat, 600)
assert.strictEqual(seq.chatToPush, 100)
assert.strictEqual(seq.deferredWait, 40)
assert.strictEqual(seq.hook, 15)
console.log('turn-timing ok')

// Behaviour through the real pushMessage (fake SDK query): only a ClaudeLLM built with turnTiming
// (the hub, via PipelineDirectLLM) marks the push; a background slot leaves the process-wide marks alone.
// Covers the cold start, the fast path and the resume rebuild (closes the idle session, then cold-starts).
// Not covered: the deferred post-interrupt push and the UserPromptSubmit hook mark (both need a live turn).
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'osb-turn-timing-'))
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
  const { ClaudeLLM } = await import('../src/claude-llm.js')
  const spawned: any[] = []
  const queryFn = () => {
    const queue: any[] = []; let wake: (() => void) | null = null
    const q: any = { closed: false, emit(m: any) { queue.push(m); wake?.(); wake = null }, close() { q.closed = true; wake?.(); wake = null },
      async *[Symbol.asyncIterator]() { while (true) { if (queue.length) { yield queue.shift(); continue } if (q.closed) return; await new Promise<void>((r) => { wake = r }) } } }
    spawned.push(q); return q
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))
  // chatToPush of one turn whose push is `run`: null means the push was not marked.
  async function chatToPush(run: () => void | Promise<void>): Promise<number | null> {
    const lines: string[] = []
    console.log = (...a: unknown[]) => { const s = a.join(' '); if (s.startsWith('[turn-timing] ')) lines.push(s) }
    try { markChat(); await run(); markHookDone(0) } finally { console.log = orig }
    assert.strictEqual(lines.length, 1)
    return JSON.parse(lines[0].slice(14)).chatToPush
  }
  async function idleOn(llm: any, id: string) {
    const q = spawned[spawned.length - 1]
    q.emit({ type: 'system', subtype: 'init', session_id: id }); q.emit({ type: 'result', result: 'ok' })
    for (let i = 0; i < 50 && !llm.busyState().idle; i++) await tick()
    assert.ok(llm.busyState().idle)
  }
  const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
  for (const hub of [false, true]) {
    const llm: any = new ClaudeLLM({ workingDirectory: home, queryFn: queryFn as any, ...(hub ? { turnTiming: true } : {}) })
    const cb = { onSessionId: () => {}, onCheckpoint: () => {}, eventEmitter: llm.events }
    const expect = (v: number | null, path: string) => assert.ok(hub ? v !== null : v === null, `${hub ? 'hub' : 'slot'} ${path}: chatToPush=${v}`)
    expect(await chatToPush(() => llm.pushMessage('first', { resume: A } as any, cb)), 'cold start')
    await idleOn(llm, A)
    expect(await chatToPush(() => llm.pushMessage('next', { resume: A } as any, cb)), 'fast path')
    await idleOn(llm, A)
    llm.setResumeSessionId(B)
    const before = spawned.length
    expect(await chatToPush(() => llm.pushMessage('switch', { resume: B } as any, cb)), 'resume rebuild')
    assert.strictEqual(spawned.length, before + 1, 'resume rebuild cold-started')
    llm.closeSession()
  }
  const wrap = (await import('node:fs')).readFileSync(new URL('../src/pipeline-direct-llm.ts', import.meta.url), 'utf8')
  assert.ok(wrap.includes('turnTiming: true'))
}
console.log('turn-timing gating ok')
