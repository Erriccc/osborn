// Adversarial spec tests for claude_auth_start. Run: npx tsx tests/auth-start-adversarial.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const fakeHome = mkdtempSync(join(tmpdir(), 'osb-adv-'))
process.env.HOME = fakeHome
process.env.CLAUDE_CONFIG_DIR = join(fakeHome, '.claude')
delete process.env.CLAUDE_CODE_OAUTH_TOKEN
for (const k of ['ANTHROPIC_API_KEY','Z_AI_PERSONAL_API_KEY','ZAI_API_KEY','OPENROUTER_API_KEY','OSBORN_FORCE_CLAUDE_LOGIN','ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN']) delete process.env[k]

const A = await import('../src/claude-auth.js')
const L = await import('../src/claude-llm.js')
let pass = 0, fail = 0
async function t(name: string, fn: () => Promise<void> | void) {
  try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { fail++; console.log('FAIL ', name, '-', e.message) }
}
const tick = () => new Promise(r => setTimeout(r, 5))

// (a)/(b) pure restart decision
await t('shouldRestartForAuth: streaming turn never restarts', () => {
  assert.equal(L.shouldRestartForAuth(0, 1, 1, false), false)
  assert.equal(L.shouldRestartForAuth(0, 5, 3, false), false)
})
await t('shouldRestartForAuth: pending interrupt blocks restart', () => assert.equal(L.shouldRestartForAuth(0, 1, 0, true), false))
await t('shouldRestartForAuth: idle + stale gen restarts', () => assert.equal(L.shouldRestartForAuth(0, 1, 0, false), true))
await t('shouldRestartForAuth: same gen never restarts', () => assert.equal(L.shouldRestartForAuth(3, 3, 0, false), false))
await t('shouldRestartForAuth: negative inflight treated idle', () => assert.equal(L.shouldRestartForAuth(0, 1, -1, false), true))
await t('requestAuthRestart bumps generation by exactly 1', () => {
  const g = L.getAuthEnvGeneration(); assert.equal(L.requestAuthRestart(), g + 1); assert.equal(L.getAuthEnvGeneration(), g + 1)
})

// (b) no fallback -> fallbackCleared false, incl. already-authenticated branch
await t('already-authenticated, no fallback: fallbackCleared=false, complete msg sent', async () => {
  const sent: string[] = []; let slot: any = null
  const r = A.startClaudeAuthOnDemand((ty) => { sent.push(ty) }, { get: () => slot, set: f => { slot = f } },
    { ensure: (async () => ({})) as any })
  assert.equal(r.started, true)
  assert.deepEqual(await r.result, { fallbackCleared: false })
  assert.ok(sent.includes('claude_auth_complete'))
  assert.equal(A.isOnDemandAuthInFlight(), false)
})
await t('already-authenticated WITH fallback active: fallbackCleared=true', async () => {
  process.env.Z_AI_PERSONAL_API_KEY = 'zk-test'; A.applyAuthFallback()
  let slot: any = null
  const r = A.startClaudeAuthOnDemand(() => {}, { get: () => slot, set: f => { slot = f } }, { ensure: (async () => ({})) as any })
  assert.deepEqual(await r.result, { fallbackCleared: true })
  delete process.env.Z_AI_PERSONAL_API_KEY
})
await t('failed flow: fallbackCleared=false, guard released, slot nulled', async () => {
  let slot: any = null; const sent: string[] = []
  const mine = () => {}
  const r = A.startClaudeAuthOnDemand((ty) => { sent.push(ty) }, { get: () => slot, set: f => { slot = f } },
    { ensure: (async () => ({ submitCode: mine, done: Promise.reject(new Error('boom')) })) as any })
  assert.deepEqual(await r.result, { fallbackCleared: false })
  assert.equal(slot, null); assert.ok(sent.includes('claude_auth_error')); assert.equal(A.isOnDemandAuthInFlight(), false)
})

// (c) double start
await t('back-to-back starts: single ensure call, second not started, same promise', async () => {
  let calls = 0; let release!: () => void
  const done = new Promise<void>(r => { release = r }); let slot: any = null
  const mine = () => {}
  const ens = (async () => { calls++; return { submitCode: mine, done } }) as any
  const io = { get: () => slot, set: (f: any) => { slot = f } }
  const a = A.startClaudeAuthOnDemand(() => {}, io, { ensure: ens })
  const b = A.startClaudeAuthOnDemand(() => {}, io, { ensure: ens })
  await tick()
  assert.equal(a.started, true); assert.equal(b.started, false); assert.equal(a.result, b.result)
  assert.equal(calls, 1); assert.equal(slot, mine); assert.equal(A.isOnDemandAuthInFlight(), true)
  release(); await a.result
  assert.equal(slot, null); assert.equal(A.isOnDemandAuthInFlight(), false)
})
await t('settle does not null a slot replaced by another flow', async () => {
  let slot: any = null; let release!: () => void
  const done = new Promise<void>(r => { release = r }); const other = () => {}
  const r = A.startClaudeAuthOnDemand(() => {}, { get: () => slot, set: f => { slot = f } },
    { ensure: (async () => ({ submitCode: () => {}, done })) as any })
  await tick(); slot = other; release(); await r.result
  assert.equal(slot, other)
})
await t('after settle a new start is allowed again', async () => {
  let slot: any = null
  const io = { get: () => slot, set: (f: any) => { slot = f } }
  await A.startClaudeAuthOnDemand(() => {}, io, { ensure: (async () => ({})) as any }).result
  const r2 = A.startClaudeAuthOnDemand(() => {}, io, { ensure: (async () => ({})) as any })
  assert.equal(r2.started, true); await r2.result
})
await t('ensure throws synchronously-ish: guard still released', async () => {
  let slot: any = null
  const r = A.startClaudeAuthOnDemand(() => {}, { get: () => slot, set: f => { slot = f } }, { ensure: (async () => { throw new Error('x') }) as any })
  assert.deepEqual(await r.result, { fallbackCleared: false }); assert.equal(A.isOnDemandAuthInFlight(), false)
})

