// Recall regression check (#681). Run: npx tsx scripts/recall-check.ts [--update-baseline] [--hybrid]
// Builds a store from the synthetic fixture in recall-golden/, asks the golden questions in each mode,
// prints hit@5 and latency, and exits 1 when hit@5 falls past the tolerance from recall-golden/baseline.json
// or a row outside the active project shows up while cross-project recall is off.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const GOLDEN = join(here, '..', 'recall-golden')
const TOLERANCE = 0.02
const args = new Set(process.argv.slice(2))

process.env.HOME = mkdtempSync(join(tmpdir(), 'osborn-recall-check-'))
delete process.env.OSBORN_CROSS_PROJECT_RECALL

const { CORPUS, QUESTIONS } = await import('../recall-golden/corpus.js')
const { getSessionDir } = await import('../src/config.js')
const { openStore, recall, updateSessionStore, getStorePath, rowInScope } = await import('../src/session-store.js')

const A = join(process.env.HOME, 'projA'), B = join(process.env.HOME, 'projB')
mkdirSync(A, { recursive: true }); mkdirSync(B, { recursive: true })
const sid = '11111111-2222-4333-8444-666666666666'
const agentId = 'abcd1234ef'
const dir = getSessionDir(A)
mkdirSync(join(dir, sid, 'subagents'), { recursive: true })

// Write the fixture as Claude-style JSONL; remember each message's (source, line) to match hits.
const lineOf = new Map<string, string>()
const files: Record<'main' | 'agent', string[]> = { main: [], agent: [] }
const cwdOf = (p: 'A' | 'B') => (p === 'A' ? A : B)
let n = 0
for (const msg of CORPUS) {
  const lines = files[msg.source]
  if (msg.afterCompaction && !files.main.some(l => l.includes('compact_boundary'))) {
    files.main.push(JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: `2026-11-20T10:00:${String(n++).padStart(2, '0')}.000Z`, sessionId: sid }))
  }
  const ts = `2026-11-20T10:00:${String(n++).padStart(2, '0')}.000Z`
  const base = { uuid: `m${n}`, timestamp: ts, sessionId: sid, cwd: cwdOf(msg.project) }
  lines.push(JSON.stringify(msg.role === 'user'
    ? { ...base, type: 'user', message: { role: 'user', content: msg.text } }
    : { ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: msg.text }] } }))
  lineOf.set(msg.key, `${msg.source === 'main' ? 'main' : `agent-${agentId.slice(0, 8)}`}#${lines.length}`)
}
files.main.push(JSON.stringify({ type: 'user', uuid: 'tur', timestamp: '2026-11-20T11:00:00.000Z', sessionId: sid, cwd: A,
  toolUseResult: { agentId, status: 'completed' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] } }))
writeFileSync(join(dir, `${sid}.jsonl`), files.main.join('\n') + '\n')
writeFileSync(join(dir, sid, 'subagents', `agent-${agentId}.jsonl`), files.agent.join('\n') + '\n')
await updateSessionStore(sid, A)

const keyOfHit = (h: { source: string; lineNum: number }) => `${h.source}#${h.lineNum}`
const expected = (k: string) => lineOf.get(k)!

type Mode = 'keyword' | 'hybrid' | 'vector'
interface Result { hit5: number; hit5Other: number; ms: number; missed: string[]; leaks: string[] }
async function run(mode: Mode, embed?: any): Promise<Result> {
  const db = openStore(getStorePath(sid, A), { readonly: true })
  const own = QUESTIONS.filter(q => q.kind !== 'other-project')
  const other = QUESTIONS.filter(q => q.kind === 'other-project')
  const missed: string[] = [], leaks: string[] = []
  let hits = 0, hitsOther = 0, ms = 0
  try {
    for (const q of QUESTIONS) {
      const t0 = performance.now()
      const scoped = await recall(db, q.q, { mode, topK: 5, embed, scopeCwd: A })
      ms += performance.now() - t0
      for (const h of scoped) if (!rowInScope(h.cwd, A)) leaks.push(`${q.q} -> ${h.cwd}`)
      if (q.kind === 'other-project') {
        // Must miss while scoped (leaks above) and hit once cross-project recall is on.
        process.env.OSBORN_CROSS_PROJECT_RECALL = 'on'
        const open = await recall(db, q.q, { mode, topK: 5, embed, scopeCwd: A })
        delete process.env.OSBORN_CROSS_PROJECT_RECALL
        if (open.some(h => keyOfHit(h) === expected(q.expect))) hitsOther++; else missed.push(`[cross-on] ${q.q}`)
      } else if (scoped.some(h => keyOfHit(h) === expected(q.expect))) hits++
      else missed.push(q.q)
    }
  } finally { db.close() }
  return { hit5: hits / own.length, hit5Other: hitsOther / other.length, ms: ms / QUESTIONS.length, missed, leaks }
}

const results: Record<string, Result> = { keyword: await run('keyword') }
if (args.has('--hybrid') || process.env.OPENROUTER_API_KEY) {
  const { getEmbedder } = await import('../src/embedder.js')
  const embed = await getEmbedder()
  if (embed) {
    await updateSessionStore(sid, A, { embed })
    results.hybrid = await run('hybrid', embed)
    results.vector = await run('vector', embed)
  } else console.log('hybrid/vector skipped: no embedder available')
}

const baselinePath = join(GOLDEN, 'baseline.json')
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {}
let failed = false
console.log('mode      hit@5(own)  hit@5(cross-on)  avg ms  baseline')
for (const [mode, r] of Object.entries(results)) {
  const b = baseline[mode]
  console.log(`${mode.padEnd(9)} ${r.hit5.toFixed(2).padEnd(11)} ${r.hit5Other.toFixed(2).padEnd(16)} ${r.ms.toFixed(1).padEnd(7)} ${b ? b.hit5.toFixed(2) : 'none'}`)
  for (const q of r.missed) console.log(`  missed: ${q}`)
  for (const l of r.leaks) { console.log(`  LEAK: ${l}`); failed = true }
  if (b && r.hit5 < b.hit5 - TOLERANCE) { console.log(`  REGRESSION: hit@5 ${r.hit5.toFixed(2)} < baseline ${b.hit5.toFixed(2)} - ${TOLERANCE}`); failed = true }
  if (b && r.hit5Other < b.hit5Other - TOLERANCE) { console.log('  REGRESSION: cross-project hit@5 fell'); failed = true }
}
if (args.has('--update-baseline')) {
  const next = { ...baseline }
  for (const [mode, r] of Object.entries(results)) next[mode] = { hit5: r.hit5, hit5Other: r.hit5Other }
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n')
  console.log('baseline written')
}
process.exit(failed ? 1 : 0)
