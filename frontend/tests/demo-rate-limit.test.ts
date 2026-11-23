// #296: the rate limiter stays bounded when the key rotates, and a key is held to its limit.
import assert from 'node:assert/strict'
import { createRateLimiter } from '../src/lib/demo-rate-limit'

const l = createRateLimiter({ limit: 2, windowMs: 1000, maxKeys: 3 })
assert.equal(l.limited('a', 0), false)
assert.equal(l.limited('a', 1), false)
assert.equal(l.limited('a', 2), true, 'third hit in the window is refused')
assert.equal(l.limited('a', 1001), false, 'the window slides')

// Rotating keys never grows the map past maxKeys.
const r = createRateLimiter({ limit: 10, windowMs: 60_000, maxKeys: 100 })
for (let i = 0; i < 5000; i++) r.limited(`10.0.${i >> 8}.${i & 255}`, i)
assert.ok(r.size() <= 100, `map held ${r.size()} keys`)

// Eviction drops the least recently used key, not one in active use.
const e = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 })
e.limited('busy', 0)
e.limited('old', 1)
assert.equal(e.limited('busy', 2), true)  // touches busy
e.limited('new', 3)                        // evicts old
assert.equal(e.limited('busy', 4), true, 'the active key keeps its count')
assert.equal(e.limited('old', 5), false, 'the evicted key starts again')

console.log('demo-rate-limit: ok')
