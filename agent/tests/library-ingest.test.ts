// Library → cloud ingest tests (content_ingest RPC). No network: fetch is stubbed.
// Run: npx tsx agent/tests/library-ingest.test.ts   (one file at a time)
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import Database from 'better-sqlite3'

const tmp = mkdtempSync(join(tmpdir(), 'library-ingest-test-'))
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude')
const deny = join(tmp, 'deny.json')
writeFileSync(deny, JSON.stringify({ terms: { '[client]': ['Audos'] } }))
process.env.OSBORN_LENS_DENYLIST = deny
process.env.OPENROUTER_API_KEY = 'dummy-not-a-key'
for (const k of ['OSBORN_CONTENT_LENS', 'OSBORN_CONTENT_INGEST', 'OSBORN_CONTENT_LENS_MODEL', 'OSBORN_LIBRARY_MIN_PERIOD_H', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']) delete process.env[k]
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const ANON = `${b64({ alg: 'HS256' })}.${b64({ role: 'anon', ref: 'testref' })}.c2lnbmF0dXJl`
const SERVICE = `${b64({ alg: 'HS256' })}.${b64({ role: 'service_role' })}.c2lnbmF0dXJl`
const TOKEN = 'synctok-' + 'q7'.repeat(36)
const URL_ = 'https://testref.supabase.co'
process.env.OSBORN_SUPABASE_URL = URL_
process.env.OSBORN_SUPABASE_ANON_KEY = ANON
process.env.OSBORN_SYNC_TOKEN = TOKEN

const { runLibraryStep, readManifest, libraryDirFor, ingestPendingPages } = await import('../src/content/lens-library.js')
const { ingestPage, buildIngestPayload, isAnonKey, resolveIngestConfig, INGEST_MAX_BYTES } = await import('../src/content/lens-ingest.js')

let pass = 0
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

// ── fixture session: one closed period #1–#4, short tail (same shape as library-step.test.ts) ──
const H = 3_600_000
const T0 = Date.UTC(2026, 0, 1, 8, 0)
const seam = (w: string) => `<session_tail>\n2026-01-01T09:00  Assistant: replayed\n</session_tail>\n\n${w}`
const ROWS: [string, string, number][] = [
  ['user', 'We shipped the period library writer for Audos today', 0],
  ['assistant', 'The library writer is live and tested', 2],
  ['user', 'Great, the index table looks right to me', 4],
  ['assistant', 'Moving on to the ingest seam', 5],
  ['user', seam('Back after compaction'), 6],
  ['assistant', 'Continuing', 6.5],
]
const pd = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-zz-ingest')
const sid = 'ingest-test-session-0001'
mkdirSync(join(pd, 'osb', sid), { recursive: true })
const dbPath = join(pd, 'osb', sid, 'session.db')
const db = new Database(dbPath)
db.exec(`CREATE TABLE content(id INTEGER PRIMARY KEY, source TEXT, line_num INT, byte_offset INT, ts TEXT, msg_type TEXT, model TEXT, git_branch TEXT, cwd TEXT, tool_name TEXT, blob BLOB)`)
for (const [type, text, h] of ROWS)
  db.prepare('INSERT INTO content(source, ts, msg_type, blob) VALUES (?,?,?,?)').run('main', new Date(T0 + h * H).toISOString(), type, brotliCompressSync(Buffer.from(text)))
const libDir = libraryDirFor(dbPath, sid)

const MODEL_REPLY = JSON.stringify({
  high_leverage: [{ title: 'Period library writer shipped', why: 'automatic pages', evidence: 'shipped', quotes: [{ row: 1, text: 'We shipped the period library writer' }] }],
  period_goal: { text: 'Ship the automatic period library.', quotes: [{ row: 1, text: 'shipped the period library writer' }] },
  arc: [], what_worked: { held_up: [], didnt: [] }, stories: [], angles: [],
})
type Call = { url: string; init: any }
let chatCalls = 0
let rpc: Call[] = []
let rpcMode: 'ok' | 'http500' | 'hang' | 'pgrst202' = 'ok'
globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url)
  if (u.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'minimax/minimax-m3', context_length: 1_048_576, pricing: { prompt: '0.0000003', completion: '0.0000012' } }] }), { status: 200 })
  if (u.includes('/rest/v1/rpc/')) {
    rpc.push({ url: u, init })
    if (rpcMode === 'http500') return new Response(JSON.stringify({ code: 'XX000', message: `boom ${TOKEN}` }), { status: 500 })
    if (rpcMode === 'pgrst202') return new Response(JSON.stringify({ code: 'PGRST202', message: `secret-message ${TOKEN}`, hint: 'Perhaps you meant storage.x ($evil)' }), { status: 404 })
    if (rpcMode === 'hang') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    return new Response(JSON.stringify('11111111-2222-3333-4444-555555555555'), { status: 200 })
  }
  chatCalls++
  return new Response(JSON.stringify({ choices: [{ message: { content: MODEL_REPLY }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 300, cost: 0.0012 }, provider: 'stub' }), { status: 200 })
}) as typeof fetch

