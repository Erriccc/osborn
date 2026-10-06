// Blind requirement tests for the content-lens rework. Run: npx tsx agent/tests/content-lens-rework.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import Database from 'better-sqlite3'

const tmp = mkdtempSync(join(tmpdir(), 'lens-test-'))
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude')
const deny = join(tmp, 'deny.json')
writeFileSync(deny, JSON.stringify({ terms: { '[client]': ['Audos', 'Prehype', 'Peazy'], '[founder]': ['Jane Doerfler'] } }))
process.env.OSBORN_LENS_DENYLIST = deny
delete process.env.OSBORN_LENS_INCLUDE_SUBAGENTS

const { loadConversationRows, packWindows } = await import('../src/content/lens-db.js')
const { loadClientRedactor, isBillingAngle } = await import('../src/content/lens-redact.js')
const { redactSecrets } = await import('../src/content/transcript-sanitizer.js')
const { readCapabilities } = await import('../src/content/lens-quotes.js')
const { buildRecordIndex, verifyQuote, verifyItems, splitByEvidence } = await import('../src/content/lens-quotes.js')
const { readHwm, writeHwm } = await import('../src/content/lens-paths.js')
const { launchCompactionLens } = await import('../src/content/lens-launch.js')
const { runCompactionLens } = await import('../src/content/compaction-lens.js')
const { WINDOW_FRACTION, lensModel, Budget } = await import('../src/content/lens-model.js')

let pass = 0
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

// ---- temp session.db ----
const dbPath = join(tmp, 'session.db')
const db = new Database(dbPath)
db.exec(`CREATE TABLE content(id INTEGER PRIMARY KEY, source TEXT, line_num INT, byte_offset INT, ts TEXT, msg_type TEXT, model TEXT, git_branch TEXT, cwd TEXT, tool_name TEXT, blob BLOB)`)
const ins = db.prepare('INSERT INTO content(source, ts, msg_type, blob) VALUES (?,?,?,?)')
const rows: [string, string, string][] = [
  ['main', '2026-01-01T10:00:00.000Z', 'user'],       // 1
  ['main', '2026-01-01T10:01:00.000Z', 'assistant'],  // 2
  ['main', '2026-01-01T10:02:00.000Z', 'thinking'],   // 3
  ['main', '2026-01-01T10:03:00.000Z', 'tool_use'],   // 4
  ['main', '2026-01-01T10:04:00.000Z', 'tool_result'],// 5
  ['agent-abcd1234', '2026-01-01T10:05:00.000Z', 'assistant'], // 6
  ['main', '2026-01-01T10:06:00.000Z', 'assistant'],  // 7
]
const texts = [
  'Please fix the websocket reconnect bug in the gateway handler today',
  'I found the root cause: the x-forwarded-host header was missing on the proxy hop',
  'THINKING_SECRET_TEXT should never be read',
  'TOOL_USE_PAYLOAD should never be read',
  'TOOL_RESULT_PAYLOAD should never be read',
  'SUBAGENT_CHATTER should not be read by default',
  'Deployed and verified; all tests pass now across the suite',
]
rows.forEach((r, i) => ins.run(r[0], r[1], r[2], brotliCompressSync(Buffer.from(texts[i]))))
db.close()

await t('conversation-only: only user+assistant main rows, no thinking/tool_*/subagent', () => {
  const l = loadConversationRows(dbPath, 0)
  assert.deepEqual(l.records.map(r => r.id), [1, 2, 7])
  const all = l.records.map(r => r.text).join('\n')
  for (const bad of ['THINKING_SECRET', 'TOOL_USE_PAYLOAD', 'TOOL_RESULT_PAYLOAD', 'SUBAGENT_CHATTER']) assert.ok(!all.includes(bad), bad)
  assert.deepEqual(l.records.map(r => r.speaker), ['user', 'assistant', 'assistant'])
})

