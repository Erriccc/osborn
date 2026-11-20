import assert from 'node:assert/strict'
import { AUDIO_DECODE_CAP_MS, decodeBudgetMs, recordingAge } from './say-budget'

assert.equal(decodeBudgetMs(14999), null, 'under 15s left: no decode')
assert.equal(decodeBudgetMs(15000), 5000, 'decode leaves 10s for hearing')
assert.equal(decodeBudgetMs(30000), 20000)
assert.equal(decodeBudgetMs(60000), 35000, 'a decode never takes more than 35s, however much is left')
assert.equal(decodeBudgetMs(-5), null, 'past the deadline: no decode')

const now = 10_000_000
assert.equal(recordingAge(null, now), null, 'no recording: no age')
assert.deepEqual(recordingAge(now - 25 * 60000, now), { minutes: 25, overCap: false })
assert.deepEqual(recordingAge(now - AUDIO_DECODE_CAP_MS, now), { minutes: 30, overCap: false }, 'at the cap is still decoded')
assert.deepEqual(recordingAge(now - AUDIO_DECODE_CAP_MS - 1, now), { minutes: 30, overCap: true })
assert.deepEqual(recordingAge(now + 500, now), { minutes: 0, overCap: false }, 'a clock skew in the page is not a negative age')
console.log('say-budget: all assertions passed')
