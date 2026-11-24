import assert from 'node:assert'
import { formatTurnTiming, markTranscript, markChat, markPush, markHookDone } from '../src/turn-timing.ts'

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

// A non-hub ClaudeLLM (background slot) must never touch the process-wide marks.
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/claude-llm.ts', import.meta.url), 'utf8')
  const calls = src.split('\n').filter((l) => /\b(markPush|markHookDone)\(/.test(l) && !l.includes('import'))
  assert.ok(calls.length >= 4)
  for (const l of calls) assert.ok(l.includes('turnTiming'), `ungated mark call: ${l.trim()}`)
  const wrap = readFileSync(new URL('../src/pipeline-direct-llm.ts', import.meta.url), 'utf8')
  assert.ok(wrap.includes('turnTiming: true'))
}