await t('rows come back in id order and maxRowId tracked', () => {
  const l = loadConversationRows(dbPath, 0)
  assert.ok(l.maxRowId >= 7)
  const ids = l.records.map(r => r.id)
  assert.deepEqual([...ids].sort((a, b) => a - b), ids)
})

await t('high-water mark: afterRowId yields only newer rows', () => {
  const l = loadConversationRows(dbPath, 2)
  assert.deepEqual(l.records.map(r => r.id), [7])
  assert.equal(loadConversationRows(dbPath, 7).records.length, 0)
})

await t('hwm file: per-session, monotonic, default 0', () => {
  const pd = join(tmp, 'proj'); mkdirSync(pd, { recursive: true })
  assert.equal(readHwm(pd, 's1'), 0)
  writeHwm(pd, 's1', 10); writeHwm(pd, 's2', 4); writeHwm(pd, 's1', 3)
  assert.equal(readHwm(pd, 's1'), 10)
  assert.equal(readHwm(pd, 's2'), 4)
  assert.equal(readHwm(null, 's1'), 0)
})

await t('windows pack in order, respect size', () => {
  const recs = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, speaker: 'user' as const, text: 'x'.repeat(2000) }))
  const w = packWindows(recs, 5000) // 20k chars cap
  assert.ok(w.length > 1)
  assert.deepEqual(w.flatMap(x => x.records.map(r => r.id)), recs.map(r => r.id))
  for (const x of w) assert.ok(x.chars <= 22_000)
})

const R = loadClientRedactor(null)
await t('client redaction: names / companies / emails / ids / uuids / billing', () => {
  const s = [
    'Audos and Prehype and Peazy asked; Jane Doerfler agreed. Audos\'s account.',
    'mail jane.d@example.com now',
    'ad account act_1234567890123 and urn:li:sponsoredAccount:508123456',
    'workspace 3f2b8c1e-9d4a-4e6b-8a1c-0123456789ab',
    'Invoice sent: $12,500 due; retainer is $3k',
    'google customer id 123-456-7890 and page id 1784140000000001',
  ].join('\n')
  const o = R.redact(s)
  for (const bad of [/audos/i, /prehype/i, /peazy/i, /doerfler/i, /@example\.com/, /act_\d/, /508123456/, /3f2b8c1e/, /12,500/, /\$3k/, /123-456-7890/, /1784140000000001/]) assert.ok(!bad.test(o), String(bad))
  assert.ok(/\[amount\]/.test(o))
})

await t('API pricing outside billing context is kept', () => {
  assert.ok(R.redact('The model costs $0.50 per million tokens').includes('$0.50'))
})

await t('redaction applied to every pulled row before return (via loadConversationRows)', () => {
  const p = join(tmp, 'red.db'); const d = new Database(p)
  d.exec(`CREATE TABLE content(id INTEGER PRIMARY KEY, source TEXT, line_num INT, byte_offset INT, ts TEXT, msg_type TEXT, model TEXT, git_branch TEXT, cwd TEXT, tool_name TEXT, blob BLOB)`)
  const i = d.prepare('INSERT INTO content(source, ts, msg_type, blob) VALUES (?,?,?,?)')
  i.run('main', '2026-01-01T10:00:00Z', 'user', brotliCompressSync(Buffer.from('ping Audos at ops@audos.example about act_99999999 using key sk-ant-api03-' + 'A'.repeat(60))))
  i.run('main', '2026-01-01T10:01:00Z', 'assistant', brotliCompressSync(Buffer.from('curl -H "x-goog-api-key: AIzaSyD' + 'q'.repeat(30) + '" -H "api-key: abcdef1234567890zz" Prehype')))
  d.close()
  const out = loadConversationRows(p, 0, R.redact).records.map(r => r.text).join('\n')
  for (const bad of [/audos/i, /prehype/i, /@audos/, /act_9/, /sk-ant-api03-A/, /AIzaSyDq/, /abcdef1234567890zz/]) assert.ok(!bad.test(out), String(bad))
})

