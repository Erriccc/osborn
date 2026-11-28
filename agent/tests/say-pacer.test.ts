import assert from 'node:assert/strict'
import { SayPacer } from '../src/say-pacer.js'

const p = new SayPacer<{ text: string }>()
assert.equal(p.ready(0), false, 'empty queue is never ready')
p.enqueue({ text: 'a' }); p.enqueue({ text: 'b' }); p.enqueue({ text: 'c' })
assert.equal(p.ready(0), true, 'idle: send now')
assert.equal(p.take()!.text, 'a')
assert.equal(p.ready(1), false, 'first frame not out yet: hold')
p.started()
assert.equal(p.ready(1), true, 'playing: release one ahead')
assert.equal(p.take()!.text, 'b')
assert.equal(p.ready(2), false, 'never more than one chunk ahead')
assert.equal(p.ready(1), false, 'the new in-flight chunk has not started')
p.started(); p.finished()
assert.equal(p.ready(1), false, 'a finished chunk does not release one ahead of another handle (a replay)')
assert.deepEqual(p.clear().map((d) => d.text), ['c'], 'barge-in returns the unsent chunks')
assert.equal(p.size, 0)
console.log('say-pacer ok')
