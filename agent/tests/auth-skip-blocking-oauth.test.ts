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
  startClaudeAuthOnDemand,
  isOnDemandAuthInFlight,
  redactClaudeTokens,
} = await import('../src/claude-auth.js')
const { createClaudeLLM, requestAuthRestart, getAuthEnvGeneration, shouldRestartForAuth } = await import('../src/claude-llm.js')
// claude-llm sets a module-load default for ANTHROPIC_SMALL_FAST_MODEL (haiku);
// clearing the fallback must RESTORE it, not delete it.
const LOAD_SMALL_FAST = process.env.ANTHROPIC_SMALL_FAST_MODEL
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
  assert.equal(clearAuthFallbackIfActive(), true)
  assert.equal(clearAuthFallbackIfActive(), false, 'second clear is a no-op')
  for (const k of [
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'OSBORN_DEMO_PASS', 'ANTHROPIC_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'ANTHROPIC_API_KEY',
  ]) assert.equal(process.env[k], undefined, `${k} still set`)
  assert.equal(process.env.ANTHROPIC_SMALL_FAST_MODEL, LOAD_SMALL_FAST, 'small-fast restored to its pre-fallback value')
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
t('index.ts claude_auth_start uses the guarded helper and only a deferred restart', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf-8')
  const i = src.indexOf("data.type === 'claude_auth_start'")
  assert.ok(i > 0, 'handler missing')
  const body = src.slice(i, src.indexOf("} else if (data.type ===", i + 10))
  assert.ok(body.includes('startClaudeAuthOnDemand('), 'must use the guarded on-demand helper')
  // Gated on a cleared fallback, and the #148 follow-up: publish the new tier +
  // drop the dead tier's key verdict BEFORE the deferred restart, or /health keeps
  // serving the dead tier after a mid-session sign-in.
  assert.ok(/if \(!fallbackCleared\) return[\s\S]*agentActiveProvider = 'claude'[\s\S]*startKeyHealthProbe\(\)[\s\S]*requestAuthRestart\(\)/.test(body),
    'gated provider + key-verdict reset, then the deferred restart')
  assert.ok(!/abortQuery|abortAgent|closeSession|killCurrentLLM/.test(body), 'must not abort the running turn')
})
await Promise.all(results.splice(0))

// ── Deferred restart (claude-llm) ──
t('shouldRestartForAuth: stale + idle → restart', () => {
  assert.equal(shouldRestartForAuth(0, 1, 0, false), true)
})
t('shouldRestartForAuth: stale but a turn is streaming → defer', () => {
  assert.equal(shouldRestartForAuth(0, 1, 1, false), false)
})
t('shouldRestartForAuth: stale but an interrupt is settling → defer', () => {
  assert.equal(shouldRestartForAuth(0, 1, 0, true), false)
})
t('shouldRestartForAuth: same generation → never restart', () => {
  assert.equal(shouldRestartForAuth(2, 2, 0, false), false)
})
t('requestAuthRestart does not close a live session immediately', () => {
  const llm: any = createClaudeLLM({ workingDirectory: fakeHome })
  let closes = 0, aborts = 0
  llm.closeSession = () => { closes++ }
  llm.abortQuery = () => { aborts++ }
  const before = getAuthEnvGeneration()
  requestAuthRestart()
  assert.equal(getAuthEnvGeneration(), before + 1)
  assert.equal(closes, 0)
  assert.equal(aborts, 0)
  // No subprocess yet → nothing pending; the next cold start spawns on the new env.
  assert.equal(llm.authRestartPending, false)
})
t('pushMessage restarts only at the turn boundary, before the fast-path push', () => {
  const src = readFileSync(new URL('../src/claude-llm.ts', import.meta.url), 'utf-8')
  const i = src.indexOf('  pushMessage(')
  const body = src.slice(i, src.indexOf('  #startBackgroundConsumer(', i) > 0 ? src.indexOf('  #startBackgroundConsumer(', i) : i + 6000)
  const decide = body.indexOf('shouldRestartForAuth(this.#spawnAuthGen, authEnvGeneration, this.#turnsInFlight')
  const fast = body.indexOf('// Fast path')
  assert.ok(decide > 0 && fast > decide, 'restart decision must precede the fast-path push')
})
await Promise.all(results.splice(0))

