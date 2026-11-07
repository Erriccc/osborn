// Run: cd frontend && npx --yes tsx tests/chat-title.test.ts
// Spec (bug ab31e017, chat half): the browser tab on a chat page reads
// "<session title> · Voice Native", or "New chat · Voice Native" when there is
// no title yet. The title comes from deriveSessionTitle(session) (agent title
// first); before the session is listed, the first real user message stands in.
// Never pipeline text, never "Untitled session".
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

t('nothing at all: New chat', () => {
  eq(chatDocumentTitle({}), 'New chat · Voice Native', 'empty')
  eq(chatDocumentTitle({ session: null, firstUserMessage: null }), 'New chat · Voice Native', 'nulls')
})

t('untitled session falls back to New chat, never "Untitled session"', () => {
  eq(chatDocumentTitle({ session: { lastMessage: '[SYSTEM] notice' } }), 'New chat · Voice Native', 'notice-only')
})

t('session not listed yet: first real user message stands in', () => {
  eq(chatDocumentTitle({ session: null, firstUserMessage: 'Can you summarize the meeting notes' }), 'Summarize the meeting notes · Voice Native', 'first message')
})

t('first user message that is a control notice is ignored', () => {
  eq(chatDocumentTitle({ firstUserMessage: '[Request interrupted by user]' }), 'New chat · Voice Native', 'control')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
