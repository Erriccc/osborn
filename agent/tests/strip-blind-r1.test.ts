import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { brotliCompressSync } from 'node:zlib'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConversationRows } from '../src/content/lens-db.js'

const dir = mkdtempSync(join(tmpdir(), 'strip-blind-'))
const p = join(dir, 'session.db')
const db = new Database(p)
db.exec(`CREATE TABLE content (id INTEGER PRIMARY KEY, ts TEXT, msg_type TEXT, source TEXT, blob BLOB)`)
const ins = db.prepare('INSERT INTO content (id, ts, msg_type, source, blob) VALUES (?,?,?,?,?)')
const rows: [number, string][] = [
  [1, 'the HANDOFF_STATE section is wrong'],
  [2, 'This session is being continued from a previous conversation that ran out of context. Summary: blah'],
  [3, 'the <system-reminder> tag is noisy'],
  [4, 'before <task-notification id="x">secret job output</task-notification> after'],
  [5, 'alpha <recalled_context src="y">old recalled junk</recalled_context> omega'],
  [6, '=== HANDOFF_STATE ===\nstuff\n'],
]
for (const [id, t] of rows) ins.run(id, `2026-01-01T00:00:0${id}Z`, 'user', 'main', brotliCompressSync(Buffer.from(t)))
db.close()
const r = loadConversationRows(p)
const by = new Map(r.records.map(x => [x.id, x.text]))
assert.equal(by.get(1), 'the HANDOFF_STATE section is wrong', 'row1 kept')
assert.ok(!by.has(2), 'compaction lead dropped')
assert.equal(by.get(3), 'the <system-reminder> tag is noisy', 'row3 survives')
assert.ok(by.has(4) && !/secret job output|task-notification/.test(by.get(4)!), 'task-notification stripped: ' + by.get(4))
assert.ok(by.has(5) && !/junk|recalled_context/.test(by.get(5)!), 'recalled stripped: ' + by.get(5))
assert.ok(!by.has(6), 'section header row dropped')
console.log('ok', r.records.length, 'kept;', JSON.stringify(r.stats.stripped))