// ── On-demand sign-in helper ──
const mkSlot = () => {
  let v: ((c: string) => void) | null = null
  return { get: () => v, set: (fn: any) => { v = fn } }
}
t('on-demand: already authenticated + no fallback active → no restart', async () => {
  const sent: string[] = []
  const { started, result } = startClaudeAuthOnDemand((t) => { sent.push(t) }, mkSlot(), { ensure: async () => ({}) })
  assert.equal(started, true)
  assert.deepEqual(await result, { fallbackCleared: false })
  assert.deepEqual(sent, ['claude_auth_complete'])
})
await Promise.all(results.splice(0))
t('on-demand: OAuth completes while z.ai fallback active → fallbackCleared', async () => {
  process.env.Z_AI_PERSONAL_API_KEY = 'zai-key'
  applyAuthFallback()
  assert.equal(process.env.OSBORN_DEMO_PASS, 'zai')
  let resolveDone!: () => void
  const done = new Promise<void>((r) => { resolveDone = r })
  const submit = (_c: string) => {}
  const slot = mkSlot()
  const { result } = startClaudeAuthOnDemand(() => {}, slot, { ensure: async () => ({ submitCode: submit, done }) })
  await new Promise((r) => setImmediate(r))
  assert.equal(slot.get(), submit, 'pendingAuthSubmitCode set while the flow runs')
  resolveDone()
  assert.deepEqual(await result, { fallbackCleared: true })
  assert.equal(slot.get(), null, 'slot cleared after settle')
  assert.equal(process.env.OSBORN_DEMO_PASS, undefined)
  delete process.env.Z_AI_PERSONAL_API_KEY
})
await Promise.all(results.splice(0))
t('on-demand: settle does not null a slot that now holds another flow', async () => {
  let resolveDone!: () => void
  const done = new Promise<void>((r) => { resolveDone = r })
  const slot = mkSlot()
  const { result } = startClaudeAuthOnDemand(() => {}, slot, { ensure: async () => ({ submitCode: () => {}, done }) })
  await new Promise((r) => setImmediate(r))
  const other = (_c: string) => {}
  slot.set(other)
  resolveDone()
  await result
  assert.equal(slot.get(), other)
})
await Promise.all(results.splice(0))
t('on-demand: double start triggers a single flow', async () => {
  let calls = 0
  let resolveDone!: () => void
  const done = new Promise<void>((r) => { resolveDone = r })
  const ensure = async () => { calls++; return { submitCode: () => {}, done } }
  const a = startClaudeAuthOnDemand(() => {}, mkSlot(), { ensure })
  const b = startClaudeAuthOnDemand(() => {}, mkSlot(), { ensure })
  assert.equal(a.started, true)
  assert.equal(b.started, false)
  assert.equal(b.result, a.result)
  assert.equal(isOnDemandAuthInFlight(), true)
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 1)
  resolveDone()
  await a.result
  assert.equal(isOnDemandAuthInFlight(), false)
  // Guard released — a later start runs a new flow.
  const c = startClaudeAuthOnDemand(() => {}, mkSlot(), { ensure: async () => ({}) })
  assert.equal(c.started, true)
  await c.result
})
await Promise.all(results.splice(0))
t('on-demand: failed OAuth → error sent, no restart, guard released', async () => {
  const sent: string[] = []
  const { result } = startClaudeAuthOnDemand((t) => { sent.push(t) }, mkSlot(), {
    ensure: async () => ({ submitCode: () => {}, done: Promise.reject(new Error('timeout')) }),
  })
  assert.deepEqual(await result, { fallbackCleared: false })
  assert.ok(sent.includes('claude_auth_error'))
  assert.equal(isOnDemandAuthInFlight(), false)
})
await Promise.all(results.splice(0))

// ── Snapshot / restore of model env ──
t('clear restores pre-fallback model env instead of deleting it', () => {
  process.env.ANTHROPIC_MODEL = 'claude-custom'
  process.env.ANTHROPIC_SMALL_FAST_MODEL = 'claude-small'
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  process.env.Z_AI_PERSONAL_API_KEY = 'zai-key'
  applyAuthFallback()
  assert.equal(process.env.ANTHROPIC_MODEL, 'glm-5.3')
  assert.equal(process.env.ANTHROPIC_SMALL_FAST_MODEL, 'glm-5.3-flash')
  assert.equal(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000')
  // A second activation must not snapshot the fallback's own values.
  applyAuthFallback()
  assert.equal(clearAuthFallbackIfActive(), true)
  assert.equal(process.env.ANTHROPIC_MODEL, 'claude-custom')
  assert.equal(process.env.ANTHROPIC_SMALL_FAST_MODEL, 'claude-small')
  assert.equal(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined)
  delete process.env.ANTHROPIC_MODEL
  delete process.env.ANTHROPIC_SMALL_FAST_MODEL
  delete process.env.Z_AI_PERSONAL_API_KEY
})
t('redactClaudeTokens scrubs sk-ant tokens from CLI output', () => {
  const out = redactClaudeTokens('Your token: sk-ant-oat01-AbC_9-xyz done; key sk-ant-api03-QQ')
  assert.ok(!/sk-ant-oat01|AbC_9|QQ/.test(out))
  assert.equal(out, 'Your token: sk-ant-[REDACTED] done; key sk-ant-[REDACTED]')
  assert.equal(redactClaudeTokens('no secrets here'), 'no secrets here')
})
t('OAuth token is no longer logged (even a prefix)', () => {
  const src = readFileSync(new URL('../src/claude-auth.ts', import.meta.url), 'utf-8')
  assert.ok(!/token\.substring\(0,\s*20\)/.test(src))
})
await Promise.all(results.splice(0))

console.log(`\n${pass} passed${process.exitCode ? ' — FAILURES above' : ''}`)
// node-pty / SDK imports can keep handles open; exit explicitly.
process.exit(process.exitCode ?? 0)
