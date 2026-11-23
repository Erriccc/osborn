// npx tsx agent/tests/fastbrain-fallback.test.ts
import assert from 'node:assert/strict'
import { candidateId, isModelNotFound, pickCandidate, type FastBrainCandidate } from '../src/fastbrain-fallback.js'

assert.equal(isModelNotFound(404, ''), true)
assert.equal(isModelNotFound(400, '{"error":{"code":"model_not_found"}}'), true)
assert.equal(isModelNotFound(400, 'The model `x` does not exist'), true)
assert.equal(isModelNotFound(429, 'rate limited'), false)
assert.equal(isModelNotFound(500, 'model not found'), false)
assert.equal(isModelNotFound(401, 'bad key'), false)

const a: FastBrainCandidate = { url: 'u1', key: 'k', model: 'm1', name: 'A' }
const b: FastBrainCandidate = { url: 'u2', key: 'k', model: 'm2', name: 'B' }
assert.equal(pickCandidate([a, b], new Set()), a)
assert.equal(pickCandidate([a, b], new Set([candidateId(a)])), b)
assert.equal(pickCandidate([a, b], new Set([candidateId(a), candidateId(b)])), undefined)
console.log('fastbrain-fallback: ok')
