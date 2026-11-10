// Run: cd frontend && npx --yes tsx tests/github-issue-mirror.test.ts
// Spec (issue #44): the GitHub mirror is privacy-safe (only report text + product
// context travel — never reporter/session/machine ids), dedup fingerprints are
// stable across trivial title variation, and the dedup marker is present + matches
// between a new issue and its duplicate comment.
import {
  buildIssueContent,
  buildDuplicateComment,
  reportFingerprint,
  type MirrorReport,
} from '../src/lib/github-issue-mirror'

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(a === b, `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const base: MirrorReport = {
  type: 'bug',
  severity: 'high',
  title: 'Mic dialog reopens',
  description: 'The microphone permission dialog reopens every few seconds.',
  reproduction_notes: '1. Join a room\n2. Deny mic\n3. Watch it loop',
  tags: ['voice', 'mic'],
  osborn_version: '0.9.273',
  voice_mode: 'pipeline',
}

t('bug issue: title prefix, body content, labels', () => {
  const { title, body, labels } = buildIssueContent(base)
  eq(title, '[bug] Mic dialog reopens', 'title')
  ok(body.includes('The microphone permission dialog reopens'), 'body has description')
  ok(body.includes('Watch it loop'), 'body has reproduction')
  ok(body.includes('`0.9.273`'), 'body has version context')
  ok(body.includes('`pipeline`'), 'body has voice mode')
  ok(labels.includes('bug') && labels.includes('user-report'), 'labels bug + user-report')
})

t('feature issue: enhancement label + [feature] prefix', () => {
  const { title, labels } = buildIssueContent({ ...base, type: 'feature', title: 'Add dark mode' })
  eq(title, '[feature] Add dark mode', 'feature title')
  ok(labels.includes('enhancement') && labels.includes('user-report'), 'labels enhancement + user-report')
  ok(!labels.includes('bug'), 'no bug label on feature')
})

t('PRIVACY: account/session/machine internals never reach the body', () => {
  // Cast with extra private fields a careless caller might pass — the function
  // must ignore anything outside the MirrorReport allowlist.
  const leaky = {
    ...base,
    reporter_email: 'founder@example.com',
    reporter_user_id: 'user-uuid-abc-123',
    session_id: 'sess-SECRET-999',
    sandbox_id: 'osborn-machine-deadbeef',
    log_url: 'bug-logs/secret.log',
    metadata: { apiKey: 'sk-ant-LEAKED' },
  } as unknown as MirrorReport
  const { title, body } = buildIssueContent(leaky)
  const haystack = `${title}\n${body}`
  for (const secret of [
    'founder@example.com',
    'user-uuid-abc-123',
    'sess-SECRET-999',
    'osborn-machine-deadbeef',
    'bug-logs/secret.log',
    'sk-ant-LEAKED',
  ]) {
    ok(!haystack.includes(secret), `must not leak "${secret}"`)
  }
  // ...but the legitimate report text is still present.
  ok(haystack.includes('Mic dialog reopens'), 'keeps the report title')
  ok(haystack.includes('reopens every few seconds'), 'keeps the description')
})

t('fingerprint stable across case + punctuation; differs by type', () => {
  const a = reportFingerprint('bug', 'Mic dialog reopens')
  const b = reportFingerprint('bug', '  MIC   dialog, reopens!! ')
  eq(a, b, 'trivial title variants collapse to the same fingerprint')
  ok(reportFingerprint('feature', 'Mic dialog reopens') !== a, 'type changes the fingerprint')
  ok(reportFingerprint('bug', 'totally different') !== a, 'different title → different fingerprint')
})

t('dedup marker present in issue body and matches the duplicate comment', () => {
  const issue = buildIssueContent(base).body
  const comment = buildDuplicateComment(base)
  const fp = reportFingerprint(base.type, base.title)
  const marker = `osborn-fp-${fp}`
  ok(issue.includes(marker), 'issue body carries the fingerprint marker')
  ok(comment.includes(marker), 'duplicate comment carries the same fingerprint marker')
  ok(comment.includes('Another in-app report matched'), 'comment reads as a duplicate')
})

t('empty title/description fall back to safe placeholders', () => {
  const { title, body } = buildIssueContent({ ...base, title: '', description: '' })
  eq(title, '[bug] Untitled report', 'empty title placeholder')
  ok(body.includes('_No description provided._'), 'empty description placeholder')
})

// ---- report ----
let failed = 0
for (const [name, pass, err] of results) {
  console.log(`${pass ? '✅' : '❌'} ${name}${err ? ` — ${err}` : ''}`)
  if (!pass) failed++
}
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed) process.exit(1)