await t('sanitizer: x-goog-api-key and api-key header values redacted', () => {
  const o = redactSecrets('x-goog-api-key: AIzaSyDabcdefghijklmnopqrstuvwxyz012345\napi-key: 0123456789abcdefXYZ\nX-API-Key=zzzzzzzzzzzz', { assistant: true })
  assert.ok(!/AIzaSyDabc|0123456789abcdefXYZ|zzzzzzzzzzzz/.test(o), o)
})

await t('billing angles excluded', () => {
  assert.ok(isBillingAngle({ title: 'Chasing an overdue invoice', why: 'x' }))
  assert.ok(!isBillingAngle({ title: 'WS 1006 from missing header', why: 'proxy bug' }))
})

const { readCandidates, ground } = await import('../src/content/compaction-lens.js')
const { isBillingCapability, hasBillingQuote } = await import('../src/content/lens-redact.js')

await t('billing capabilities dropped in readCandidates (name / did / proof) and counted', () => {
  const raw = JSON.stringify({
    angles: [{ title: 'Chasing an unpaid invoice', why: 'x', quotes: [] }, { title: 'WS 1006 root cause', why: 'proxy', quotes: [] }],
    capabilities: [
      { name: 'Automated invoice reconciliation', did: 'x', evidence: 'shipped', proof: '', quotes: [] },
      { name: 'Ledger sync', did: 'sent the retainer reminders', evidence: 'shipped', proof: '', quotes: [] },
      { name: 'Sync job', did: 'cron', evidence: 'shipped', proof: 'client billing emails went out', quotes: [] },
      { name: 'Gateway header fix', did: 'added x-forwarded-host', evidence: 'root-caused', proof: 'tests pass', quotes: [] },
      { name: 'Billing dashboard plan', did: 'x', evidence: 'planned', proof: '', quotes: [] },
    ],
  })
  const r = { billingDropped: 0, notDone: 0 }
  const c = readCandidates(raw, 10, 10, r)
  assert.deepEqual(c.angles.map(a => a.title), ['WS 1006 root cause'])
  assert.deepEqual(c.capabilities.map(x => x.name), ['Gateway header fix'])
  assert.equal(r.billingDropped, 4) // 1 angle + 3 capabilities; the plan counts as notDone, not billing
  assert.equal(r.notDone, 1)
  assert.ok(isBillingCapability({ name: 'x', did: 'y', proof: 'refunded the payment' }))
  assert.ok(!isBillingCapability({ name: 'Meta ads auth', did: 'OAuth', proof: 'token works' }))
})