const logs: string[] = []
const log = (m: string) => logs.push(m)
const page = (md = '# Period map\n\n## Period goal\nShip it.\n\n## Cost\n- Calls: 1; $0.0010\n') =>
  ({ sessionId: sid, startRowId: 1, endRowId: 4, index: 1, closedBy: 5, file: '2026-01-01-period-01.md', markdown: md })
const noSecretsLogged = () => {
  const all = logs.join('\n')
  assert.ok(!all.includes(TOKEN) && !all.includes(ANON) && !all.includes('?') && !all.includes('Ship it'), 'log leaked token/key/query/body')
}

await t('config: anon key only — a service_role key is refused, never sent', () => {
  assert.equal(isAnonKey(ANON), true)
  assert.equal(isAnonKey(SERVICE), false)
  process.env.OSBORN_SUPABASE_ANON_KEY = SERVICE
  try { const c = resolveIngestConfig(); assert.ok(!c.ok || c.anonKey !== SERVICE) } finally { process.env.OSBORN_SUPABASE_ANON_KEY = ANON }
})
await t('payload: allowed type, required content_hash, anchors, never a status/owner field', () => {
  const p = buildIngestPayload(page(), s => s.replace(/Audos/g, '[client]'))
  assert.ok(['short', 'compilation', 'text_post', 'transcript', 'audio_video'].includes(p.type as string))
  assert.match(String(p.content_hash), /^[0-9a-f]{64}$/)
  assert.equal(p.title, 'Period 01: Ship it.')
  assert.deepEqual(p.source_anchors, { start_row_id: 1, end_row_id: 4, closed_by: 5, period_index: 1, file: '2026-01-01-period-01.md' })
  assert.equal(p.source_session_id, sid)
  for (const k of ['status', 'published_at', 'owner_user_id', 'user_id', 'slug']) assert.ok(!(k in p), k)
})
await t('request: POST {url}/rest/v1/rpc/content_ingest, apikey + Bearer anon, body {p_token, p_payload}', async () => {
  rpc = []; logs.length = 0
  const st = await ingestPage(page(), { log })
  assert.equal(st.status, 'ok'); assert.equal(st.id, '11111111-2222-3333-4444-555555555555')
  assert.equal(rpc.length, 1)
  assert.equal(rpc[0].url, `${URL_}/rest/v1/rpc/content_ingest`)
  assert.equal(rpc[0].init.method, 'POST')
  assert.equal(rpc[0].init.headers.apikey, ANON)
  assert.equal(rpc[0].init.headers.Authorization, `Bearer ${ANON}`)
  const body = JSON.parse(rpc[0].init.body)
  assert.deepEqual(Object.keys(body).sort(), ['p_payload', 'p_token'])
  assert.equal(body.p_token, TOKEN)
  assert.equal(body.p_payload.content_hash, st.contentHash)
  noSecretsLogged()
})
await t('request: sends Content-Profile: public and Accept-Profile: public (db_schema lists storage first)', async () => {
  rpc = []
  const st = await ingestPage(page(), { log })
  assert.equal(st.status, 'ok')
  assert.equal(rpc.length, 1)
  assert.equal(rpc[0].init.headers['Content-Profile'], 'public')
  assert.equal(rpc[0].init.headers['Accept-Profile'], 'public')
})
await t('non-2xx: logs sanitized code + hint, never the message', async () => {
  rpcMode = 'pgrst202'; logs.length = 0
  const st = await ingestPage(page(), { log })
  assert.deepEqual([st.status, st.httpStatus], ['error', 404])
  assert.ok(logs.some(l => /HTTP 404 code=PGRST202 hint="Perhaps you meant storage.x evil"/.test(l)), logs.join('\n'))
  assert.ok(!logs.join('\n').includes('secret-message'))
  noSecretsLogged()
  rpcMode = 'ok'
})
await t('opt-out: OSBORN_CONTENT_INGEST=0 (and OSBORN_CONTENT_LENS=0) → skipped, no request', async () => {
  rpc = []
  for (const [k, v] of [['OSBORN_CONTENT_INGEST', '0'], ['OSBORN_CONTENT_LENS', '0']]) {
    process.env[k] = v
    try { const st = await ingestPage(page(), { log }); assert.equal(st.status, 'skipped'); assert.equal(st.reason, 'disabled') } finally { delete process.env[k] }
  }
  assert.equal(rpc.length, 0)
})
await t('missing token → skipped quietly (no request, no log)', async () => {
  rpc = []; logs.length = 0
  delete process.env.OSBORN_SYNC_TOKEN
  try {
    const st = await ingestPage(page(), { log })
    assert.deepEqual([st.status, st.reason], ['skipped', 'no-token'])
    assert.equal(rpc.length, 0); assert.equal(logs.length, 0)
  } finally { process.env.OSBORN_SYNC_TOKEN = TOKEN }
})
await t('oversize payload (> 250KB) → skipped with a log line, no request', async () => {
  rpc = []; logs.length = 0
  const st = await ingestPage(page('# big\n' + 'word '.repeat(INGEST_MAX_BYTES / 4)), { log })
  assert.equal(st.status, 'oversize'); assert.equal(rpc.length, 0)
  assert.ok(logs.some(l => /skipped: payload \d+ bytes/.test(l)))
})
await t('timeout → error (fail-open, no throw), logged without secrets', async () => {
  rpcMode = 'hang'; logs.length = 0
  const st = await ingestPage(page(), { log, timeoutMs: 50 })
  assert.deepEqual([st.status, st.reason], ['error', 'timeout'])
  noSecretsLogged()
  rpcMode = 'ok'
})

