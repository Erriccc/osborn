// No Claude login + a fallback key must NOT block on interactive OAuth.
// Run: npx tsx agent/tests/auth-skip-blocking-oauth.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate from any real Claude login on this machine BEFORE importing the module:
// empty HOME (no ~/.claude/.credentials.json, no persisted .oauth-token) and an
// empty CLAUDE_CONFIG_DIR so `claude auth status` (if a CLI exists) reports logged out.
const fakeHome = mkdtempSync(join(tmpdir(), 'osb-authskip-'))
process.env.HOME = fakeHome
process.env.CLAUDE_CONFIG_DIR = join(fakeHome, '.claude')
delete process.env.CLAUDE_CODE_OAUTH_TOKEN

const KEY_VARS = ['ANTHROPIC_API_KEY', 'Z_AI_PERSONAL_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'OSBORN_FORCE_CLAUDE_LOGIN']
for (const k of KEY_VARS) delete process.env[k]

const {
  hasFallbackModelKey,
  shouldSkipBlockingOAuth,
  cleanEnvKey,
  ensureClaudeAuth,
  applyAuthFallback,
  clearAuthFallbackIfActive,
} = await import('../src/claude-auth.js')
const { CONTROL_MESSAGE_TYPES, checkControlSender } = await import('../src/data-sender-auth.js')

let pass = 0
const results: Promise<void>[] = []
const t = (name: string, fn: () => unknown) => {
  results.push((async () => {
    try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', String(e?.message).split('\n')[0]); process.exitCode = 1 }
  })())
}

// ── cleanEnvKey / hasFallbackModelKey ──
t('cleanEnvKey trims and strips quotes', () => {
  assert.equal(cleanEnvKey('  abc  '), 'abc')
  assert.equal(cleanEnvKey('"abc"'), 'abc')
  assert.equal(cleanEnvKey("'abc' "), 'abc')
  assert.equal(cleanEnvKey('" "'), '')
  assert.equal(cleanEnvKey(undefined), '')
})
t('hasFallbackModelKey: empty env → false', () => {
  assert.equal(hasFallbackModelKey({}), false)
})
t('hasFallbackModelKey: empty-string values → false', () => {
  assert.equal(hasFallbackModelKey({ ANTHROPIC_API_KEY: '', Z_AI_PERSONAL_API_KEY: '', ZAI_API_KEY: '', OPENROUTER_API_KEY: '' }), false)
})
t('hasFallbackModelKey: whitespace-only values → false', () => {
  assert.equal(hasFallbackModelKey({ Z_AI_PERSONAL_API_KEY: '   ', OPENROUTER_API_KEY: '\t\n' }), false)
})
t('hasFallbackModelKey: quoted-empty values → false', () => {
  assert.equal(hasFallbackModelKey({ ZAI_API_KEY: '""', OPENROUTER_API_KEY: "' '" }), false)
})
for (const k of ['ANTHROPIC_API_KEY', 'Z_AI_PERSONAL_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY']) {
  t(`hasFallbackModelKey: ${k} set → true`, () => {
    assert.equal(hasFallbackModelKey({ [k]: 'sk-real' }), true)
  })
}
t('hasFallbackModelKey: quoted key with trailing space → true', () => {
  assert.equal(hasFallbackModelKey({ Z_AI_PERSONAL_API_KEY: '"zai-key" ' }), true)
})
t('hasFallbackModelKey: unrelated key (ZAI_STANDARD_API_KEY) → false', () => {
  assert.equal(hasFallbackModelKey({ ZAI_STANDARD_API_KEY: 'x' }), false)
})

// ── shouldSkipBlockingOAuth ──
t('skip: not authed + fallback key → true', () => {
  assert.equal(shouldSkipBlockingOAuth({ OPENROUTER_API_KEY: 'k' }, false), true)
})
t('skip: not authed + no key → false (OAuth still required)', () => {
  assert.equal(shouldSkipBlockingOAuth({ OPENROUTER_API_KEY: '  ' }, false), false)
})
t('skip: already authed → false', () => {
  assert.equal(shouldSkipBlockingOAuth({ OPENROUTER_API_KEY: 'k' }, true), false)
})
t('skip: OSBORN_FORCE_CLAUDE_LOGIN=1 → false even with key', () => {
  assert.equal(shouldSkipBlockingOAuth({ Z_AI_PERSONAL_API_KEY: 'k', OSBORN_FORCE_CLAUDE_LOGIN: '1' }, false), false)
})
t('skip: OSBORN_FORCE_CLAUDE_LOGIN=0 does not force', () => {
  assert.equal(shouldSkipBlockingOAuth({ Z_AI_PERSONAL_API_KEY: 'k', OSBORN_FORCE_CLAUDE_LOGIN: '0' }, false), true)
})

await Promise.all(results.splice(0))

// ── ensureClaudeAuth integration (sequential — mutates process.env) ──
t('ensureClaudeAuth: fallback key + no creds → returns {} without OAuth, emits claude_auth_optional', async () => {
  process.env.Z_AI_PERSONAL_API_KEY = 'zai-key '
  const sent: string[] = []
  const r = await ensureClaudeAuth((type) => { sent.push(type) })
  assert.deepEqual(r, {})
  assert.equal(r.done, undefined)
  assert.equal(r.submitCode, undefined)
  assert.deepEqual(sent, ['claude_auth_optional'])
  assert.ok(!sent.includes('claude_auth_required'))
})
await Promise.all(results.splice(0))

t('applyAuthFallback: trims trailing space from the z.ai key', () => {
  process.env.Z_AI_PERSONAL_API_KEY = '"zai-key" '
  applyAuthFallback()
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, 'zai-key')
  assert.equal(process.env.OSBORN_DEMO_PASS, 'zai')
})
await Promise.all(results.splice(0))

