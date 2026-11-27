// Running-time check for local writer work (#651). Run: npx tsx agent/tests/long-local-write.test.ts
import assert from 'node:assert/strict'
import { getLongLocalWriteNote } from '../src/prompts.js'

const now = 10_000_000
const row = (taskId: string, ageMs: number, description = 'fix') => ({ taskId, description, startedAt: now - ageMs })
const noted = new Set<string>()
assert.equal(getLongLocalWriteNote([], now, noted), null)
assert.equal(getLongLocalWriteNote([row('a', 5 * 60_000)], now, noted), null, 'at the limit is not over it')
assert.equal(noted.size, 0, 'a task under the limit is not consumed')
const note = getLongLocalWriteNote([row('b', 7 * 60_000, 'rename\nthe  tab')], now, noted)!
assert.match(note, /7 min: "rename the tab"/)
assert.match(note, /past 5 minutes/)
assert.equal(getLongLocalWriteNote([row('b', 9 * 60_000)], now, noted), null, 'each task is flagged once')
assert.match(getLongLocalWriteNote([row('b', 9 * 60_000), row('c', 6 * 60_000)], now, noted)!, /6 min: "fix"/, 'a new late task still is')
assert.match(getLongLocalWriteNote([row('d', 6 * 60_000, "pay $& and $'")], now, noted)!, /"pay \$& and \$'"/, 'task text is inserted literally')
console.log('ok   long-local-write')
