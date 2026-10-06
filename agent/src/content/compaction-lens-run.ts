/**
 * compaction-lens-run.ts — DEV harness for the content lens (excluded from the
 * published package via .npmignore). No live compaction needed.
 *
 *   npx tsx src/content/compaction-lens-run.ts estimate [sid]
 *       no model calls: model info (free GET), windows for a FULL backfill,
 *       rows/tokens per window, estimated cost; secret + redaction counts.
 *   npx tsx src/content/compaction-lens-run.ts sample [sid] [outPath]
 *       ONE backfill window from row 0 → scratch file (never content-profile.md,
 *       never moves the high-water mark).
 *   npx tsx src/content/compaction-lens-run.ts backfill [sid]
 *       whole session → appends to content-profile.md (cost-capped).
 *   npx tsx src/content/compaction-lens-run.ts verify [sid]
 *       offline: DB-row quote verifier accepts a real quote, drops fabricated /
 *       wrong-timestamp ones.
 *   npx tsx src/content/compaction-lens-run.ts redact      offline client-redaction checks
 *   npx tsx src/content/compaction-lens-run.ts launch      offline launcher gates
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runCompactionLens, type LensRunReport } from './compaction-lens.js'
import { loadConversationRows, packWindows, resolveSessionDb } from './lens-db.js'
import { getModelInfo, windowTokensFor } from './lens-model.js'
import { buildRecordIndex, verifyQuote } from './lens-quotes.js'
import { isBillingAngle, loadClientRedactor } from './lens-redact.js'
import { launchCompactionLens } from './lens-launch.js'
import { detectSecrets } from './transcript-sanitizer.js'

const DEFAULT_SID = 'c97588f4-5760-4b5b-b789-ab5f65aaed29'
const projectOf = (db: string) => dirname(dirname(dirname(db)))

function mustDb(sid: string): string {
  const db = resolveSessionDb(sid)
  if (!db) throw new Error(`no session.db for ${sid}`)
  return db
}

function printReport(r: LensRunReport): void {
  const { angles, capabilities, entry, ...rest } = r
  console.log(JSON.stringify({ ...rest, windows: r.windows }, null, 1))
  if (entry) console.log(`--- entry (secret hits: ${detectSecrets(entry, { assistant: true }).length}) ---\n${entry}`)
}

async function estimate(sid: string): Promise<void> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY not set')
  const db = mustDb(sid)
  const info = await getModelInfo(key)
  if (!info) throw new Error('model unknown')
  const wt = windowTokensFor(info)
  const red = loadClientRedactor(projectOf(db))
  const t0 = Date.now()
  const load = loadConversationRows(db, 0, red.redact)
  const ws = packWindows(load.records, wt)
  const inTok = ws.reduce((a, w) => a + w.estTokens, 0)
  const mapOut = 3_000 // typical JSON reply (max 8k is the cap's worst case)
  const cost = inTok * info.promptPerTok + ws.length * mapOut * info.completionPerTok + (15_000 * info.promptPerTok + 6_000 * info.completionPerTok)
  const worst = inTok * info.promptPerTok + ws.length * 8_000 * info.completionPerTok + 30_000 * info.promptPerTok + 12_000 * info.completionPerTok
  let secrets = 0
  const tags: Record<string, number> = {}
  for (const r of load.records) {
    secrets += detectSecrets(r.text, { assistant: true }).length
    for (const m of r.text.matchAll(/\[(client|client contact|customer|founder|brand|email|ad account|account id|linkedin account|workspace id|phone|amount)\]/g)) tags[m[1]] = (tags[m[1]] || 0) + 1
  }
  console.log(JSON.stringify({
    db, model: info.id, verified: info.verified, contextLength: info.contextLength,
    pricePerM: { prompt: info.promptPerTok * 1e6, completion: info.completionPerTok * 1e6 },
    windowTokens: wt, rowsRead: load.stats.rowsRead, kept: load.records.length, sanitizerDropped: load.stats.dropped,
    unwrapped: load.stats.unwrapped, chars: load.stats.chars, estInputTokens: inTok, windows: ws.length,
    perWindow: ws.map(w => ({ rows: w.records.length, estTokens: w.estTokens, rowIds: `${w.firstRowId}-${w.lastRowId}` })),
    estCostUsd: +cost.toFixed(3), worstCaseUsd: +worst.toFixed(3), surviving_secret_hits: secrets,
    redactionTags: tags, denylistTerms: red.terms, loadMs: Date.now() - t0,
  }, null, 1))
}

async function sample(sid: string, out: string): Promise<void> {
  const r = await runCompactionLens({
    sessionId: sid, mode: 'backfill', startAfterRowId: 0, maxWindows: 1, outPath: out, updateHwm: false,
    log: m => console.log('  [lens]', m),
  })
  printReport(r)
}

async function backfill(sid: string): Promise<void> {
  printReport(await runCompactionLens({ sessionId: sid, mode: 'backfill', log: m => console.log('  [lens]', m) }))
}

function verify(sid: string): void {
  const db = mustDb(sid)
  const load = loadConversationRows(db, 0, loadClientRedactor(projectOf(db)).redact)
  const recs = load.records.slice(0, 400)
  const idx = buildRecordIndex(recs)
  const src = recs.find(r => r.text.length > 80)!
  const real = { text: src.text.slice(10, 70), timestamp: src.timestamp, row: src.id }
  const checks: [string, boolean][] = [
    ['real quote verifies with row id', verifyQuote(real, idx)?.row === src.id],
    ['fabricated quote dropped', verifyQuote({ text: 'I rewrote the Linux kernel scheduler in Rust over lunch', timestamp: src.timestamp }, idx) === null],
    ['right text, far-off timestamp, no row → dropped', verifyQuote({ text: real.text, timestamp: '1970-01-01T00:00:00.000Z' }, idx) === null],
    ['far-off timestamp but exact row id → source ts', verifyQuote({ ...real, timestamp: '1970-01-01T00:00:00.000Z' }, idx)?.timestamp === src.timestamp],
    ['row hint optional', verifyQuote({ text: real.text, timestamp: real.timestamp }, idx) !== null],
    ['ts slip (+60s) → accepted, SOURCE ts written', (() => {
      const v = verifyQuote({ text: real.text, timestamp: new Date(Date.parse(src.timestamp) + 60_000).toISOString() }, idx)
      return v?.timestamp === src.timestamp && v.tsCorrected === true
    })()],
    ['ts off by 1 day → dropped', verifyQuote({ text: real.text, timestamp: new Date(Date.parse(src.timestamp) + 86_400_000).toISOString() }, idx) === null],
    ['markdown-only difference verifies', (() => {
      const md = recs.find(r => /\*\*[^*\n]{12,80}\*\*/.test(r.text))
      if (!md) return true
      const inner = md.text.match(/\*\*([^*\n]{12,80})\*\*/)![1]
      return verifyQuote({ text: inner, timestamp: md.timestamp }, idx)?.row === md.id
    })()],
  ]
  for (const [n, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`)
  if (checks.some(c => !c[1])) process.exitCode = 1
}

function redact(): void {
  const dir = mkdtempSync(join(tmpdir(), 'lens-redact-'))
  writeFileSync(join(dir, 'content-lens-denylist.json'), JSON.stringify({ terms: { '[client]': ['Zentrix Labs', 'Zentrix'], '[founder]': ['Marisol'] } }))
  const R = loadClientRedactor(dir).redact
  const cases: [string, string, (o: string) => boolean][] = [
    ['names+brand', "Marisol's Zentrix Labs IG page and Zentrix ads", o => !/Marisol|Zentrix/.test(o) && o.includes('[founder]') && o.includes('[client]')],
    ['email', 'ping ops.lead@example.org today', o => o.includes('[email]')],
    ['act_ id', 'POST /act_1234567890123/adsets', o => o.includes('[ad account]') && !o.includes('1234567890123')],
    ['meta page id', 'page id 104512345678901 is not business-owned', o => !o.includes('104512345678901')],
    ['google ads cid', 'customer id 123-456-7890 under the MCC', o => o.includes('[ad account]')],
    ['linkedin urn', 'urn:li:sponsoredAccount:509876543', o => o.includes('[linkedin account]')],
    ['uuid', 'workspace 3f2a9c1e-1b2c-4d5e-8f90-123456789abc', o => o.includes('[workspace id]')],
    ['phone', 'call +1 415 555 0134 or (415) 555-0134', o => !/555/.test(o)],
    ['billing $', 'the invoice was $4,500 for September', o => o.includes('[amount]') && !o.includes('4,500')],
    ['api price kept', 'minimax costs $0.30/M prompt tokens', o => o.includes('$0.30')],
    ['suffix company', 'we shipped it for Northwind Traders LLC', o => o.includes('[client]')],
    ['reveal per piece', 'Zentrix ads', () => loadClientRedactor(dir, { reveal: ['Zentrix'] }).redact('Zentrix ads') === 'Zentrix ads'],
    ['billing angle', '', () => isBillingAngle({ title: 'Chasing an unpaid invoice', why: '' }) && !isBillingAngle({ title: 'Meta ads auth', why: '' })],
  ]
  for (const [n, input, ok] of cases) {
    const o = R(input)
    console.log(`${ok(o) ? 'PASS' : 'FAIL'}  ${n.padEnd(18)} ${input ? JSON.stringify(o) : ''}`)
    if (!ok(o)) process.exitCode = 1
  }
}

function launch(): void {
  const saved = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  console.log('no key →', launchCompactionLens({ sessionId: 'probe', cwd: '/tmp/x' }).status)
  process.env.OPENROUTER_API_KEY = 'dummy-not-used'
  process.env.OSBORN_CONTENT_LENS = '0'
  console.log('killswitch →', launchCompactionLens({ sessionId: 'probe', cwd: '/tmp/x' }).status)
  delete process.env.OSBORN_CONTENT_LENS
  const f = join(mkdtempSync(join(tmpdir(), 'lens-launch-')), 'not-a-dir')
  writeFileSync(f, 'x')
  process.env.CLAUDE_CONFIG_DIR = f // projects/ can't be created under a file
  console.log('unlockable →', launchCompactionLens({ sessionId: 'probe', cwd: '/tmp/x' }).status)
  if (saved) process.env.OPENROUTER_API_KEY = saved
}

const [mode = 'estimate', sid = DEFAULT_SID, out] = process.argv.slice(2)
const defaultOut = `/workspace/.claude/projects/-workspace/osb/${sid}/lens-db-sample.md`
const run: Record<string, () => unknown> = {
  estimate: () => estimate(sid), sample: () => sample(sid, out || defaultOut), backfill: () => backfill(sid),
  verify: () => verify(sid), redact, launch,
}
if (!run[mode]) console.log('modes: estimate | sample | backfill | verify | redact | launch')
else
  Promise.resolve(run[mode]()).catch(err => {
    console.error('harness error:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
