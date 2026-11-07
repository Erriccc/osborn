// Run: cd frontend && npx --yes tsx tests/transcript-clean.test.ts
// Spec (lane L2a, UI#2, #9, #10, #11, #16): frontend/src/lib/transcript-clean.ts is a
// pure port of the agent's shared sanitizer for display. cleanSessionText(text, date?)
// strips the pipeline wrappers ([time:], [INTERRUPTED]/[CONTEXT] templates,
// <session_tail>, <recalled_context>, <system-reminder>, <task-notification>,
// [SYSTEM], [favorited], [welcome-back]) and NEVER returns empty/null: when nothing
// real remains it falls back to "Voice session - <date>". stripSessionWrappers(text)
// returns the cleaned text or null (for callers that hide notice-only turns).
import { cleanSessionText, stripSessionWrappers } from '../src/lib/transcript-clean'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) }
}
const LEAK_RE = /\[time:|<session_tail|<\/session_tail>|\[INTERRUPTED\]|\[CONTEXT\]|\[SYSTEM|<recalled_context|<system-reminder|<task-notification|CONTEXT PRESERVATION|\[favorited\]|\[welcome-back\]/

const T = '[time: 2026-11-06 16:14 local] '
const longRecent = Array.from({ length: 10 }, (_, i) => `Assistant message ${i}: ` + 'lorem ipsum '.repeat(20)).join('\n\n')
const interrupted = (u: string) => [
  '[INTERRUPTED] The user interrupted your response mid-speech.', '',
  'What the user heard before cutoff:', '"part one"', '',
  'WHAT THE USER DID NOT HEAR (you wrote this but it was cut off):', '',
  'Your recent messages (full untruncated — you wrote these):', longRecent, '',
  `User's message: "${u}"`, '',
  'CONTEXT PRESERVATION (READ THIS):', 'The user has NO memory of unheard content.', '',
  'RESPOND with speech first, then act:',
].join('\n')
const contextWrap = (u: string) => [
  '[CONTEXT] You generated speech while the user was already talking. None of it played.', '',
  'What the user is saying now:', `"${u}"`, '',
  'Text you produced that the user did NOT hear:', '"unheard"', '',
  'CONTEXT PRESERVATION (READ THIS):',
].join('\n')
const tail = '<session_tail>\n2026-09-10T22:49:35  User: [Request interrupted by user]\n</session_tail>'
const DATE = new Date(2026, 10, 6, 16, 14)

const cases: [string, string, string][] = [
  ['UI#10 time tag', T + 'New finding - two chat tabs collide', 'New finding - two chat tabs collide'],
  ['UI#16 tail + time', tail + '\n\n' + T + 'hello there', 'hello there'],
  ['UI#2 INTERRUPTED + inner time', interrupted(T + 'what about the second tab?'), 'what about the second tab?'],
  ['UI#16 tail + INTERRUPTED', tail + '\n\n' + interrupted(T + 'and the dashboard'), 'and the dashboard'],
  ['UI#11 CONTEXT + inner time', contextWrap(T + 'keep going'), 'keep going'],
  ['quote inside user text', interrupted('he said "stop" then left'), 'he said "stop" then left'],
  ['recalled_context', '<recalled_context k="5">\nold hit\n</recalled_context>\nreal question', 'real question'],
  ['system-reminder', '<system-reminder>\nnoise\n</system-reminder>\nactual words', 'actual words'],
  ['plain text unchanged', 'um, can we ship it?', 'um, can we ship it?'],
  ['inline tag mention kept', 'the <system-reminder> tag is noisy', 'the <system-reminder> tag is noisy'],
  ['[SYSTEM design] kept', '[SYSTEM design] is cool', '[SYSTEM design] is cool'],
  ['tail mid-text, bare trailing [INTERRUPTED]', 'hello there\n' + tail + '\n\n[INTERRUPTED]', 'hello there'],
  ['MEETING prefix kept readable', '[MEETING — bot1]: Alice: hi', '[MEETING — bot1]: Alice: hi'],
]
for (const [name, input, want] of cases) {
  const got = stripSessionWrappers(input)
  ok(`strip: ${name}`, got === want, JSON.stringify(got))
  ok(`clean: ${name}`, cleanSessionText(input, DATE) === want, JSON.stringify(cleanSessionText(input, DATE)))
}

const notices = [
  T + '[favorited] The user favorited the file plan.md.',
  '[welcome-back] The user just returned after 3 hours away.',
  '[SYSTEM] Session resumed.',
  '[SYSTEM — SILENT CONTROL MESSAGE] do not reply',
  '<task-notification>\n<task-id>x</task-id>\n</task-notification>',
  tail,
  T,
  '',
]
for (const n of notices) {
  ok(`notice -> null: ${JSON.stringify(n.slice(0, 30))}`, stripSessionWrappers(n) === null, JSON.stringify(stripSessionWrappers(n)))
  const c = cleanSessionText(n, DATE)
  ok(`notice -> fallback title: ${JSON.stringify(n.slice(0, 30))}`, /^Voice session - \S/.test(c) && !LEAK_RE.test(c), JSON.stringify(c))
}
ok('fallback never empty without a date', /^Voice session - \S/.test(cleanSessionText('[SYSTEM] x')))
ok('fallback date accepts ISO string', /^Voice session - \S/.test(cleanSessionText('', '2026-11-06T16:14:00Z')))
ok('null/undefined input tolerated', /^Voice session/.test(cleanSessionText(undefined as any)) && stripSessionWrappers(null as any) === null)
ok('truncated INTERRUPTED (100-char preview) never leaks the template', (() => {
  const c = cleanSessionText(interrupted('x').slice(0, 100), DATE)
  return !LEAK_RE.test(c) && c.length > 0
})(), cleanSessionText(interrupted('x').slice(0, 100), DATE))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
