// Running-time check for local writer work (#651). Run: npx tsx agent/tests/long-local-write.test.ts
import assert from 'node:assert/strict'
import { getLongLocalWriteNote, LONG_WRITE_MIN } from '../src/prompts.js'

const now = 10_000_000
const row = (ageMs: number, description = 'fix') => ({ description, startedAt: now - ageMs })
assert.equal(getLongLocalWriteNote([], now), null)
assert.equal(getLongLocalWriteNote([row(LONG_WRITE_MIN * 60_000)], now), null, 'at the limit is not over it')
const note = getLongLocalWriteNote([row(7 * 60_000, 'rename\nthe  tab')], now)!
assert.match(note, /7 min: "rename the tab"/)
assert.match(note, /past 5 minutes/)
console.log('ok   long-local-write')