t('clearAuthFallbackIfActive: undoes the z.ai redirect and model overrides', () => {
  // Precondition: the previous test activated the z.ai tier.
  assert.equal(process.env.OSBORN_DEMO_PASS, 'zai')
  clearAuthFallbackIfActive()
  for (const k of [
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'OSBORN_DEMO_PASS', 'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'ANTHROPIC_API_KEY',
  ]) assert.equal(process.env[k], undefined, `${k} still set`)
})
await Promise.all(results.splice(0))

t('applyAuthFallback: quoted ANTHROPIC_API_KEY is tier 2, cleaned, and does not redirect', () => {
  delete process.env.Z_AI_PERSONAL_API_KEY
  process.env.OPENROUTER_API_KEY = 'or-key'
  process.env.ANTHROPIC_API_KEY = ' "sk-ant-api-xyz" '
  applyAuthFallback()
  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-ant-api-xyz')
  assert.equal(process.env.ANTHROPIC_BASE_URL, undefined)
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, undefined)
})
t('applyAuthFallback: quoted-empty ANTHROPIC_API_KEY falls through to OpenRouter', () => {
  process.env.ANTHROPIC_API_KEY = '""'
  process.env.OPENROUTER_API_KEY = "'or-key' "
  applyAuthFallback()
  assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api')
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, 'or-key')
  assert.equal(process.env.ANTHROPIC_API_KEY, '')
  clearAuthFallbackIfActive()
})
await Promise.all(results.splice(0))

t('claude_auth_start is an owner-only control message', () => {
  assert.ok(CONTROL_MESSAGE_TYPES.has('claude_auth_start'))
  assert.equal(checkControlSender('claude_auth_start', 'user-other', 'user-owner').ok, false)
  assert.equal(checkControlSender('claude_auth_start', 'user-owner', 'user-owner').ok, true)
})
t('index.ts wires a claude_auth_start handler that forces OAuth past the skip', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf-8')
  const i = src.indexOf("data.type === 'claude_auth_start'")
  assert.ok(i > 0, 'handler missing')
  const body = src.slice(i, i + 4000)
  assert.ok(body.includes('{ force: true }'), 'must call ensureClaudeAuth with force')
  assert.ok(body.includes('pendingAuthSubmitCode = authResult.submitCode'), 'must set pendingAuthSubmitCode')
  assert.ok(body.includes('clearAuthFallbackIfActive()'), 'must clear the fallback redirect')
  assert.ok(/abortQuery|closeSession/.test(body), 'must close the persistent query')
})
await Promise.all(results.splice(0))

console.log(`\n${pass} passed${process.exitCode ? ' — FAILURES above' : ''}`)
// node-pty / SDK imports can keep handles open; exit explicitly.
process.exit(process.exitCode ?? 0)
