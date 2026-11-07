// Run: cd frontend && npx --yes tsx tests/control-text.test.ts
// Spec (bug 14bedf48, frontend half): pipeline control notices are never a
// "You" bubble, in live chat or in resumed history: '[SYSTEM — SILENT CONTROL
// MESSAGE ...', '[Request interrupted by user ...]', and the other client /
// harness notices ([favorited], [liked], [ignored: ...], [welcome-back],
// [EMERGENCY STOP], <task-notification>, ...), with or without the [time:]
// tag. Real speech that merely mentions such words is kept. Only user rows are
// filtered; assistant/system rows are untouched.
import { isControlNotice, dropControlUserItems } from '../src/lib/control-text'
import { userBubbleText } from '../src/lib/chat-echo'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) } catch (e: any) { fail++; console.log('FAIL', name, String(e?.message || e).slice(0, 400)) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const TAG = '[time: 2026-11-07 09:12 local] '
const CONTROL = [
  '[SYSTEM — SILENT CONTROL MESSAGE] The user switched sessions. Do not reply.',
  '[SYSTEM — SILENT CONTROL MESSAGE — do not respond] context follows',
  '[SYSTEM] You are now in a meeting.',
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
  '[favorited] The user favorited the file plan.md.',
  '[liked] "that answer"',
  '[ignored: disregard my previous message "hello"]',
  '[welcome-back] The user just returned after 2 hours away.',
  '[EMERGENCY STOP] stop now',
  '[BACKGROUND_INIT] start',
  '<task-notification><task-id>a1</task-id></task-notification>',
  '<system-reminder>be brief</system-reminder>',
]

t('every control notice is detected (bare)', () => {
  for (const c of CONTROL) ok(isControlNotice(c), c)
})

t('with the [time:] tag and leading whitespace', () => {
  for (const c of CONTROL) ok(isControlNotice(`  ${TAG}${c}`), `tagged: ${c}`)
})

t('real user words are not control notices', () => {
  for (const s of [
    'hello there',
    'Can you check the [SYSTEM] log for errors?',
    'I was interrupted by user testing earlier',
    'Request interrupted by user is the error I see',
    '[MEETING — bot123]: Alice: hi',
    'see this\n\n[Image: a.png](https://x/a.png)',
  ]) ok(!isControlNotice(s), s)
})

t('empty / non-string is a notice (nothing to show)', () => {
  ok(isControlNotice(''), 'empty')
  ok(isControlNotice('   '), 'blank')
  ok(isControlNotice(null), 'null')
})

t('user bubble text hides every control notice (live render path)', () => {
  for (const c of CONTROL) eq(userBubbleText(TAG + c), null, c)
})

t('history: user control rows dropped, everything else kept in order', () => {
  const items = [
    { role: 'user', content: 'first question' },
    { role: 'user', content: TAG + '[SYSTEM — SILENT CONTROL MESSAGE] switch' },
    { role: 'assistant', content: 'answer one' },
    { role: 'user', content: '[Request interrupted by user]' },
    { role: 'assistant', content: '[SYSTEM] assistant text is never filtered here' },
    { role: 'system', content: '── Nov 7 ──' },
    { role: 'user', content: 'second question' },
  ]
  const out = dropControlUserItems(items)
  eq(out.map((m) => m.content), ['first question', 'answer one', '[SYSTEM] assistant text is never filtered here', '── Nov 7 ──', 'second question'], 'kept')
})

t('history filter returns the same array when nothing is dropped', () => {
  const items = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]
  ok(dropControlUserItems(items) === items, 'identity')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