await t('items whose verified quote text is billing talk are dropped in ground and counted', () => {
  const p = join(tmp, 'bill.db'); const d = new Database(p)
  d.exec(`CREATE TABLE content(id INTEGER PRIMARY KEY, source TEXT, line_num INT, byte_offset INT, ts TEXT, msg_type TEXT, model TEXT, git_branch TEXT, cwd TEXT, tool_name TEXT, blob BLOB)`)
  const i = d.prepare('INSERT INTO content(source, ts, msg_type, blob) VALUES (?,?,?,?)')
  i.run('main', '2026-01-01T10:00:00.000Z', 'user', brotliCompressSync(Buffer.from('we still need to send the invoice to them before Friday afternoon')))
  i.run('main', '2026-01-01T10:01:00.000Z', 'assistant', brotliCompressSync(Buffer.from('the gateway now forwards the host header on every proxy hop correctly')))
  d.close()
  const bidx = buildRecordIndex(loadConversationRows(p, 0).records)
  const billQ = { text: 'we still need to send the invoice to them', timestamp: '2026-01-01T10:00:00.000Z', row: 1 }
  const okQ = { text: 'the gateway now forwards the host header on every proxy hop', timestamp: '2026-01-01T10:01:00.000Z', row: 2 }
  const r = { billingDropped: 0 }
  const g = ground({
    angles: [{ title: 'Neutral title', why: 'neutral', quotes: [billQ], queries: [] }, { title: 'Proxy hop', why: 'x', quotes: [okQ], queries: [] }],
    capabilities: [
      { name: 'Neutral cap', did: 'x', evidence: 'shipped', proof: '', quotes: [okQ, billQ] },
      { name: 'Header fix', did: 'x', evidence: 'shipped', proof: '', quotes: [okQ] },
      { name: 'Fabricated', did: 'x', evidence: 'shipped', proof: '', quotes: [{ text: 'invoice paid in full yesterday by wire', timestamp: '2026-01-01T10:00:00.000Z' }] },
    ],
  }, bidx, r)
  assert.deepEqual(g.c.angles.map(a => a.title), ['Proxy hop'])
  assert.deepEqual(g.c.capabilities.map(x => x.name), ['Header fix'])
  assert.equal(r.billingDropped, 2) // fabricated quote is a grounding drop, not billing
  assert.equal(g.dC, 1)
  assert.ok(hasBillingQuote({ quotes: [billQ] }) && !hasBillingQuote({ quotes: [okQ] }))
})

await t('billing KEEP list: technical billing/payment work is not dropped', () => {
  const keep = [
    'Stripe webhook integration for payment_intent.succeeded',
    'Payment webhook signature verification and idempotent retries',
    'Built the billing API client with retry on 429',
    'Payment gateway timeout root-caused to a missing keep-alive',
    'Meta ads API billed spend reconciled against the insights endpoint',
    'Google Ads budget and spend caps enforced before campaign launch',
    'ads-API pricing and billing account setup for the [ad account]',
    'Token pricing per million tokens compared across OpenRouter models',
    'Rate limits on the billing endpoint backed off with jitter',
    'Wallet holds released when the payment job fails',
    'Our rate limits on the payments API were too low',
  ]
  for (const s of keep) {
    assert.ok(!isBillingAngle({ title: s, why: '' }), `angle dropped: ${s}`)
    assert.ok(!isBillingCapability({ name: s, did: 'shipped it', proof: 'tests pass' }), `capability dropped: ${s}`)
  }
})

await t('billing DROP list: personal money talk is dropped even with technical words nearby', () => {
  const drop = [
    'Sent the invoice to the client for September',
    'Invoiced the client for the API work',
    'Monthly retainer for the ads integration',
    'Refunds owed to the client after the webhook outage',
    'Chasing an overdue payment from the client',
    'They still owe me for the Stripe integration',
    'Client hasn\'t paid for the endpoint work',
    'Negotiating my rate for the API contract',
    'Contract renewal and pricing negotiation',
    'Raised my hourly rate for the integration work',
    'Late fees on the unpaid balance',
    'I owe them a refund',
  ]
  for (const s of drop) {
    assert.ok(isBillingAngle({ title: s, why: '' }), `angle kept: ${s}`)
    assert.ok(isBillingCapability({ name: s, did: 'x', proof: 'y' }), `capability kept: ${s}`)
  }
  // ambiguous billing words with NO technical context still drop
  assert.ok(isBillingCapability({ name: 'Automated invoice reconciliation', did: 'x', proof: '' }))
})

