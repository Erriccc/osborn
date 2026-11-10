// Run: cd frontend && npx --yes tsx tests/model-provider-zai.test.ts
// The z.ai house-pass fallback for /api/content/{chat,refine} must use the GLM
// Coding Plan endpoint (/api/coding/paas/v4) - the standard /api/paas/v4
// endpoint bills the pay-as-you-go wallet - and accept ZAI_API_KEY as a
// fallback name, the same precedence as the agent.
import assert from 'node:assert/strict'
import { resolveTextProvider } from '../src/lib/model-provider'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) } catch (e: any) { fail++; console.log('FAIL', name, String(e?.message || e).slice(0, 400)) }
}
const KEYS = ['FIREWORKS_API_KEY', 'Z_AI_PERSONAL_API_KEY', 'ZAI_API_KEY', 'OSBORN_DEMO_FAST_MODEL']
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
function reset() { for (const k of KEYS) delete process.env[k] }
const CODING = 'https://api.z.ai/api/coding/paas/v4/chat/completions'

t('Z_AI_PERSONAL_API_KEY -> Coding Plan endpoint, glm-5.3-flash', () => {
  reset(); process.env.Z_AI_PERSONAL_API_KEY = 'a'
  const p = resolveTextProvider()!
  assert.equal(p.url, CODING); assert.equal(p.key, 'a'); assert.equal(p.model, 'glm-5.3-flash')
})
t('ZAI_API_KEY is accepted as a fallback name', () => {
  reset(); process.env.ZAI_API_KEY = 'b'
  const p = resolveTextProvider()!
  assert.equal(p.url, CODING); assert.equal(p.key, 'b')
})
t('Z_AI_PERSONAL_API_KEY takes precedence over ZAI_API_KEY', () => {
  reset(); process.env.Z_AI_PERSONAL_API_KEY = 'a'; process.env.ZAI_API_KEY = 'b'
  assert.equal(resolveTextProvider()!.key, 'a')
})
t('Fireworks still wins when set', () => {
  reset(); process.env.FIREWORKS_API_KEY = 'f'; process.env.Z_AI_PERSONAL_API_KEY = 'a'
  assert.equal(resolveTextProvider()!.name, 'Fireworks')
})
t('no keys -> null', () => { reset(); assert.equal(resolveTextProvider(), null) })

reset(); for (const k of KEYS) if (saved[k] !== undefined) process.env[k] = saved[k]
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