// (d) env snapshot/restore
await t('restore: operator values come back, unset ones are deleted', () => {
  process.env.ANTHROPIC_MODEL = 'op-model'; delete process.env.ANTHROPIC_SMALL_FAST_MODEL; process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '12345'
  process.env.Z_AI_PERSONAL_API_KEY = 'zk'
  A.applyAuthFallback()
  assert.notEqual(process.env.ANTHROPIC_MODEL, 'op-model')
  assert.equal(A.clearAuthFallbackIfActive(), true)
  assert.equal(process.env.ANTHROPIC_MODEL, 'op-model')
  assert.equal(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '12345')
  assert.equal(process.env.ANTHROPIC_SMALL_FAST_MODEL, undefined)
  assert.equal(process.env.ANTHROPIC_BASE_URL, undefined)
  delete process.env.Z_AI_PERSONAL_API_KEY; delete process.env.ANTHROPIC_MODEL; delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
})
await t('double applyAuthFallback does not snapshot its own values', () => {
  process.env.ANTHROPIC_MODEL = 'orig'; process.env.Z_AI_PERSONAL_API_KEY = 'zk'
  A.applyAuthFallback(); A.applyAuthFallback()
  A.clearAuthFallbackIfActive()
  assert.equal(process.env.ANTHROPIC_MODEL, 'orig')
  delete process.env.ANTHROPIC_MODEL; delete process.env.Z_AI_PERSONAL_API_KEY
})
await t('OpenRouter tier also restores', () => {
  process.env.ANTHROPIC_MODEL = 'orig2'; process.env.OPENROUTER_API_KEY = 'or'
  A.applyAuthFallback(); assert.notEqual(process.env.ANTHROPIC_MODEL, 'orig2')
  A.clearAuthFallbackIfActive(); assert.equal(process.env.ANTHROPIC_MODEL, 'orig2')
  delete process.env.ANTHROPIC_MODEL; delete process.env.OPENROUTER_API_KEY
})
await t('re-activation after clear snapshots fresh values', () => {
  process.env.Z_AI_PERSONAL_API_KEY = 'zk'; process.env.ANTHROPIC_MODEL = 'v1'
  A.applyAuthFallback(); A.clearAuthFallbackIfActive()
  process.env.ANTHROPIC_MODEL = 'v2'; A.applyAuthFallback(); A.clearAuthFallbackIfActive()
  assert.equal(process.env.ANTHROPIC_MODEL, 'v2')
  delete process.env.ANTHROPIC_MODEL; delete process.env.Z_AI_PERSONAL_API_KEY
})
await t('clear with no fallback active: returns false, env untouched', () => {
  process.env.ANTHROPIC_MODEL = 'keep'
  assert.equal(A.clearAuthFallbackIfActive(), false); assert.equal(process.env.ANTHROPIC_MODEL, 'keep')
  delete process.env.ANTHROPIC_MODEL
})
await t('user-supplied ANTHROPIC_BASE_URL untouched when no fallback', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://mine'; A.clearAuthFallbackIfActive()
  assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://mine'); delete process.env.ANTHROPIC_BASE_URL
})

// (e) static log checks
const src = readFileSync(new URL('../src/claude-auth.ts', import.meta.url), 'utf8')
await t('no log line prints token.substring / starts with', () => {
  assert.ok(!/token\.substring/.test(src)); assert.ok(!/starts with/.test(src))
  for (const l of src.split('\n')) if (/console\.(log|warn|error)/.test(l)) assert.ok(!/\$\{token[^}]*\}/.test(l) || /token\.length/.test(l), l)
})
await t('index.ts no longer aborts query on auth start', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const i = idx.indexOf("claude_auth_start"); const seg = idx.slice(i, i + 3500)
  assert.ok(!/abortQuery|abortAgent|setContinueSession/.test(seg)); assert.ok(/requestAuthRestart/.test(seg))
})
await t('(e) raw CLI output log (claude-auth.ts [claude-cli]) is redacted of sk-ant tokens', () => {
  const m = src.match(/console\.log\(`🔑 \[claude-cli\][^\n]*/)
  assert.ok(m, 'log line not found')
  assert.ok(/sk-ant|redact/i.test(src.slice(src.indexOf('Debug log (truncated)'), src.indexOf('Debug log (truncated)') + 300)), 'CLI output echoed verbatim; may contain token')
})
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0)