await t('billing quotes: technical item context keeps an ambiguous quote; personal quote always drops', () => {
  const q = (text: string) => ({ text, timestamp: '2026-01-01T00:00:00.000Z' })
  assert.ok(!hasBillingQuote({ name: 'Stripe webhook handler', did: 'x', proof: '', quotes: [q('the payment went through on the second try')] } as any))
  assert.ok(hasBillingQuote({ name: 'Neutral', did: 'x', proof: '', quotes: [q('the payment went through on the second try')] } as any))
  assert.ok(hasBillingQuote({ name: 'Stripe webhook handler', did: 'x', proof: '', quotes: [q('remind them the retainer is due Friday')] } as any))
  const r = { billingDropped: 0, notDone: 0 }
  const c = readCandidates(JSON.stringify({
    angles: [{ title: 'Meta ads API spend caps', why: 'billed spend overshoot', quotes: [] }, { title: 'Chasing an unpaid invoice', why: 'x', quotes: [] }],
    capabilities: [
      { name: 'Stripe payment webhook', did: 'verified signatures', evidence: 'shipped', proof: 'tests pass', quotes: [] },
      { name: 'Billing API rate limits', did: 'backoff on 429', evidence: 'root-caused', proof: 'logs', quotes: [] },
      { name: 'Retainer reminders', did: 'cron', evidence: 'shipped', proof: '', quotes: [] },
    ],
  }), 10, 10, r)
  assert.deepEqual(c.angles.map(a => a.title), ['Meta ads API spend caps'])
  assert.deepEqual(c.capabilities.map(x => x.name), ['Stripe payment webhook', 'Billing API rate limits'])
  assert.equal(r.billingDropped, 2)
})

const { refuseOutPath, PROFILE_FILE, HWM_FILE } = await import('../src/content/lens-paths.js')
await t('--out guard: missing value / profile file / HWM file refused; normal path allowed', async () => {
  const pd = join(tmp, 'outguard'); mkdirSync(pd, { recursive: true })
  assert.ok(refuseOutPath(undefined, pd))
  assert.ok(refuseOutPath('', pd))
  assert.ok(refuseOutPath('--cwd', pd))
  assert.ok(refuseOutPath(join(pd, PROFILE_FILE), pd))
  assert.ok(refuseOutPath(join(pd, HWM_FILE), pd))
  assert.ok(refuseOutPath(join(pd, 'sub', '..', PROFILE_FILE), pd))
  assert.ok(refuseOutPath(join(tmp, 'elsewhere', PROFILE_FILE), pd)) // any project's profile
  writeFileSync(join(pd, PROFILE_FILE), 'x')
  const { symlinkSync } = await import('node:fs')
  symlinkSync(join(pd, PROFILE_FILE), join(pd, 'review-link.md'))
  assert.ok(refuseOutPath(join(pd, 'review-link.md'), pd)) // symlink to the profile
  assert.equal(refuseOutPath(join(pd, 'osb', 'x', 'lens-backfill.md'), pd), null)
  process.env.OPENROUTER_API_KEY = 'dummy-not-a-key'
  await assert.rejects(runCompactionLens({ sessionId: 'abc', cwd: '/tmp/x', outPath: join(pd, PROFILE_FILE) }), /must not be/)
  await assert.rejects(runCompactionLens({ sessionId: 'abc', cwd: '/tmp/x', outPath: '' }), /requires a file path/)
})

await t('worker: --out with no value aborts (exit 1), takes no lock, writes nothing', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const sid = 'wkr-out-test'
  const pd = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-zz-wkr')
  mkdirSync(join(pd, 'osb', sid), { recursive: true })
  const { copyFileSync } = await import('node:fs')
  copyFileSync(dbPath, join(pd, 'osb', sid, 'session.db'))
  const worker = fileURLToPath(new URL('../src/content/compaction-lens-worker.ts', import.meta.url))
  for (const args of [['--out'], ['--out', '--max-windows', '1'], ['--out', join(pd, PROFILE_FILE)]]) {
    const res = spawnSync('npx', ['tsx', worker, '--backfill', sid, ...args], {
      env: { ...process.env, OPENROUTER_API_KEY: 'dummy-not-a-key' }, encoding: 'utf-8', timeout: 60_000,
    })
    assert.equal(res.status, 1, `args ${args.join(' ')}: exit ${res.status} ${res.stderr}`)
    assert.ok(/--out/.test(res.stderr), res.stderr)
    assert.ok(!existsSync(join(pd, '.content-lens.lock')), 'lock left behind')
    assert.ok(!existsSync(join(pd, PROFILE_FILE)), 'profile written')
    assert.ok(!existsSync(join(pd, HWM_FILE)), 'hwm written')
  }
})

