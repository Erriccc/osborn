// Run: cd agent && npx tsx tests/zai-endpoints-adversarial.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Isolate from any real Claude login on the host so Tier 1 never short-circuits.
const fakeHome = mkdtempSync(join(tmpdir(), 'zai-adv-'))
process.env.HOME = fakeHome
process.env.CLAUDE_CONFIG_DIR = join(fakeHome, '.claude')
const { applyAuthFallback, clearAuthFallbackIfActive, classifyProbeStatus, probeActiveProviderKey } = await import('../src/claude-auth.js')
const { resolveFastBrainProvider } = await import('../src/pipeline-fastbrain.js')

let pass = 0, fail = 0
async function t(name: string, fn: () => unknown) {
  try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { fail++; console.log('FAIL ', name, String(e?.message || e).slice(0, 400)) }
}
const KEYS = ['OSBORN_DEMO_PASS','Z_AI_PERSONAL_API_KEY','ZAI_API_KEY','OSBORN_DEMO_FAST_MODEL','OSBORN_DEMO_MODEL','OSBORN_DEMO_BASE_URL',
  'ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL','ANTHROPIC_SMALL_FAST_MODEL','OPENROUTER_API_KEY','CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SUBAGENT_MODEL','CLAUDE_CODE_SUBAGENT_MODEL_FORCE','CLAUDE_CODE_MAX_CONTEXT_TOKENS','OSBORN_FORCE_CLAUDE_LOGIN']
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
function reset() { clearAuthFallbackIfActive(); for (const k of KEYS) delete process.env[k] }
const CODING = 'https://api.z.ai/api/coding/paas/v4/chat/completions'

await t('(a) defaults: base url, glm-5.3, glm-5.3-flash', () => {
  reset(); process.env.Z_AI_PERSONAL_API_KEY = 'k'
  assert.equal(applyAuthFallback(), 'zai')
  assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic')
  assert.equal(process.env.ANTHROPIC_MODEL, 'glm-5.3')
  assert.equal(process.env.ANTHROPIC_SMALL_FAST_MODEL, 'glm-5.3-flash')
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, 'k')
  assert.equal(process.env.OSBORN_DEMO_PASS, 'zai')
})
await t('(a) ZAI_API_KEY alone works for main tier', () => {
  reset(); process.env.ZAI_API_KEY = 'k2'
  assert.equal(applyAuthFallback(), 'zai')
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, 'k2')
  assert.equal(process.env.ANTHROPIC_MODEL, 'glm-5.3')
})
await t('(a) whitespace-only primary key falls through to ZAI_API_KEY', () => {
  reset(); process.env.Z_AI_PERSONAL_API_KEY = '  '; process.env.ZAI_API_KEY = 'k3'
  assert.equal(applyAuthFallback(), 'zai')
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, 'k3')
})
await t('(d) OSBORN_DEMO_MODEL / FAST_MODEL override main tier', () => {
  reset(); process.env.Z_AI_PERSONAL_API_KEY = 'k'; process.env.OSBORN_DEMO_MODEL = 'm-x'; process.env.OSBORN_DEMO_FAST_MODEL = 'm-y'
  assert.equal(applyAuthFallback(), 'zai')
  assert.equal(process.env.ANTHROPIC_MODEL, 'm-x'); assert.equal(process.env.ANTHROPIC_SMALL_FAST_MODEL, 'm-y')
})
await t('(b) fast path url/model, no legacy', () => {
  reset(); process.env.OSBORN_DEMO_PASS = 'zai'; process.env.Z_AI_PERSONAL_API_KEY = 'k'
  const p = resolveFastBrainProvider()!
  assert.equal(p.url, CODING); assert.equal(p.model, 'glm-5.3-flash')
  assert.ok(!p.url.includes('/api/paas/v4')); assert.ok(!/glm-4/.test(p.model))
})
await t('(b) no key -> null; demo pass not zai -> null', () => {
  reset(); process.env.OSBORN_DEMO_PASS = 'zai'; assert.equal(resolveFastBrainProvider(), null)
  reset(); process.env.Z_AI_PERSONAL_API_KEY = 'k'; process.env.OSBORN_DEMO_PASS = 'other'; assert.equal(resolveFastBrainProvider(), null)
})
await t('(d) OSBORN_DEMO_FAST_MODEL overrides fast path', () => {
  reset(); process.env.OSBORN_DEMO_PASS = 'zai'; process.env.ZAI_API_KEY = 'k'; process.env.OSBORN_DEMO_FAST_MODEL = 'custom'
  assert.equal(resolveFastBrainProvider()!.model, 'custom')
})
await t('(d) empty-string override falls back to default', () => {
  reset(); process.env.OSBORN_DEMO_PASS = 'zai'; process.env.ZAI_API_KEY = 'k'; process.env.OSBORN_DEMO_FAST_MODEL = ''
  assert.equal(resolveFastBrainProvider()!.model, 'glm-5.3-flash')
})
// ── #87: the tier applyAuthFallback DECLARES (→ agent_ready.provider / /health) ──
await t('(e) nothing configured -> none', () => {
  reset(); assert.equal(applyAuthFallback(), 'none')
})
await t('(e) Claude login -> claude, and beats a configured fallback (no redirect)', () => {
  reset(); process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-xyz'
  assert.equal(applyAuthFallback(), 'claude')
  process.env.Z_AI_PERSONAL_API_KEY = 'zai-key'; process.env.ANTHROPIC_API_KEY = 'sk-test'
  assert.equal(applyAuthFallback(), 'claude')
  assert.equal(process.env.ANTHROPIC_BASE_URL, undefined, 'Claude path applies no redirect')
})
await t("(e) user's own Anthropic key -> anthropic", () => {
  reset(); process.env.ANTHROPIC_API_KEY = 'sk-user-own'
  assert.equal(applyAuthFallback(), 'anthropic')
})
await t('(e) OpenRouter key -> openrouter', () => {
  reset(); process.env.OPENROUTER_API_KEY = 'or-key'
  assert.equal(applyAuthFallback(), 'openrouter')
})
await t('(e) own Anthropic-compatible gateway -> anthropic, not a dead end', () => {
  reset(); process.env.ANTHROPIC_AUTH_TOKEN = 'gateway-tok'; process.env.ANTHROPIC_BASE_URL = 'https://my-gateway.example.com'
  assert.equal(applyAuthFallback(), 'anthropic')
})

