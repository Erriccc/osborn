import assert from 'node:assert/strict'
import { staleIdOnConsume, isStaleBlock } from '../src/stale-turn.js'

let stale: string | null = null
// barge-in recorded but never consumed: later blocks of that turn still play
const ctx = { spokenText: 'hello', messageId: 'A' }
assert.equal(isStaleBlock(stale, 'A'), false, 'unconsumed barge-in does not drop the turn')
// consumed: rest of the old turn dropped, the next turn (new id) passes
stale = staleIdOnConsume(ctx, stale)
assert.equal(isStaleBlock(stale, 'A'), true)
assert.equal(isStaleBlock(stale, 'B'), false)
// blocks without an id always pass
assert.equal(isStaleBlock(stale, undefined), false)
assert.equal(isStaleBlock(stale, null), false)
// suppressed-text-only or id-less contexts do not mark
assert.equal(staleIdOnConsume({ spokenText: '' , messageId: 'C' }, 'A'), 'A')
assert.equal(staleIdOnConsume({ spokenText: 'x' }, 'A'), 'A')
assert.equal(staleIdOnConsume(null, 'A'), 'A')
// next barge-in replaces the old id
assert.equal(staleIdOnConsume({ spokenText: 'y', messageId: 'B' }, 'A'), 'B')
console.log('stale-turn: ok')
