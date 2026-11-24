import assert from 'node:assert'
import { formatTurnTiming } from '../src/turn-timing.ts'

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
console.log('turn-timing ok')
