// Run: cd frontend && npx --yes tsx tests/typed-echo.test.ts
// Spec (bug d9bb78b2): a typed message showed twice (optimistic bubble + the
// agent's user_transcript echo). handleSendText now sends a clientMsgId in
// user_text; the echo carries it back (agent PR #18) and is dropped by id.
// Older agents echo without an id: fall back to a cleaned-text match against
// this tab's still-pending typed messages (each pending entry absorbs ONE echo,
// within a time window). An echo nobody here sent (voice, another tab) is shown.
// User bubbles render through cleanSessionText (transcript-clean.ts).
import {
  newClientMsgId, echoMatchKey, rememberTyped, takeTypedEcho, userBubbleText, TYPED_ECHO_WINDOW_MS,
  type PendingTyped,
} from '../src/lib/chat-echo'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) } catch (e: any) { fail++; console.log('FAIL', name, String(e?.message || e).slice(0, 400)) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const T0 = 5_000_000

t('client message ids are unique and non-empty', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newClientMsgId()))
  eq(ids.size, 200, 'unique')
  ids.forEach((id) => ok(typeof id === 'string' && id.length >= 8, 'shape'))
})

t('match key ignores the [time:] tag, case and whitespace', () => {
  eq(echoMatchKey('[time: 2026-11-07 09:00 local] Hello   World '), 'hello world', 'key')
  eq(echoMatchKey('hello world'), 'hello world', 'plain')
})

t('match key of a notice-only text is null', () => {
  eq(echoMatchKey('[favorited] The user favorited the file a.md.'), null, 'favorited')
})

t('echo with our clientMsgId is dropped (and consumed)', () => {
  let p: PendingTyped[] = rememberTyped([], { clientMsgId: 'id-1', text: 'ship it', now: T0 })
  const r = takeTypedEcho(p, { text: 'ship it', clientMsgId: 'id-1' }, T0 + 500)
  ok(r.duplicate, 'duplicate')
  eq(r.pending.length, 0, 'consumed')
})

t('same text typed twice on purpose: two bubbles, two echoes dropped by id', () => {
  let p: PendingTyped[] = []
  p = rememberTyped(p, { clientMsgId: 'a', text: 'yes', now: T0 })
  p = rememberTyped(p, { clientMsgId: 'b', text: 'yes', now: T0 + 1000 })
  const r1 = takeTypedEcho(p, { text: 'yes', clientMsgId: 'a' }, T0 + 1200)
  ok(r1.duplicate, 'first echo')
  const r2 = takeTypedEcho(r1.pending, { text: 'yes', clientMsgId: 'b' }, T0 + 1300)
  ok(r2.duplicate, 'second echo')
  eq(r2.pending.length, 0, 'both consumed')
})

t('echo with an unknown id (another tab / device) is shown', () => {
  const p = rememberTyped([], { clientMsgId: 'mine', text: 'hello', now: T0 })
  const r = takeTypedEcho(p, { text: 'hello', clientMsgId: 'theirs' }, T0 + 100)
  ok(!r.duplicate, 'not ours')
  eq(r.pending.length, 1, 'ours still pending')
})

t('fallback: id-less echo matches by cleaned text (old agent with the time tag)', () => {
  const p = rememberTyped([], { clientMsgId: 'x', text: 'Deploy the  build', now: T0 })
  const r = takeTypedEcho(p, { text: '[time: 2026-11-07 09:00 local] deploy the build' }, T0 + 2000)
  ok(r.duplicate, 'matched by text')
  eq(r.pending.length, 0, 'consumed')
})

t('fallback: an echo carrying attachment markers still matches its typed text', () => {
  const p = rememberTyped([], { clientMsgId: 'x', text: 'look at this', now: T0 })
  const r = takeTypedEcho(p, { text: 'look at this\n\n[Image: shot.png](https://s/x.png)' }, T0 + 2000)
  ok(r.duplicate, 'matched with attachments')
})

t('fallback: one pending absorbs one echo only', () => {
  const p = rememberTyped([], { clientMsgId: 'x', text: 'ok', now: T0 })
  const r1 = takeTypedEcho(p, { text: 'ok' }, T0 + 100)
  ok(r1.duplicate, 'first')
  const r2 = takeTypedEcho(r1.pending, { text: 'ok' }, T0 + 200)
  ok(!r2.duplicate, 'a later spoken "ok" is shown')
})

t('fallback: different text is shown (voice turn while a typed one is pending)', () => {
  const p = rememberTyped([], { clientMsgId: 'x', text: 'typed words', now: T0 })
  const r = takeTypedEcho(p, { text: 'spoken words' }, T0 + 100)
  ok(!r.duplicate, 'shown')
  eq(r.pending.length, 1, 'typed still pending')
})

t('fallback window: a stale pending entry no longer absorbs echoes', () => {
  const p = rememberTyped([], { clientMsgId: 'x', text: 'hi', now: T0 })
  const r = takeTypedEcho(p, { text: 'hi' }, T0 + TYPED_ECHO_WINDOW_MS + 1)
  ok(!r.duplicate, 'expired')
  eq(r.pending.length, 0, 'expired entries are pruned')
})

t('pending list is bounded', () => {
  let p: PendingTyped[] = []
  for (let i = 0; i < 100; i++) p = rememberTyped(p, { clientMsgId: `id${i}`, text: `m${i}`, now: T0 + i })
  ok(p.length <= 20, `bounded: ${p.length}`)
  ok(p.some((x) => x.clientMsgId === 'id99'), 'newest kept')
})

t('user bubble text uses the shared cleaner (time tag, interrupted template)', () => {
  eq(userBubbleText('[time: 2026-11-07 09:00 local] hello'), 'hello', 'time tag stripped')
  const wrapped = '[INTERRUPTED] The user interrupted your response mid-speech.\n\nUser\'s message: "stop there"\n\nCONTEXT PRESERVATION (READ THIS):\nx'
  eq(userBubbleText(wrapped), 'stop there', 'template unwrapped')
  eq(userBubbleText('plain words'), 'plain words', 'plain')
})

t('user bubble text keeps attachment markers (MessageContent renders them)', () => {
  const s = 'see this\n\n[Image: a.png](https://x/a.png)'
  eq(userBubbleText(s), s, 'kept')
})

t('nothing left -> null (hidden), never the "Voice session" fallback', () => {
  eq(userBubbleText('[time: 2026-11-07 09:00 local] '), null, 'empty after tag')
  eq(userBubbleText('<session_tail>old</session_tail>'), null, 'tail only')
})

t('text fallback only while the agent has never returned a clientMsgId', () => {
  const pend = rememberTyped([], { clientMsgId: 'a', text: 'yes', now: 0 })
  // Older agent (never returns ids): an id-less echo is matched by text.
  eq(takeTypedEcho(pend, { text: 'yes' }, 10).duplicate, true, 'legacy agent text match')
  // Agent that returns ids: an id-less user_transcript is a spoken turn.
  const r = takeTypedEcho(pend, { text: 'yes' }, 10, { agentSendsIds: true })
  eq(r.duplicate, false, 'spoken "yes" is kept')
  eq(r.pending.length, 1, 'typed entry still awaits its id echo')
  eq(takeTypedEcho(r.pending, { text: 'yes', clientMsgId: 'a' }, 20, { agentSendsIds: true }).duplicate, true, 'id echo still deduped')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
