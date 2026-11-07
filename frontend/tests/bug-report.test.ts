// Run: cd frontend && npx --yes tsx tests/bug-report.test.ts
// Spec: buildBugReportRow mirrors the agent /report-bug validation (title >= 3,
// description required, severity enum) + the bug_reports column limits, and always
// stamps the reporter + a non-null osborn_version so the RLS insert never fails.
import { buildBugReportRow, type BugReportInput } from '../src/lib/bug-report'

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

let fail = 0
for (const [n, p, m] of results) { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? `\n      ${m}` : ''}`); if (!p) fail++ }
console.log(`\n${results.length - fail}/${results.length} passed`)
process.exit(fail ? 1 : 0)
