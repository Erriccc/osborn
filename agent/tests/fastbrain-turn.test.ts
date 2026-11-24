import assert from 'node:assert/strict'
import { shouldDropFastBrainResult } from '../src/pipeline-direct-llm.js'
import { finish } from '../src/pipeline-fastbrain.js'

assert.equal(shouldDropFastBrainResult(3, 3, false), false, 'current turn is kept')
assert.equal(shouldDropFastBrainResult(3, 4, false), true, 'newer turn drops it')
assert.equal(shouldDropFastBrainResult(3, 3, true), true, 'aborted drops it')

const empty = finish('Cloud.', '', [])
assert.equal(empty.type, 'research_needed')
assert.equal(empty.script, '')
const ws = finish('Cloud.', '   ', ['search_session'])
assert.equal(ws.type, 'research_needed')
const real = finish('q', "I didn't find that in the session history.", [])
assert.equal(real.type, 'answer', 'a model-written not-found stays an answer')
console.log('fastbrain-turn ok')
