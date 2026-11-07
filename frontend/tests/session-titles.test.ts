// Run: cd frontend && npx --yes tsx tests/session-titles.test.ts
// Spec (lane L2b frontend, "dashtitles"): the agent's /sessions + sessions_list
// entries now carry `title` (already cleaned), `firstTs` and `lastActivityAt`.
// Every session list (dashboard prettySessionPreview + CONTINUE card,
// sessions.ts deriveSessionTitle, SessionBrowser, ActivityFeed, mobile list):
//   - prefers the agent's `title`; otherwise cleans the old `lastMessage` preview
//   - never shows a title starting with `[` or `<`, or an empty one ->
//     "Untitled session"
//   - uses `lastActivityAt` (fallback `timestamp`) for recency + sorting
//   - stays compatible with older agents that send none of the new fields.
import {
  deriveSessionTitle,
  sessionDisplayTitle,
  sessionActivityTime,
  sortSessionsByActivity,
  groupSessionsByDate,
  prettySessionPreview,
  UNTITLED_SESSION,
} from '../src/lib/sessions'
import { mobileSessionTitle, mobileSessionActivityTime, sortMobileSessions } from '../../mobile/lib/session-title'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) }
}
const BAD_START = /^[\[<]/

const T = '[time: 2026-11-06 16:14 local] '
const tail = '<session_tail>\n2026-09-10T22:49:35  User: [Request interrupted by user]\n</session_tail>'
const interrupted = (u: string) => [
  '[INTERRUPTED] The user interrupted your response mid-speech.', '',
  'What the user heard before cutoff:', '"part one"', '',
  `User's message: "${u}"`, '',
  'CONTEXT PRESERVATION (READ THIS):', 'The user has NO memory of unheard content.',
].join('\n')

const ts = (iso: string) => iso

// ── 1. Agent title preferred ───────────────────────────────────────────────
{
  const s = { title: 'Fix the dashboard titles', lastMessage: T + 'something else entirely', timestamp: ts('2026-11-01T00:00:00Z') }
  ok('display: prefers agent title', sessionDisplayTitle(s) === 'Fix the dashboard titles', sessionDisplayTitle(s))
  ok('derive(obj): prefers agent title', deriveSessionTitle(s) === 'Fix the dashboard titles', deriveSessionTitle(s))
  const pv = prettySessionPreview(s)
  ok('pretty: prefers agent title', pv.kind === 'chat' && pv.text === 'Fix the dashboard titles', JSON.stringify(pv))
  ok('mobile: prefers agent title', mobileSessionTitle(s) === 'Fix the dashboard titles', mobileSessionTitle(s))
}
// title present but unusable -> falls back to the cleaned preview
{
  const s = { title: '[favorited] x', lastMessage: T + 'real words here' }
  ok('display: bracket title ignored, preview used', sessionDisplayTitle(s) === 'real words here', sessionDisplayTitle(s))
  const s2 = { title: '   ', lastMessage: 'hello world' }
  ok('display: blank title ignored', sessionDisplayTitle(s2) === 'hello world', sessionDisplayTitle(s2))
  const s3 = { title: '<session_tail>junk', lastMessage: 'hello world' }
  ok('display: angle title ignored', sessionDisplayTitle(s3) === 'hello world', sessionDisplayTitle(s3))
}

// ── 2. Fallback cleaning (old agents: no title) ────────────────────────────
const fallbackCases: [string, string, string][] = [
  ['[time:] prefix', T + 'New finding - two chat tabs collide', 'New finding - two chat tabs collide'],
  ['<session_tail> block', tail + '\n\n' + T + 'hello there', 'hello there'],
  ['[INTERRUPTED] template', interrupted(T + 'what about the second tab?'), 'what about the second tab?'],
]
for (const [name, raw, want] of fallbackCases) {
  const s = { lastMessage: raw, timestamp: '2026-11-01T00:00:00Z' }
  const d = sessionDisplayTitle(s)
  ok(`display fallback: ${name}`, d === want, JSON.stringify(d))
  const pv = prettySessionPreview(s)
  ok(`pretty fallback: ${name}`, pv.text === want && !BAD_START.test(pv.text), JSON.stringify(pv))
  const m = mobileSessionTitle(s)
  ok(`mobile fallback: ${name}`, m === want, JSON.stringify(m))
  const dt = deriveSessionTitle(raw)
  ok(`derive(string) fallback: ${name}`, !BAD_START.test(dt) && !/\[time:|session_tail|INTERRUPTED/.test(dt) && dt !== UNTITLED_SESSION, JSON.stringify(dt))
  const dto = deriveSessionTitle(s)
  ok(`derive(obj) fallback: ${name}`, dto === dt, JSON.stringify([dto, dt]))
}
ok('derive: [time:] title text (6-word cap)', deriveSessionTitle(T + 'New finding - two chat tabs collide') === 'New finding - two chat tabs…', deriveSessionTitle(T + 'New finding - two chat tabs collide'))
ok('derive(obj): agent title capped, not filler-stripped', deriveSessionTitle({ title: 'How to deploy the agent' }) === 'How to deploy the agent', deriveSessionTitle({ title: 'How to deploy the agent' }))
ok('derive: [INTERRUPTED] trailing marker', deriveSessionTitle('fix the bug [INTERRUPTED]') === 'Fix the bug', deriveSessionTitle('fix the bug [INTERRUPTED]'))

// ── 3. Empty / notice-only / bracket leftovers -> "Untitled session" ───────
ok('UNTITLED_SESSION constant', UNTITLED_SESSION === 'Untitled session')
const emptyCases: [string, { title?: string | null; lastMessage?: string | null }][] = [
  ['no fields at all', {}],
  ['empty strings', { title: '', lastMessage: '' }],
  ['whitespace', { title: '  ', lastMessage: ' \n ' }],
  ['null fields', { title: null, lastMessage: null }],
  ['bare session_tail', { lastMessage: tail }],
  ['bare time tag', { lastMessage: '[time: 2026-11-06 16:14 local]' }],
  ['notice only', { lastMessage: '[favorited] the user favorited a message' }],
  ['unknown bracket', { lastMessage: '[weird-marker] stuff' }],
  ['unknown angle', { lastMessage: '<foo-bar>stuff' }],
]
for (const [name, s] of emptyCases) {
  ok(`display empty: ${name}`, sessionDisplayTitle(s) === 'Untitled session', JSON.stringify(sessionDisplayTitle(s)))
  ok(`derive(obj) empty: ${name}`, deriveSessionTitle(s) === 'Untitled session', JSON.stringify(deriveSessionTitle(s)))
  ok(`mobile empty: ${name}`, mobileSessionTitle(s) === 'Untitled session', JSON.stringify(mobileSessionTitle(s)))
  const pv = prettySessionPreview(s)
  ok(`pretty empty: ${name}`, pv.text === 'Untitled session', JSON.stringify(pv))
}
ok('derive(string) undefined', deriveSessionTitle(undefined) === 'Untitled session')
ok('derive(string) empty', deriveSessionTitle('') === 'Untitled session')
ok('derive(string) bare tail', deriveSessionTitle(tail) === 'Untitled session', deriveSessionTitle(tail))
ok('derive(string) unknown bracket', deriveSessionTitle('[weird] x') === 'Untitled session', deriveSessionTitle('[weird] x'))
// Existing behaviour kept
ok('derive: continuation label kept', deriveSessionTitle('This session is being continued from a previous conversation that ran out of context.') === 'Continued session')
ok('derive: task envelope -> not raw markup', !BAD_START.test(deriveSessionTitle('<task-notification> <task-id>a599aaeeffff0000</task-id>')))
ok('derive: filler + 6-word cap', deriveSessionTitle('can you help fix the very long dashboard title bug please') === 'Help fix the very long dashboard…', deriveSessionTitle('can you help fix the very long dashboard title bug please'))

// Meeting/task classification still works on the raw preview
{
  const pv = prettySessionPreview({ lastMessage: '[MEETING — bot123]: Alice: we should ship it' })
  ok('pretty: meeting kind', pv.kind === 'meeting' && pv.text === 'we should ship it', JSON.stringify(pv))
  const pv2 = prettySessionPreview({ title: 'Weekly sync', lastMessage: '[MEETING — bot123]: Alice: we should ship it' })
  ok('pretty: meeting prefers title', pv2.kind === 'meeting' && pv2.text === 'Weekly sync', JSON.stringify(pv2))
  const pv3 = prettySessionPreview({ lastMessage: '[MEETING — bot123]:' })
  ok('pretty: empty meeting body', pv3.kind === 'meeting' && pv3.text === 'Meeting notes', JSON.stringify(pv3))
  const pv4 = prettySessionPreview({ lastMessage: '<task-notification> <task-id>abc</task-id>' })
  ok('pretty: task kind', pv4.kind === 'task' && !BAD_START.test(pv4.text), JSON.stringify(pv4))
  const pv5 = prettySessionPreview({ lastMessage: '[SYSTEM] You are now in a meeting (Recall bot ID: x)' })
  ok('pretty: system meeting', pv5.kind === 'meeting' && !BAD_START.test(pv5.text), JSON.stringify(pv5))
  const pv6 = prettySessionPreview({ lastMessage: '[SYSTEM] something internal' })
  ok('pretty: other [SYSTEM] never leaks', !BAD_START.test(pv6.text) && pv6.text.length > 0, JSON.stringify(pv6))
}

// ── 4. lastActivityAt for recency + sorting ────────────────────────────────
{
  const a = { sessionId: 'a', timestamp: '2026-11-05T00:00:00Z', lastActivityAt: '2026-11-01T00:00:00Z', messageCount: 1 }
  const b = { sessionId: 'b', timestamp: '2026-11-02T00:00:00Z', lastActivityAt: '2026-11-04T00:00:00Z', messageCount: 1 }
  const c = { sessionId: 'c', timestamp: '2026-11-03T00:00:00Z', messageCount: 1 } // old agent: no lastActivityAt
  const d = { sessionId: 'd', timestamp: '2026-11-06T00:00:00Z', lastActivityAt: 'not-a-date', messageCount: 1 }
  ok('activity: prefers lastActivityAt', sessionActivityTime(a) === '2026-11-01T00:00:00Z')
  ok('activity: falls back to timestamp', sessionActivityTime(c) === '2026-11-03T00:00:00Z')
  ok('activity: invalid lastActivityAt falls back', sessionActivityTime(d) === '2026-11-06T00:00:00Z', sessionActivityTime(d))
  ok('activity: null lastActivityAt falls back', sessionActivityTime({ timestamp: '2026-11-03T00:00:00Z', lastActivityAt: null }) === '2026-11-03T00:00:00Z')
  const input = [a, b, c, d]
  const sorted = sortSessionsByActivity(input)
  ok('sort: by lastActivityAt desc', sorted.map((s) => s.sessionId).join('') === 'dbca', sorted.map((s) => s.sessionId).join(''))
  ok('sort: does not mutate input', input.map((s) => s.sessionId).join('') === 'abcd')
  ok('sort: CONTINUE pick is most recently active', sortSessionsByActivity([a, b])[0].sessionId === 'b')
  const old = sortSessionsByActivity([c, { sessionId: 'e', timestamp: '2026-11-04T00:00:00Z', messageCount: 1 }])
  ok('sort: old agent (timestamp only)', old.map((s) => s.sessionId).join('') === 'ec')

  const ms = sortMobileSessions([a, b, c, d])
  ok('mobile sort: by lastActivityAt desc', ms.map((s) => s.sessionId).join('') === 'dbca', ms.map((s) => s.sessionId).join(''))
  ok('mobile activity: fallback', mobileSessionActivityTime(c) === c.timestamp && mobileSessionActivityTime(a) === a.lastActivityAt)

  // Date grouping follows activity, not mtime
  const now = new Date()
  const todayIso = new Date(now.getTime() - 60_000).toISOString()
  const oldIso = new Date(now.getTime() - 30 * 86400000).toISOString()
  const g = groupSessionsByDate([
    { sessionId: 'x', timestamp: todayIso, lastActivityAt: oldIso, messageCount: 1 },
    { sessionId: 'y', timestamp: oldIso, lastActivityAt: todayIso, messageCount: 1 },
  ])
  const today = g.find((x) => x.label === 'Today')
  const older = g.find((x) => x.label === 'Older')
  ok('group: uses lastActivityAt', today?.sessions.map((s) => s.sessionId).join('') === 'y' && older?.sessions.map((s) => s.sessionId).join('') === 'x', JSON.stringify(g))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
