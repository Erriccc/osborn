// Compaction-lens HN gap check goes through the outbound-query gate. Run: npx tsx agent/tests/content-lens-gate.test.ts
// fetch is stubbed: no network, no spend. OSBORN_HOME + CLAUDE_CONFIG_DIR point at a temp dir.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import Database from 'better-sqlite3'

const tmp = mkdtempSync(join(tmpdir(), 'lens-gate-test-'))
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude')
process.env.OSBORN_HOME = join(tmp, 'osborn-home')
delete process.env.OSBORN_LENS_DENYLIST
delete process.env.OSBORN_LENS_INCLUDE_SUBAGENTS
delete process.env.OSBORN_CONTENT_LENS
process.env.OPENROUTER_API_KEY = 'dummy-not-a-key'

const { runCompactionLens } = await import('../src/content/compaction-lens.js')
const { slugDir } = await import('../src/content/lens-paths.js')
const { lensModel } = await import('../src/content/lens-model.js')

let pass = 0
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

const QUOTE = 'the retry storm came from the webhook worker hammering the queue'
const TS = '2026-01-01T10:01:00.000Z'

function makeDb(cwd: string, sid: string): void {
  const dir = join(slugDir(cwd), 'osb', sid)
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, 'session.db'))
  db.exec(`CREATE TABLE content(id INTEGER PRIMARY KEY, source TEXT, line_num INT, byte_offset INT, ts TEXT, msg_type TEXT, model TEXT, git_branch TEXT, cwd TEXT, tool_name TEXT, blob BLOB)`)
  const ins = db.prepare('INSERT INTO content(source, ts, msg_type, cwd, blob) VALUES (?,?,?,?,?)')
  ins.run('main', '2026-01-01T10:00:00.000Z', 'user', cwd, brotliCompressSync(Buffer.from('why is the queue melting down this morning')))
  ins.run('main', TS, 'assistant', cwd, brotliCompressSync(Buffer.from(`Found it: ${QUOTE}, fixed with backoff.`)))
  db.close()
}

/** Run the lens once with a model reply carrying one angle with `queries`; return every outbound URL. */
async function runWith(cwd: string, sid: string, queries: string[]) {
  makeDb(cwd, sid)
  const urls: string[] = []
  const model = lensModel()
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    urls.push(u)
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } })
    if (u.endsWith('/models')) return json({ data: [{ id: model, context_length: 200_000, pricing: { prompt: '0.0000001', completion: '0.0000001' } }] })
    if (u.endsWith('/chat/completions')) {
      const content = JSON.stringify({
        angles: [{ title: 'Taming a webhook retry storm', why: 'common pain', queries, quotes: [{ text: QUOTE, timestamp: TS, row: 2, speaker: 'assistant' }] }],
        capabilities: [],
      })
      return json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0001 } })
    }
    return json({ hits: [], nbHits: 0 })
  }) as any
  try {
    const out = join(slugDir(cwd), 'osb', sid, 'review.md')
    const r = await runCompactionLens({ sessionId: sid, cwd, mode: 'backfill', outPath: out })
    return { r, urls, hn: urls.filter(u => u.includes('hn.algolia.com')) }
  } finally {
    globalThis.fetch = realFetch
  }
}

await t('lens query naming the project (cwd basename) causes no HN fetch', async () => {
  const { r, hn } = await runWith('/work/acmebilling', 'gate-project', ['acmebilling retry storms', 'Acmebilling webhook backoff'])
  assert.equal(r.status, 'written')
  assert.equal(r.angles.length, 1)
  assert.equal(hn.length, 0, `unexpected HN fetch: ${hn.join(' ')}`)
  assert.deepEqual(r.angles[0].gap.queries, [])
  assert.equal(r.angles[0].gap.reachable, false)
  assert.equal(r.angles[0].gap.note, 'No search queries emitted.')
})

await t('lens query naming an OSBORN_CWD segment causes no HN fetch', async () => {
  const prev = process.env.OSBORN_CWD
  process.env.OSBORN_CWD = '/srv/zephyrpay'
  try {
    const { r, hn } = await runWith('/work/plainproj', 'gate-osborn-cwd', ['zephyrpay webhook retries'])
    assert.equal(r.status, 'written')
    assert.equal(hn.length, 0, `unexpected HN fetch: ${hn.join(' ')}`)
  } finally {
    if (prev === undefined) delete process.env.OSBORN_CWD
    else process.env.OSBORN_CWD = prev
  }
})

await t('lens query with a path / identifier shape causes no HN fetch', async () => {
  const { hn } = await runWith('/work/otherproj', 'gate-shape', ['src/webhook.ts retry', 'retryStorm handler fix'])
  assert.equal(hn.length, 0, `unexpected HN fetch: ${hn.join(' ')}`)
})

await t('clean lens query still reaches HN unchanged', async () => {
  const { r, hn } = await runWith('/work/acmebilling', 'gate-clean', ['webhook retry storms', 'acmebilling backoff'])
  assert.equal(hn.length, 1, `expected exactly one HN fetch, got ${hn.length}`)
  assert.equal(new URL(hn[0]).searchParams.get('query'), 'webhook retry storms')
  assert.deepEqual(r.angles[0].gap.queries, ['webhook retry storms'])
  assert.equal(r.angles[0].gap.reachable, true)
})

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`)