await t('outPath set: updateHwm:true is ignored, profile untouched, review file written', async () => {
  const sid = 'hwm-ignore-test'
  const pd = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-zz-hwm')
  mkdirSync(join(pd, 'osb', sid), { recursive: true })
  const { copyFileSync } = await import('node:fs')
  copyFileSync(dbPath, join(pd, 'osb', sid, 'session.db'))
  const model = lensModel()
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } })
    if (u.endsWith('/models')) return json({ data: [{ id: model, context_length: 200_000, pricing: { prompt: '0.0000001', completion: '0.0000001' } }] })
    if (u.endsWith('/chat/completions')) {
      const content = JSON.stringify({ angles: [], capabilities: [{
        name: 'Gateway x-forwarded-host fix', did: 'found the missing header', evidence: 'root-caused', proof: 'row 2',
        quotes: [{ text: 'the x-forwarded-host header was missing on the proxy hop', timestamp: '2026-01-01T10:01:00.000Z', row: 2, speaker: 'assistant' }],
      }] })
      return json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0001 } })
    }
    return json({ hits: [], nbHits: 0 })
  }) as any
  try {
    process.env.OPENROUTER_API_KEY = 'dummy-not-a-key'
    const out = join(pd, 'osb', sid, 'review.md')
    const r = await runCompactionLens({ sessionId: sid, mode: 'backfill', outPath: out, updateHwm: true })
    assert.equal(r.status, 'written')
    assert.equal(r.outPath, out)
    assert.ok(existsSync(out))
    assert.equal(readHwm(pd, sid), 0)
    assert.equal(r.hwmAfter, 0)
    assert.ok(!existsSync(join(pd, PROFILE_FILE)))
    assert.ok(!existsSync(join(pd, HWM_FILE)))
  } finally {
    globalThis.fetch = realFetch
  }
})

await t('reveal is per-piece opt-in; default redacts', () => {
  const rv = loadClientRedactor(null, { reveal: ['Audos'] }).redact('Audos and Prehype')
  assert.ok(/Audos/.test(rv) && !/Prehype/.test(rv))
  assert.ok(!/Audos/.test(R.redact('Audos')))
})

const recs = loadConversationRows(dbPath, 0).records
const idx = buildRecordIndex(recs)
await t('quote verification keeps real quote, drops fabricated/paraphrased', () => {
  const good = verifyQuote({ text: 'the x-forwarded-host header was missing on the proxy hop', timestamp: '2026-01-01T10:01:00.000Z', row: 2 }, idx)
  assert.ok(good && good.row === 2)
  assert.equal(verifyQuote({ text: 'we completely rewrote the entire gateway in Rust overnight', timestamp: '2026-01-01T10:01:00.000Z', row: 2 }, idx), null)
  assert.equal(verifyQuote({ text: 'THINKING_SECRET_TEXT should never be read', timestamp: '2026-01-01T10:02:00.000Z', row: 3 }, idx), null)
  const items = [
    { name: 'a', quotes: [{ text: 'Deployed and verified; all tests pass now', timestamp: '2026-01-01T10:06:00.000Z', row: 7 }] },
    { name: 'b', quotes: [{ text: 'fabricated sentence that never occurred anywhere', timestamp: '2026-01-01T10:06:00.000Z', row: 7 }] },
  ]
  const v = verifyItems(items as any, idx)
  assert.equal(v.kept.length, 1); assert.equal(v.dropped, 1)
})