// ── #87: only a DEFINITIVE credential/billing failure is a dead key ──
await t('(f) classifyProbeStatus: 2xx/429 ok, 401 expired, 402 failed', () => {
  assert.equal(classifyProbeStatus(200), 'ok'); assert.equal(classifyProbeStatus(204), 'ok')
  assert.equal(classifyProbeStatus(429), 'ok', 'rate-limited key is still valid')
  assert.equal(classifyProbeStatus(401), 'expired')
  assert.equal(classifyProbeStatus(402), 'failed', 'billing depleted -> failed')
})
await t('(f) classifyProbeStatus: 400/403/404/5xx fabricate nothing', () => {
  // 403 = WAF / edge block / gateway throttle in front of a GOOD key.
  for (const s of [400, 403, 404, 500, 503]) assert.equal(classifyProbeStatus(s), null, `${s} -> null`)
})

await t('(g) probeActiveProviderKey: no credential -> null', async () => {
  reset(); assert.equal(await probeActiveProviderKey('zai'), null)
})
await t('(g) probeActiveProviderKey: classifies the live endpoint conservatively', async () => {
  reset()
  process.env.ANTHROPIC_AUTH_TOKEN = 'zai-key'
  process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic'
  process.env.ANTHROPIC_MODEL = 'glm-5.3'
  const realFetch = globalThis.fetch
  const stub = (status: number) => { globalThis.fetch = (async () => ({ status })) as unknown as typeof fetch }
  try {
    stub(200)
    assert.deepEqual(await probeActiveProviderKey('zai'), { provider: 'zai', status: 'ok' })
    stub(401)
    assert.deepEqual(await probeActiveProviderKey('zai'), { provider: 'zai', status: 'expired' })
    stub(403)
    assert.equal(await probeActiveProviderKey('zai'), null, '403 -> no verdict (edge block)')
    stub(500)
    assert.equal(await probeActiveProviderKey('zai'), null, '500 -> no verdict')
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    assert.equal(await probeActiveProviderKey('zai'), null, 'network error -> no verdict')
  } finally { globalThis.fetch = realFetch }
})

reset()
for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0)
