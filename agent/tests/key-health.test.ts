// #87: the active provider the agent declares (agent_ready.provider) and the
// per-key self-test must be HONEST — the real tier, and only a definitive
// auth/billing failure counts as a dead key.
// Run: npx tsx agent/tests/key-health.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate from any real Claude login BEFORE importing: empty HOME means no
// ~/.claude/.credentials.json, so isClaudeAuthenticated() is driven purely by
// CLAUDE_CODE_OAUTH_TOKEN, which we control per-case.
const fakeHome = mkdtempSync(join(tmpdir(), 'osb-keyhealth-'))
process.env.HOME = fakeHome
process.env.CLAUDE_CONFIG_DIR = join(fakeHome, '.claude')

const PROVIDER_VARS = [
  'CLAUDE_CODE_OAUTH_TOKEN', 'OSBORN_DEMO_PASS', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL',
]
const clearProviderEnv = () => { for (const k of PROVIDER_VARS) delete process.env[k] }
clearProviderEnv()

const { resolveActiveProvider } = await import('../src/claude-auth.js')
const { classifyProbeStatus, probeActiveProviderKey } = await import('../src/key-health.js')

let passed = 0
const ok = (label: string) => { passed++; console.log(`  ✓ ${label}`) }

// ── resolveActiveProvider — mirrors applyAuthFallback's tier order ──
console.log('resolveActiveProvider:')
{
  clearProviderEnv()
  assert.equal(resolveActiveProvider(), 'none', 'nothing configured → none')
  ok('nothing configured → none')

  clearProviderEnv()
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-xyz'
  assert.equal(resolveActiveProvider(), 'claude', 'Claude login → claude')
  ok('Claude login → claude')

  // Claude wins over any fallback key (tier 1 short-circuit).
  process.env.OSBORN_DEMO_PASS = 'zai'
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  assert.equal(resolveActiveProvider(), 'claude', 'Claude beats a configured fallback')
  ok('Claude beats a configured fallback')

  clearProviderEnv()
  process.env.OSBORN_DEMO_PASS = 'zai'
  assert.equal(resolveActiveProvider(), 'zai', 'house demo pass → zai')
  ok('house demo pass → zai')

  clearProviderEnv()
  process.env.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api'
  process.env.ANTHROPIC_AUTH_TOKEN = 'or-key'
  assert.equal(resolveActiveProvider(), 'openrouter', 'openrouter base URL → openrouter')
  ok('openrouter base URL → openrouter')

  clearProviderEnv()
  process.env.ANTHROPIC_API_KEY = 'sk-user-own'
  assert.equal(resolveActiveProvider(), 'anthropic', "user's own Anthropic key → anthropic")
  ok("user's own Anthropic key → anthropic")

  clearProviderEnv()
  process.env.ANTHROPIC_AUTH_TOKEN = 'gateway-tok'
  process.env.ANTHROPIC_BASE_URL = 'https://my-gateway.example.com'
  assert.equal(resolveActiveProvider(), 'anthropic', 'own Anthropic-compatible gateway → anthropic')
  ok('own Anthropic-compatible gateway → anthropic')

  // Quote-stripping: a demo pass value with surrounding quotes still resolves.
  clearProviderEnv()
  process.env.OSBORN_DEMO_PASS = '"zai"'
  assert.equal(resolveActiveProvider(), 'zai', 'quoted OSBORN_DEMO_PASS still → zai')
  ok('quoted OSBORN_DEMO_PASS still → zai')
}

// ── classifyProbeStatus — only definitive failures count ──
console.log('classifyProbeStatus:')
{
  assert.equal(classifyProbeStatus(200), 'ok')
  assert.equal(classifyProbeStatus(204), 'ok')
  assert.equal(classifyProbeStatus(429), 'ok', 'rate-limited key is still valid')
  ok('2xx + 429 → ok')
  assert.equal(classifyProbeStatus(401), 'expired')
  assert.equal(classifyProbeStatus(403), 'expired')
  ok('401/403 → expired')
  assert.equal(classifyProbeStatus(402), 'failed', 'billing depleted → failed')
  ok('402 → failed')
  // Ambiguous: endpoint quirks / 5xx must NOT fabricate a failure.
  assert.equal(classifyProbeStatus(400), null)
  assert.equal(classifyProbeStatus(404), null)
  assert.equal(classifyProbeStatus(500), null)
  assert.equal(classifyProbeStatus(503), null)
  ok('400/404/5xx → null (no fabricated verdict)')
}

// ── probeActiveProviderKey — reads the active env, classifies conservatively ──
console.log('probeActiveProviderKey:')
{
  clearProviderEnv()
  // No credential configured → nothing to test → null.
  const none = await probeActiveProviderKey('zai')
  assert.equal(none, null, 'no credential → null')
  ok('no credential → null')

  const realFetch = globalThis.fetch
  const stub = (status: number) => {
    globalThis.fetch = (async () => ({ status })) as unknown as typeof fetch
  }
  try {
    process.env.ANTHROPIC_AUTH_TOKEN = 'zai-key'
    process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic'
    process.env.ANTHROPIC_MODEL = 'glm-5.3'

    stub(200)
    const okRes = await probeActiveProviderKey('zai')
    assert.deepEqual(okRes && { provider: okRes.provider, status: okRes.status }, { provider: 'zai', status: 'ok' })
    assert.ok(okRes?.checkedAt, 'ok result carries a timestamp')
    ok('200 → { zai, ok }')

    stub(401)
    const deadRes = await probeActiveProviderKey('zai')
    assert.deepEqual(deadRes && { provider: deadRes.provider, status: deadRes.status }, { provider: 'zai', status: 'expired' })
    ok('401 → { zai, expired }')

    stub(500)
    const ambiguous = await probeActiveProviderKey('zai')
    assert.equal(ambiguous, null, '500 → null (no verdict)')
    ok('500 → null')

    // A thrown fetch (network error) must never fabricate a failure.
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const netErr = await probeActiveProviderKey('zai')
    assert.equal(netErr, null, 'network error → null')
    ok('network error → null')
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log(`\n✅ key-health: ${passed} assertions passed`)
