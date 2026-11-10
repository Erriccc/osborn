// Run: npx tsx agent/tests/session-switch-llm.test.ts
// Spec (#74, #71) written BLIND from the issues, public ClaudeLLM surface only:
//  - after a switch to session B, the LLM layer's session id is B (not the old one)
//  - the target is armed for resume (isResumingSession) and survives a reset
//  - #71: a fallback key means no blocking Claude sign-in (shouldSkipBlockingOAuth)
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fakeHome = mkdtempSync(join(tmpdir(), 'osb-switch-'))
process.env.HOME = fakeHome
process.env.CLAUDE_CONFIG_DIR = join(fakeHome, '.claude')
delete process.env.CLAUDE_CODE_OAUTH_TOKEN

const { createClaudeLLM } = await import('../src/claude-llm.js')
const { shouldSkipBlockingOAuth } = await import('../src/claude-auth.js')

let pass = 0, fail = 0
async function t(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log('PASS', name) }
  catch (e: any) { fail++; console.log('FAIL', name, '-', String(e.message).split('\n')[0].slice(0, 300)) }
}
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

await t('#74 setResumeSessionId(B) arms resume', () => {
  const llm: any = createClaudeLLM({ workingDirectory: fakeHome })
  llm.setResumeSessionId(B)
  assert.equal(llm.isResumingSession, true)
})

await t('#74 switch A->B: reset then resume B leaves LLM targeting B, not A', () => {
  const llm: any = createClaudeLLM({ workingDirectory: fakeHome, resumeSessionId: A })
  assert.equal(llm.isResumingSession, true)
  llm.resetForSessionSwitch()
  assert.equal(llm.isResumingSession, false, 'reset must forget A')
  assert.notEqual(llm.sessionId, A, 'LLM session id must not remain A after reset')
  llm.setResumeSessionId(B)
  assert.equal(llm.isResumingSession, true)
  assert.notEqual(llm.sessionId, A)
})

await t('#74 session id visible to the LLM layer becomes B after switch', () => {
  const llm: any = createClaudeLLM({ workingDirectory: fakeHome, resumeSessionId: A })
  llm.resetForSessionSwitch()
  llm.setResumeSessionId(B)
  // Public id accessor: either already B, or null (pending resume of B) -- never A.
  assert.ok(llm.sessionId === B || llm.sessionId === null, `got ${llm.sessionId}`)
})

await t('#74 reset emits session_reset (listeners learn the old session closed)', () => {
  const llm: any = createClaudeLLM({ workingDirectory: fakeHome })
  let n = 0
  llm.events.on('session_reset', () => n++)
  llm.resetForSessionSwitch()
  assert.equal(n, 1)
})

await t('#74 reset with no running turn does not throw; second switch B->A works', () => {
  const llm: any = createClaudeLLM({ workingDirectory: fakeHome })
  llm.setResumeSessionId(A); llm.resetForSessionSwitch(); llm.setResumeSessionId(B)
  llm.resetForSessionSwitch(); llm.setResumeSessionId(A)
  assert.equal(llm.isResumingSession, true)
})

await t('#71 fallback key + not authed => skip blocking Claude OAuth', () => {
  assert.equal(shouldSkipBlockingOAuth({ OPENROUTER_API_KEY: 'sk-or-x' } as any, false), true)
  assert.equal(shouldSkipBlockingOAuth({ ANTHROPIC_API_KEY: 'sk-ant-x' } as any, false), true)
})
await t('#71 no fallback => still blocks (unchanged)', () => {
  assert.equal(shouldSkipBlockingOAuth({} as any, false), false)
})
await t('#71 OSBORN_FORCE_CLAUDE_LOGIN=1 keeps blocking (compat)', () => {
  assert.equal(shouldSkipBlockingOAuth({ OPENROUTER_API_KEY: 'k', OSBORN_FORCE_CLAUDE_LOGIN: '1' } as any, false), false)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