await t('capabilities: plans excluded; shipped/root-caused kept', () => {
  const s = splitByEvidence(readCapabilities([
    { name: 'a', evidence: 'shipped', did: '', proof: '', quotes: [] },
    { name: 'b', evidence: 'root-caused', did: '', proof: '', quotes: [] },
    { name: 'c', evidence: 'planned', did: '', proof: '', quotes: [] },
    { name: 'd', evidence: '', did: '', proof: '', quotes: [] },
  ], 10))
  assert.deepEqual(s.done.map(c => c.name), ['a', 'b'])
  assert.equal(s.notDone, 2)
})

await t('model: default override via env, window=25%, hard cap enforced', () => {
  assert.equal(WINDOW_FRACTION, 0.25)
  process.env.OSBORN_CONTENT_LENS_MODEL = 'foo/bar'
  assert.equal(lensModel(), 'foo/bar')
  delete process.env.OSBORN_CONTENT_LENS_MODEL
  process.env.OSBORN_LENS_MAX_CALLS = '2'
  const b = new Budget({ id: 'x', contextLength: 1000, promptPerTok: 0, completionPerTok: 0, verified: true } as any)
  assert.ok(b.take(1, 1) && b.take(1, 1) && !b.take(1, 1))
  delete process.env.OSBORN_LENS_MAX_CALLS
  process.env.OSBORN_LENS_MAX_COST_USD = '0.01'
  const c = new Budget({ id: 'x', contextLength: 1000, promptPerTok: 1, completionPerTok: 1, verified: true } as any)
  assert.ok(!c.take(100, 100))
})

await t('no key: launcher does not spawn; run returns no-key', async () => {
  delete process.env.OPENROUTER_API_KEY
  const r = launchCompactionLens({ sessionId: 'abc', cwd: '/tmp/x' })
  assert.equal(r.status, 'no-key')
  assert.equal((await runCompactionLens({ sessionId: 'abc', cwd: '/tmp/x' })).status, 'no-key')
  process.env.OPENROUTER_API_KEY = '  '
  assert.equal(launchCompactionLens({ sessionId: 'abc', cwd: '/tmp/x' }).status, 'no-key')
})

await t('kill switch: OSBORN_CONTENT_LENS=0 disables', () => {
  process.env.OPENROUTER_API_KEY = 'dummy-not-a-key'; process.env.OSBORN_CONTENT_LENS = '0'
  assert.equal(launchCompactionLens({ sessionId: 'abc', cwd: '/tmp/x' }).status, 'disabled')
  delete process.env.OSBORN_CONTENT_LENS
})

await t('no unlocked run: fresh lock -> locked; uncreatable dir -> unlockable; never spawned', () => {
  process.env.OPENROUTER_API_KEY = 'dummy-not-a-key'
  const cwd = '/zz/locktest'
  const slug = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', cwd.replace(/\//g, '-'))
  mkdirSync(slug, { recursive: true })
  writeFileSync(join(slug, '.content-lens.lock'), '{}')
  assert.equal(launchCompactionLens({ sessionId: 'abc', cwd }).status, 'locked')
  const cwd2 = '/zz/blocked'
  const slug2 = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', cwd2.replace(/\//g, '-'))
  writeFileSync(slug2, 'i am a file, not a dir')
  assert.equal(launchCompactionLens({ sessionId: 'abc', cwd: cwd2 }).status, 'unlockable')
  assert.equal(launchCompactionLens({ sessionId: 'abc' }).status, 'unlockable')
})

await t('spawn path returns synchronously in milliseconds (detached)', () => {
  process.env.OPENROUTER_API_KEY = 'dummy-not-a-key'
  const cwd = '/zz/fast'
  const t0 = performance.now()
  const r = launchCompactionLens({ sessionId: 'nosuchsession', cwd })
  const ms = performance.now() - t0
  assert.equal(r.status, 'spawned')
  assert.ok(ms < 250, `took ${ms}ms`)
  console.log(`      spawn return ${ms.toFixed(1)}ms`)
})

console.log(`\n${pass} passed`)
