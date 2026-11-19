// Run: cd frontend && npx --yes tsx tests/bug-report.test.ts
// Spec: buildBugReportRow mirrors the agent /report-bug validation (title >= 3,
// description required, severity enum) + the bug_reports column limits, and always
// stamps the reporter + a non-null osborn_version so the RLS insert never fails.
import { buildBugReportRow, ownReportExists, reportRowId, type BugReportInput } from '../src/lib/bug-report'

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(a === b, `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const USER = { id: 'u-123', email: 'founder@example.com' }
const base: BugReportInput = { type: 'bug', severity: 'high', title: 'Mic loops', description: 'The mic dialog reopens.' }

t('valid input builds a stamped row', () => {
  const r = buildBugReportRow(base, USER)
  ok(r.ok, 'should be ok')
  if (!r.ok) return
  eq(r.row.reporter_user_id, 'u-123', 'reporter id')
  eq(r.row.reporter_email, 'founder@example.com', 'reporter email')
  eq(r.row.severity, 'high', 'severity')
  eq(r.row.title, 'Mic loops', 'title')
})

t('title under 3 chars is rejected', () => {
  const r = buildBugReportRow({ ...base, title: 'hi' }, USER)
  ok(!r.ok, 'should fail')
})

t('empty description is rejected', () => {
  const r = buildBugReportRow({ ...base, description: '   ' }, USER)
  ok(!r.ok, 'should fail')
})

t('bad type is rejected', () => {
  const r = buildBugReportRow({ ...base, type: 'nonsense' as any }, USER)
  ok(!r.ok, 'should fail')
})

t('invalid severity falls back to medium', () => {
  const r = buildBugReportRow({ ...base, severity: 'catastrophic' as any }, USER)
  ok(r.ok, 'should be ok')
  if (r.ok) eq(r.row.severity, 'medium', 'severity fallback')
})

t('missing osborn_version defaults to web (NOT NULL column)', () => {
  const r = buildBugReportRow(base, USER)
  if (r.ok) eq(r.row.osborn_version, 'web', 'version default')
})

t('agent-supplied context is carried through', () => {
  const r = buildBugReportRow({ ...base, osborn_version: '0.9.273', voice_mode: 'direct', session_id: 's1', sandbox_id: 'm1' }, USER)
  if (r.ok) { eq(r.row.osborn_version, '0.9.273', 'version'); eq(r.row.voice_mode, 'direct', 'voice_mode'); eq(r.row.session_id, 's1', 'session'); eq(r.row.sandbox_id, 'm1', 'sandbox') }
})

t('title and description are truncated to column limits', () => {
  const r = buildBugReportRow({ ...base, title: 'x'.repeat(500), description: 'y'.repeat(9000) }, USER)
  if (r.ok) { eq(r.row.title.length, 200, 'title len'); eq(r.row.description.length, 8000, 'desc len') }
})

t('tags are filtered to strings and capped at 20', () => {
  const tags = Array.from({ length: 30 }, (_, i) => `t${i}`)
  const r = buildBugReportRow({ ...base, tags: [...tags, 7 as any, '', '  '] }, USER)
  if (r.ok) { eq(r.row.tags.length, 20, 'tag cap'); ok(r.row.tags.every((x) => typeof x === 'string' && x.trim()), 'all non-empty strings') }
})

t('null email is tolerated', () => {
  const r = buildBugReportRow(base, { id: 'u-9', email: null })
  if (r.ok) eq(r.row.reporter_email, null, 'null email')
})

t('the agent reportId is the row id, so a redelivery cannot file twice (#297)', () => {
  const rid = '3F2504E0-4F89-41D3-9A0C-0305E82C3301'
  const mint = () => 'minted'
  const a = reportRowId({ source: 'agent', reportId: rid }, mint)
  eq(a.id, rid.toLowerCase(), 'reportId used'); eq(a.idempotent, true, 'idempotent')
  eq(reportRowId({ source: 'agent', reportId: rid }, mint).id, a.id, 'same id on redelivery')
  for (const m of [undefined, null, {}, { reportId: 'abc' }, { reportId: 42 }]) {
    const r = reportRowId(m, mint)
    eq(r.id, 'minted', `fresh id for ${JSON.stringify(m)}`); eq(r.idempotent, false, 'not idempotent')
  }
})

// A fake bug_reports table: rows the query filters reach, with the filters it was given.
const fakeDb = (rows: { id: string; reporter_user_id: string }[], fail = false) => ({
  from: (table: string) => {
    eq(table, 'bug_reports', 'table')
    const filters: Record<string, string> = {}
    const q = {
      select: () => q,
      eq: (col: string, v: string) => { filters[col] = v; return q },
      maybeSingle: async () => fail ? { data: null, error: { message: 'boom' } }
        : { data: rows.find((r) => Object.entries(filters).every(([k, v]) => (r as any)[k] === v)) ?? null, error: null },
    }
    return q
  },
})

const asyncTests: Promise<void>[] = []
const at = (name: string, fn: () => Promise<void>) => asyncTests.push(fn().then(() => { results.push([name, true]) }, (e) => { results.push([name, false, String(e.message)]) }))
const RID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
at('a redelivery of my own report is found (#297)', async () => {
  eq(await ownReportExists(fakeDb([{ id: RID, reporter_user_id: 'u-1' }]), RID, 'u-1'), true, 'own row')
})
at("another user's report with the same id is never a duplicate for me", async () => {
  eq(await ownReportExists(fakeDb([{ id: RID, reporter_user_id: 'u-2' }]), RID, 'u-1'), false, 'foreign row')
})
at('no row, or a failed lookup, is not a duplicate', async () => {
  eq(await ownReportExists(fakeDb([]), RID, 'u-1'), false, 'no row')
  eq(await ownReportExists(fakeDb([{ id: RID, reporter_user_id: 'u-1' }], true), RID, 'u-1'), false, 'lookup error')
})

void Promise.all(asyncTests).then(() => {
  let fail = 0
  for (const [n, p, m] of results) { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? `\n      ${m}` : ''}`); if (!p) fail++ }
  console.log(`\n${results.length - fail}/${results.length} passed`)
  process.exit(fail ? 1 : 0)
})