// ── through the library step: HTTP 500 → page kept, retried next run without a model call ──
await t('step: HTTP 500 → page written, manifest ingest=error, no throw, no secrets in logs', async () => {
  rpcMode = 'http500'; rpc = []; logs.length = 0
  const r = await runLibraryStep({ sessionId: sid, log })
  assert.equal(r.status, 'written', r.errors.join('; '))
  assert.equal(rpc.length, 1)
  const e = readManifest(libDir, sid).periods['1']
  assert.equal(e.status, 'ok'); assert.equal(e.ingest?.status, 'error'); assert.equal(e.ingest?.httpStatus, 500)
  assert.ok(logs.some(l => /HTTP 500 code=XX000/.test(l)))
  noSecretsLogged()
})
let firstHash = ''
await t('step: next run retries the failed ingest (no model call) and records ok', async () => {
  rpcMode = 'ok'; rpc = []
  const before = chatCalls
  const r = await runLibraryStep({ sessionId: sid, log })
  assert.equal(r.status, 'deferred')
  assert.equal(chatCalls, before)
  assert.equal(rpc.length, 1)
  const e = readManifest(libDir, sid).periods['1']
  assert.equal(e.ingest?.status, 'ok')
  firstHash = e.ingest!.contentHash
  assert.equal(JSON.parse(rpc[0].init.body).p_payload.content_hash, firstHash)
  assert.ok(!JSON.parse(rpc[0].init.body).p_payload.body.includes('Audos'))
})
await t('step: once ingested, later runs send nothing', async () => {
  rpc = []
  await runLibraryStep({ sessionId: sid, log })
  assert.equal(rpc.length, 0)
})
await t('timeout retry: a pending page that timed out is retried by the pending pass with the same content_hash', async () => {
  const m = readManifest(libDir, sid)
  m.periods['1'].ingest = { ...m.periods['1'].ingest!, status: 'error', reason: 'timeout' }
  rpcMode = 'hang'; rpc = []
  assert.equal(await ingestPendingPages(libDir, m, { log, timeoutMs: 50 }), true)
  assert.equal(m.periods['1'].ingest?.reason, 'timeout')
  rpcMode = 'ok'
  assert.equal(await ingestPendingPages(libDir, m, { log }), true)
  assert.equal(m.periods['1'].ingest?.status, 'ok')
  assert.equal(rpc.length, 2)
  for (const c of rpc) assert.equal(JSON.parse(c.init.body).p_payload.content_hash, firstHash)
})
await t('opt-out through the step: OSBORN_CONTENT_INGEST=0 → pending pages are not sent', async () => {
  const m = readManifest(libDir, sid)
  delete m.periods['1'].ingest
  rpc = []
  process.env.OSBORN_CONTENT_INGEST = '0'
  try { assert.equal(await ingestPendingPages(libDir, m, { log }), false) } finally { delete process.env.OSBORN_CONTENT_INGEST }
  assert.equal(rpc.length, 0)
})

db.close()
console.log(`\n${pass} passed`)
