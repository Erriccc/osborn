// Run: npx tsx agent/tests/auth-reentry.test.ts
// #71: re-entering /chat while a Claude OAuth flow is still in flight (e.g. the
// user opened the optional sign-in, then reloaded) must NOT block the session
// when the machine already has a working model (fallback key). Only a machine
// with no model at all, or an explicit sign-in request, waits on the flow.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fakeHome = mkdtempSync(join(tmpdir(), 'osb-reentry-'))
process.env.HOME = fakeHome
process.env.CLAUDE_CONFIG_DIR = join(fakeHome, '.claude')
delete process.env.CLAUDE_CODE_OAUTH_TOKEN

const { inFlightAuthBlocksJoin } = await import('../src/claude-auth.js')

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) }
  catch (e: any) { fail++; console.log('FAIL', name, '-', String(e.message).split('\n')[0].slice(0, 300)) }
}

t('fallback key present: re-entry does not wait on an in-flight OAuth', () => {
  assert.equal(inFlightAuthBlocksJoin({ ANTHROPIC_API_KEY: 'sk-ant-x' } as any), false)
  assert.equal(inFlightAuthBlocksJoin({ OPENROUTER_API_KEY: 'sk-or-x' } as any), false)
})
t('no model at all: re-entry still waits (unchanged)', () => {
  assert.equal(inFlightAuthBlocksJoin({} as any), true)
})
t('explicit sign-in (force) always attaches to the flow', () => {
  assert.equal(inFlightAuthBlocksJoin({ ANTHROPIC_API_KEY: 'sk-ant-x' } as any, true), true)
})
t('OSBORN_FORCE_CLAUDE_LOGIN keeps the blocking behaviour', () => {
  assert.equal(inFlightAuthBlocksJoin({ ANTHROPIC_API_KEY: 'k', OSBORN_FORCE_CLAUDE_LOGIN: '1' } as any), true)
})
t('ensureClaudeAuth consults it in the in-flight attach branch', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/claude-auth.ts'), 'utf8')
  const i = src.indexOf('export async function ensureClaudeAuth')
  const branch = src.slice(i, src.indexOf('// Check 0', i))
  assert.ok(/if \(inFlightAuth\)/.test(branch), 'in-flight branch moved')
  assert.ok(/inFlightAuthBlocksJoin\(process\.env, !!opts\.force\)/.test(branch), 'attach branch must use inFlightAuthBlocksJoin')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
