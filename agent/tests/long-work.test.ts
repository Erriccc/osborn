// Running-time check for local writer work (#651). Run: npx tsx agent/tests/long-work.test.ts
import assert from 'node:assert/strict'
import { overdueWriters, overdueWriterNote, LONG_WRITER_MS } from '../src/long-work.js'

const now = 10_000_000
const row = (subagentType: string, ageMs: number, description = 'fix') => ({ taskId: `${subagentType}${ageMs}`, subagentType, description, startedAt: now - ageMs })

assert.equal(overdueWriterNote([], now), null)
assert.equal(overdueWriterNote([row('writer', LONG_WRITER_MS)], now), null, 'exactly at the limit is not over it')
assert.equal(overdueWriterNote([row('researcher', 60 * 60_000)], now), null, 'research may run long')
assert.equal(overdueWriters([row('writer', 9 * 60_000), row('writer', 6 * 60_000), row('writer', 1000)], now).length, 2)
const note = overdueWriterNote([row('writer', 7 * 60_000, 'rename\nthe  tab')], now)!
assert.match(note, /7 min: "rename the tab"/)
assert.match(note, /Left off at:/)
console.log('ok   long-work')
