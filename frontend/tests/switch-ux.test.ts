// Run: cd frontend && npx tsx tests/switch-ux.test.ts
// #74 phase 2 frontend (session-switch-scope.md S8–S12):
//   S8  /session-messages query carries the session's cwd
//   S9  switch UX: cwd sent, pending/cancel handlers, history replaced via fetch
//   S10 Rooms "Switching…" row state
//   S11 URL pin prefers the agent-reported workingDirectory
//   S12 duplicate assistant bubble (isFinal) dropped
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { sessionMessagesQuery } from '../src/lib/chat-url'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) }
  catch (e: any) { fail++; console.log('FAIL', name, '-', String(e?.message).split('\n')[0].slice(0, 300)) }
}
const vr = fs.readFileSync(path.join(__dirname, '../src/components/VoiceRoom.tsx'), 'utf8')
const S = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

// ── S8 ──
t('S8 sessionMessagesQuery: session + limit, cwd only when known', () => {
  assert.equal(sessionMessagesQuery(S), `?session=${S}&limit=50`)
  assert.equal(sessionMessagesQuery(S, '/w/proj b', 20), `?session=${S}&limit=20&workingDirectory=%2Fw%2Fproj+b`)
  assert.equal(sessionMessagesQuery(S, ''), `?session=${S}&limit=50`)
})
t('S8 mount hydration passes the launch cwd', () => {
  const i = vr.indexOf("agentReadUrl(base, 'session-messages')")
  assert.ok(i > 0)
  assert.ok(/sessionMessagesQuery\(preSelectedSessionId, launchCwd/.test(vr.slice(i - 50, i + 200)))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
