import Database from 'better-sqlite3'
import { brotliCompressSync } from 'node:zlib'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { loadConversationRows } from '../src/content/lens-db.js'
import { selectBlock } from '../src/content/lens-period-block.js'
import { readPeriodMap } from '../src/content/lens-period.js'
import { localRecordingAdapter } from '../src/content/lens-audio.js'

const dir = mkdtempSync(join(tmpdir(), 'pmblind-'))
const p = join(dir, 'session.db')
const db = new Database(p)
db.exec(`CREATE TABLE content (id INTEGER PRIMARY KEY, source TEXT NOT NULL, line_num INTEGER NOT NULL, byte_offset INTEGER NOT NULL, ts TEXT, msg_type TEXT NOT NULL, model TEXT, git_branch TEXT, cwd TEXT, tool_name TEXT, blob BLOB NOT NULL)`)
const ins = db.prepare(`INSERT INTO content (id,source,line_num,byte_offset,ts,msg_type,blob) VALUES (?,?,?,?,?,?,?)`)
const rows: [number, string, string, string][] = [
  [1, 'main', 'user', 'REALUSER one: I want the loader to be boring and predictable'],
  [2, 'main', 'assistant', 'REALASSIST one: here is the plan, mentions <session_tail> as a tag name'],
  [3, 'main', 'user', 'This session is being continued from a previous conversation that ran out of context. HANDOFF_STATE xyz'],
  [4, 'main', 'user', 'real words KEEPME <session_tail>REPLAYLEAK</session_tail> tail words'],
  [5, 'main', 'user', 'alpha <recalled_context>RECALLLEAK</recalled_context> omega'],
  [6, 'main', 'user', 'beta <system-reminder>REMINDERLEAK</system-reminder> gamma'],
  [7, 'main', 'user', '[SYSTEM — SILENT CONTROL MESSAGE] SILENTLEAK'],
  [8, 'main', 'user', '<task-notification>TASKLEAK</task-notification>'],
  [9, 'main', 'user', 'delta <task-notification>TASKLEAK2</task-notification> epsilon'],
  [10, 'main', 'user', '=== DECISIONS ===\nDECISIONLEAK\n=== GOTCHAS ===\nx'],
  [11, 'sub', 'assistant', 'SUBAGENTLEAK'],
  [12, 'main', 'tool_use', 'TOOLLEAK'],
  [13, 'main', 'tool_result', 'TOOLRESLEAK'],
  [14, 'main', 'thinking', 'THINKLEAK'],
  [15, 'main', 'user', 'final genuine line from the user ZETA'],
]
rows.forEach(([id, src, ty, txt], i) => ins.run(id, src, i, 0, `2026-10-0${1 + (i % 5)}T10:00:00.000Z`, ty, brotliCompressSync(Buffer.from(txt))))
db.close()

let n = 0
const ok = (m: string) => console.log('ok   ', m, ++n && '')
const load = loadConversationRows(p)
const all = load.records.map(r => r.text).join('\n')
for (const leak of ['REPLAYLEAK', 'RECALLLEAK', 'REMINDERLEAK', 'SILENTLEAK', 'TASKLEAK', 'TASKLEAK2', 'DECISIONLEAK', 'HANDOFF_STATE', 'session is being continued', 'SUBAGENTLEAK', 'TOOLLEAK', 'TOOLRESLEAK', 'THINKLEAK'])
  assert.ok(!all.includes(leak), `leaked: ${leak}`)
ok('every stripped kind + non-conversation rows removed')
for (const keep of ['REALUSER one: I want the loader to be boring and predictable', 'REALASSIST one: here is the plan, mentions <session_tail> as a tag name', 'KEEPME', 'tail words', 'alpha', 'omega', 'beta', 'gamma', 'delta', 'epsilon', 'ZETA'])
  assert.ok(all.includes(keep), `lost genuine text: ${keep}`)
ok('genuine user and assistant text survives verbatim')
assert.deepEqual(load.records.map(r => r.id), [1, 2, 4, 5, 6, 9, 15])
ok('only main-thread user/assistant row ids kept')

// read-only: opening for write via loader must not mutate
const before = Database && new Database(p, { readonly: true }).prepare('select count(*) c from content').get() as any
loadConversationRows(p)
assert.equal((new Database(p, { readonly: true }).prepare('select count(*) c from content').get() as any).c, before.c)
ok('loader leaves db unchanged')

// fabricated quote dropped
const recs = load.records
const good = 'I want the loader to be boring and predictable'
const raw = JSON.stringify({
  high_leverage: [
    { title: 'real', why: 'w', evidence: 'shipped', quotes: [{ row: 1, text: good }] },
    { title: 'fake', why: 'w', evidence: 'shipped', quotes: [{ row: 1, text: 'this sentence was never said by anyone ever' }] },
  ],
  period_goal: { text: 'g', quotes: [{ row: 1, text: good }] },
  arc: [], what_worked: { held_up: [], didnt: [] }, stories: [], angles: [],
})
const m = readPeriodMap(raw, recs)!
assert.ok(m, 'map parsed')
assert.deepEqual(m.highLeverage.map(h => h.title), ['real'])
assert.ok(m.drops.length >= 1 || m.itemsDropped.length >= 1)
ok('fabricated quote dropped, real quote kept')

// block selection: cap keeps most recent, reports leftover
const b = selectBlock(recs, { boundaries: [], maxTokens: 20 })!
assert.equal(b.lastRowId, 15)
assert.ok(b.leftOut && b.leftOut.rows > 0 && b.leftOut.rows + b.records.length === b.periodRows)
ok('cap keeps most recent rows and reports leftover')

// transcript-only: no recordings dir, no env
delete process.env.OSBORN_RECORDINGS_DIR
assert.equal(localRecordingAdapter.align('nonexistent-sess', join(dir, 'no-such-project'), recs[0].timestamp), null)
const b2 = selectBlock(recs, { boundaries: [], maxTokens: 100000 })!
assert.equal(b2.leftOut, null)
assert.ok(readPeriodMap(raw, b2.records))
ok('transcript-only works with no recordings dir')
console.log(`\n${n} passed`)
