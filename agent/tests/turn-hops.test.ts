// Run: npx tsx agent/tests/turn-hops.test.ts
import assert from 'node:assert/strict'
const { markUserState, markTranscript, markChat, markPush, markHookDone, markSay, markAudio } = await import('../src/turn-timing.js')

const lines: string[] = []
const orig = console.log
console.log = (...a: unknown[]) => { lines.push(a.join(' ')) }
markUserState(true, 1000)
markUserState(false, 1500)
markUserState(true, 1600)  // a flap inside one utterance
markUserState(false, 3000)
markTranscript(false, 2900)
markTranscript(true, 3400)
markChat(3600)
markPush(0, 3650)
markSay(4000)  // before the turn line: ignored
markHookDone(20)
markSay(4500)
markSay(4600)  // once per turn
markAudio(4900)
markAudio(5000)  // once per turn
// Turn 2: the user starts again before turn 2's hook finishes; that onset belongs to turn 3.
markUserState(true, 6000)
markUserState(false, 6500)
markChat(6700)
markUserState(true, 6800)
markHookDone(10)
markUserState(false, 7300)
markChat(7500)
markHookDone(10)
console.log = orig

const turn = JSON.parse(lines.find((l) => l.startsWith('[turn-timing] '))!.slice('[turn-timing] '.length))
assert.equal(turn.onsetToStop, 1400)  // the last onset: a flap restarts it
assert.equal(turn.stopToFinal, 400)
assert.equal(turn.stopToChat, 600)
const turns = lines.filter((l) => l.startsWith('[turn-timing] ')).map((l) => JSON.parse(l.slice('[turn-timing] '.length)))
assert.equal(turns[2].onsetToStop, 500)  // onset after turn 2's chat carried into turn 3
const out = lines.filter((l) => l.startsWith('[turn-timing-out]')).map((l) => JSON.parse(l.slice('[turn-timing-out] '.length)))
assert.equal(out.length, 2)
assert.deepEqual(out[0], { turn: 1, stage: 'say', chatToSay: 900, stopToSay: 1500 })
assert.deepEqual(out[1], { turn: 1, stage: 'audio', sayToAudio: 400, stopToAudio: 1900, finalToAudio: 1500 })
console.log('turn-hops: ok')
