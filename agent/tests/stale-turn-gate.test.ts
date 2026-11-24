import assert from 'node:assert/strict'
import { StaleTurnGate } from '../src/stale-turn-gate.js'

const g = new StaleTurnGate(3)
assert.equal(g.isStale('a'), false)
g.markStale('a')
assert.equal(g.isStale('a'), true, 'late block of an interrupted turn is dropped')
assert.equal(g.isStale('b'), false, 'a new turn is not affected')
assert.equal(g.isStale(undefined), false, 'blocks without an id pass')
g.markStale(undefined); g.markStale(null)
for (const id of ['b', 'c', 'd']) g.markStale(id)
assert.equal(g.isStale('a'), false, 'oldest id is evicted past the cap')
assert.equal(g.isStale('d'), true)
console.log('stale-turn-gate: ok')
