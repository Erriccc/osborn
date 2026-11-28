import assert from 'node:assert/strict'
import { SayPacer } from '../src/say-pacer.js'

const p = new SayPacer<{ text: string }>()
assert.equal(p.ready(0, 0), false, 'empty queue is never ready')
p.enqueue({ text: 'a'.repeat(140) }); p.enqueue({ text: 'b' })
assert.equal(p.ready(0, 0), true, 'idle: send now')
assert.equal(p.take()!.text[0], 'a')
assert.equal(p.ready(10, 1), false, 'playing, first frame not out yet: hold')
p.started(1000, 140) // 10 s of audio, ends at 11000
assert.equal(p.ready(5000, 1), false, 'far from the end: hold')
assert.equal(p.ready(9600, 1), true, 'within 1.5 s of the end: release')
assert.equal(p.ready(9600, 2), false, 'never more than one chunk ahead')
assert.deepEqual(p.clear().map((d) => d.text), ['b'], 'barge-in returns the unsent chunks')
assert.equal(p.size, 0)
console.log('say-pacer ok')
