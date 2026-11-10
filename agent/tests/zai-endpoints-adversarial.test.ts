// Run: cd agent && npx tsx tests/zai-endpoints-adversarial.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Isolate from any real Claude login on the host so Tier 1 never short-circuits.
const fakeHome = mkdtempSync(join(tmpdir(), 'zai-adv-'))
process.env.HOME = fakeHome
process.env.CLAUDE_CONFIG_DIR = join(fakeHome, '.claude')
const { applyAuthFallback, clearAuthFallbackIfActive } = await import('../src/claude-auth.js')
const { resolveFastBrainProvider } = await import('../src/pipeline-fastbrain.js')

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('ok   ', name) } catch (e: any) { fail++; console.log('FAIL ', name, String(e?.message || e).slice(0, 400)) }
}
const KEYS = ['OSBORN_DEMO_PASS','Z_AI_PERSONAL_API_KEY','ZAI_API_KEY','OSBORN_DEMO_FAST_MODEL','OSBORN_DEMO_MODEL','OSBORN_DEMO_BASE_URL',
  'ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL','ANTHROPIC_SMALL_FAST_MODEL','OPENROUTER_API_KEY','CLAUDE_CODE_OAUTH_TOKEN']
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
function reset() { clearAuthFallbackIfActive(); for (const k of KEYS) delete process.env[k] }
const CODING = 'https://api.z.ai/api/coding/paas/v4/chat/completions'

t('(a) defaults: base url, glm-5.3, glm-5.3-flash', () => {
  reset(); process.env.Z_AI_PERSONAL_API_KEY = 'k'
  applyAuthFallback()
  assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic')
  assert.equal(process.env.ANTHROPIC_MODEL, 'glm-5.3')
  assert.equal(process.env.ANTHROPIC_SMALL_FAST_MODEL, 'glm-5.3-flash')
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, 'k')
  assert.equal(process.env.OSBORN_DEMO_PASS, 'zai')
})
t('(a) ZAI_API_KEY alone works for main tier', () => {
  reset(); process.env.ZAI_API_KEY = 'k2'
  applyAuthFallback()
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, 'k2')
  assert.equal(process.env.ANTHROPIC_MODEL, 'glm-5.3')
})
t('(a) whitespace-only primary key falls through to ZAI_API_KEY', () => {
  reset(); process.env.Z_AI_PERSONAL_API_KEY = '  '; process.env.ZAI_API_KEY = 'k3'
  applyAuthFallback()
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, 'k3')
})
t('(d) OSBORN_DEMO_MODEL / FAST_MODEL override main tier', () => {
  reset(); process.env.Z_AI_PERSONAL_API_KEY = 'k'; process.env.OSBORN_DEMO_MODEL = 'm-x'; process.env.OSBORN_DEMO_FAST_MODEL = 'm-y'
  applyAuthFallback()
  assert.equal(process.env.ANTHROPIC_MODEL, 'm-x'); assert.equal(process.env.ANTHROPIC_SMALL_FAST_MODEL, 'm-y')
})
t('(b) fast path url/model, no legacy', () => {
  reset(); process.env.OSBORN_DEMO_PASS = 'zai'; process.env.Z_AI_PERSONAL_API_KEY = 'k'
  const p = resolveFastBrainProvider()!
  assert.equal(p.url, CODING); assert.equal(p.model, 'glm-5.3-flash')
  assert.ok(!p.url.includes('/api/paas/v4')); assert.ok(!/glm-4/.test(p.model))
})
t('(b) no key -> null; demo pass not zai -> null', () => {
  reset(); process.env.OSBORN_DEMO_PASS = 'zai'; assert.equal(resolveFastBrainProvider(), null)
  reset(); process.env.Z_AI_PERSONAL_API_KEY = 'k'; process.env.OSBORN_DEMO_PASS = 'other'; assert.equal(resolveFastBrainProvider(), null)
})
t('(d) OSBORN_DEMO_FAST_MODEL overrides fast path', () => {
  reset(); process.env.OSBORN_DEMO_PASS = 'zai'; process.env.ZAI_API_KEY = 'k'; process.env.OSBORN_DEMO_FAST_MODEL = 'custom'
  assert.equal(resolveFastBrainProvider()!.model, 'custom')
})
t('(d) empty-string override falls back to default', () => {
  reset(); process.env.OSBORN_DEMO_PASS = 'zai'; process.env.ZAI_API_KEY = 'k'; process.env.OSBORN_DEMO_FAST_MODEL = ''
  assert.equal(resolveFastBrainProvider()!.model, 'glm-5.3-flash')
})
for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0)
