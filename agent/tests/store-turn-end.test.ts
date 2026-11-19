// Run: npx tsx agent/tests/store-turn-end.test.ts
// #153: /session-messages reads the per-session store, which was only swept when
// the NEXT user prompt was submitted, so a reload missed the newest exchange.
// The store is now also swept at turn end (main JSONL only); a sweep asked for
// while one is running must run once after it instead of being dropped.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'osborn-store-turn-end-'))
process.env.OSBORN_EMBED = '0'

const { ClaudeLLM } = await import('../src/claude-llm.js')
const { getSessionDir } = await import('../src/config.js')
const { storeExists, openStore, recentRows, updateSessionStore } = await import('../src/session-store.js')

const PROJECT = join(process.env.HOME, 'project')
mkdirSync(PROJECT, { recursive: true })
const sid = '11111111-2222-4333-8444-555555555555'
const dir = getSessionDir(PROJECT)
mkdirSync(dir, { recursive: true })
const jsonl = join(dir, `${sid}.jsonl`)
const line = (type: 'user' | 'assistant', text: string, ts: string) => JSON.stringify({
  type, uuid: `${type}-${ts}`, timestamp: ts, sessionId: sid, cwd: PROJECT,
  message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] },
}) + '\n'
writeFileSync(jsonl, line('user', 'first question', '2026-11-19T10:00:00.000Z'))

const llm = new ClaudeLLM({ workingDirectory: PROJECT } as any)
// Submit-time sweep starts; the reply is written while it runs and the turn ends.
llm.triggerStoreUpdate(sid, PROJECT)
appendFileSync(jsonl, line('assistant', 'NEWEST-REPLY', '2026-11-19T10:00:05.000Z'))
llm.triggerStoreUpdate(sid, PROJECT, true)

const texts = async () => {
  const p = storeExists(sid, PROJECT)
  if (!p) return [] as string[]
  const db = openStore(p, { readonly: true })
  try { return recentRows(db, 10, ['user', 'assistant']).map(r => JSON.stringify(r)) } finally { db.close() }
}
let rows: string[] = []
for (let i = 0; i < 50; i++) {
  await new Promise(r => setTimeout(r, 100))
  rows = await texts()
  if (rows.some(r => r.includes('NEWEST-REPLY'))) break
}
assert.ok(rows.some(r => r.includes('first question')), 'the submit-time sweep ingested the prompt')
assert.ok(rows.some(r => r.includes('NEWEST-REPLY')), 'a sweep asked for mid-sweep runs after it, so the reply reaches the store')
console.log('PASS mid-sweep request is queued, not dropped')

// The turn-end sweep reads the main JSONL only; a full sweep still takes sub-agents.
const subDir = join(dir, sid, 'subagents')
mkdirSync(subDir, { recursive: true })
writeFileSync(join(subDir, 'agent-abcdef12.jsonl'), line('assistant', 'SUBAGENT-ROW', '2026-11-19T10:00:06.000Z'))
const sourceNames = () => {
  const db = openStore(storeExists(sid, PROJECT)!, { readonly: true })
  try { return (db.prepare('SELECT source FROM sources').all() as { source: string }[]).map(r => r.source) } finally { db.close() }
}
await updateSessionStore(sid, PROJECT, { mainOnly: true })
assert.deepEqual(sourceNames(), ['main'], 'mainOnly skips sub-agent sources')
await updateSessionStore(sid, PROJECT)
assert.ok(sourceNames().includes('agent-abcdef12'), 'a full sweep ingests them')
console.log('PASS mainOnly skips sub-agents, a full sweep takes them')
process.exit(0)
