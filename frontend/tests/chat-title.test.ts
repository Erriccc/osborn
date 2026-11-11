// Run: cd frontend && npx --yes tsx tests/chat-title.test.ts
// Spec (bug ab31e017, chat half + #60): the browser tab on a chat page reads
// "<session title> · Voice Native" once the session has a real, listed title,
// otherwise a STABLE "Chat · Voice Native". The title comes from
// deriveSessionTitle(session) (agent title first). The raw first user message is
// NOT used as the title (#60) — that leaked truncated message text into the tab
// as soon as a message was sent. Never pipeline text, never "Untitled session".
import { chatDocumentTitle } from '../src/lib/sessions'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) } catch (e: any) { fail++; console.log('FAIL', name, String(e?.message || e).slice(0, 400)) }
}
const eq = (a: any, b: any, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

t('agent title wins', () => {
  eq(chatDocumentTitle({ session: { title: 'Fix the Outputs badge', lastMessage: 'x' } }), 'Fix the Outputs badge · Voice Native', 'title')
})

t('no title: derived from the session preview', () => {
  eq(chatDocumentTitle({ session: { lastMessage: '[time: 2026-11-07 09:00 local] deploy the frontend today' } }), 'Deploy the frontend today · Voice Native', 'derived')
})

t('nothing at all: stable Chat title', () => {
  eq(chatDocumentTitle({}), 'Chat · Voice Native', 'empty')
  eq(chatDocumentTitle({ session: null }), 'Chat · Voice Native', 'null session')
})

t('untitled session falls back to Chat, never "Untitled session"', () => {
  eq(chatDocumentTitle({ session: { lastMessage: '[SYSTEM] notice' } }), 'Chat · Voice Native', 'notice-only')
})

t('#60: no session yet → stable Chat title (first message never becomes the tab title)', () => {
  // Before the session is listed with a real title, the tab stays "Chat · Voice
  // Native" — it must not turn into the truncated first user message.
  eq(chatDocumentTitle({ session: null }), 'Chat · Voice Native', 'no leak')
  eq(chatDocumentTitle({ session: undefined }), 'Chat · Voice Native', 'no leak (undefined)')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
