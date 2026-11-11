// Run: cd frontend && npx tsx tests/chat-session-url.test.ts
// #71: reloading or re-entering /chat must land back in the SAME session. The
// session id (and the project cwd the agent needs to find its JSONL) has to be
// in the URL as soon as it is known — a brand-new session included — and after
// a switch the URL must follow the session that is now live.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chatUrlForSession, sessionParamsFromSearch } from '../src/lib/chat-url'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) }
  catch (e: any) { fail++; console.log('FAIL', name, '-', String(e.message).split('\n')[0].slice(0, 300)) }
}
const S1 = '11111111-aaaa-4aaa-8aaa-111111111111'
const S2 = '22222222-bbbb-4bbb-8bbb-222222222222'

t('new session: /chat gains ?session=<id>', () => {
  const next = chatUrlForSession('https://www.voice-native.com/chat', S1)
  assert.equal(next, `/chat?session=${S1}`)
})

t('already on that session -> null (no history churn)', () => {
  assert.equal(chatUrlForSession(`https://x.test/chat?session=${S1}`, S1), null)
  assert.equal(chatUrlForSession(`https://x.test/chat?session=${S1}&workingDirectory=%2Fw%2Fp`, S1, '/w/p'), null)
})

t('switch: session param replaced, other params kept, cwd updated', () => {
  const next = chatUrlForSession(`https://x.test/chat?session=${S1}&workingDirectory=%2Fw%2Fa&provider=gemini`, S2, '/w/b')!
  const u = new URL(next, 'https://x.test')
  assert.equal(u.pathname, '/chat')
  assert.equal(u.searchParams.get('session'), S2)
  assert.equal(u.searchParams.get('workingDirectory'), '/w/b')
  assert.equal(u.searchParams.get('provider'), 'gemini')
})

t('switch to a DIFFERENT session with unknown cwd DROPS the stale workingDirectory (#112)', () => {
  // The previous session's project dir must not ride onto the new session: a
  // reload would then boot the agent in the wrong dir (/workspace root or the
  // old project) and resume the wrong conversation. No hint is safer than a
  // wrong one — the agent resolves the session's real cwd from its id.
  const next = chatUrlForSession(`https://x.test/chat?session=${S1}&workingDirectory=%2Fw%2Fa`, S2)!
  assert.equal(new URL(next, 'https://x.test').searchParams.get('workingDirectory'), null)
  assert.equal(new URL(next, 'https://x.test').searchParams.get('session'), S2)
})

t('SAME session with unknown cwd keeps its workingDirectory (reload hint survives)', () => {
  // A reload of the live session with cwd momentarily unknown must not lose the
  // URL's own correct cwd — only a session CHANGE drops it.
  assert.equal(chatUrlForSession(`https://x.test/chat?session=${S1}&workingDirectory=%2Fw%2Fa`, S1), null)
})

t('switch with a KNOWN cwd replaces the stale one (not dropped)', () => {
  const next = chatUrlForSession(`https://x.test/chat?session=${S1}&workingDirectory=%2Fw%2Fa`, S2, '/w/b')!
  assert.equal(new URL(next, 'https://x.test').searchParams.get('workingDirectory'), '/w/b')
})

t('one-shot seed params are dropped so a reload never re-seeds', () => {
  const next = chatUrlForSession('https://x.test/chat?prompt=hello&seed=1', S1)!
  const u = new URL(next, 'https://x.test')
  assert.equal(u.searchParams.get('prompt'), null)
  assert.equal(u.searchParams.get('seed'), null)
  assert.equal(u.searchParams.get('session'), S1)
})

t('hash is preserved', () => {
  assert.equal(chatUrlForSession('https://x.test/chat#files', S1), `/chat?session=${S1}#files`)
})

t('empty / invalid ids never rewrite the URL', () => {
  assert.equal(chatUrlForSession('https://x.test/chat', ''), null)
  assert.equal(chatUrlForSession('https://x.test/chat', '(pending)'), null)
  assert.equal(chatUrlForSession('https://x.test/chat', 'has space'), null)
})

t('sessionParamsFromSearch reads the live URL', () => {
  assert.deepEqual(sessionParamsFromSearch(`?session=${S2}&workingDirectory=%2Fw%2Fb`), { sessionId: S2, workingDirectory: '/w/b' })
  assert.deepEqual(sessionParamsFromSearch(''), { sessionId: null, workingDirectory: '' })
})

const vr = fs.readFileSync(path.join(__dirname, '../src/components/VoiceRoom.tsx'), 'utf8')
const prov = fs.readFileSync(path.join(__dirname, '../src/components/ChatSessionProvider.tsx'), 'utf8')
t('VoiceRoom writes the live session into the URL with replaceState', () => {
  assert.ok(/chatUrlForSession\(/.test(vr), 'VoiceRoom must call chatUrlForSession')
  assert.ok(/history\.replaceState\(/.test(vr), 'must use history.replaceState (no navigation/remount)')
})
t('provider: preSelectedSessionId is fixed for the page life; reconnects read the live URL', () => {
  assert.ok(/useState(<[^>]*>)?\(\s*\(\)\s*=>\s*params\.get\('session'\)/.test(prov), 'preSelectedSessionId must be captured once (useState initializer)')
  assert.ok(/sessionParamsFromSearch\(/.test(prov), 'connect() must read the current URL session')
})
t('provider: connect never forwards an EMPTY cwd when one is known (#112)', () => {
  // live.workingDirectory || workingDirectory — an empty live cwd must fall back
  // to the launch cwd so the agent never boots /workspace root for a known dir.
  assert.ok(/live\.sessionId \? live\.workingDirectory : workingDirectory\)\s*\|\|\s*workingDirectory/.test(prov),
    'connectWorkingDirectory must fall back to the launch workingDirectory when the live cwd is empty')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
