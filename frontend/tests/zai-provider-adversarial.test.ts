// Run: cd frontend && npx tsx tests/zai-provider-adversarial.test.ts
import assert from 'node:assert/strict'
import { resolveTextProvider } from '../src/lib/model-provider'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) } catch (e: any) { fail++; console.log('FAIL', name, String(e?.message || e).slice(0, 400)) }
}
const KEYS = ['FIREWORKS_API_KEY','Z_AI_PERSONAL_API_KEY','ZAI_API_KEY','OSBORN_DEMO_FAST_MODEL','OSBORN_DEMO_MODEL']
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
function reset() { for (const k of KEYS) delete process.env[k] }
const CODING = 'https://api.z.ai/api/coding/paas/v4/chat/completions'

t('(c) Z_AI_PERSONAL_API_KEY accepted', () => { reset(); process.env.Z_AI_PERSONAL_API_KEY = 'a'; const p = resolveTextProvider()!; assert.equal(p.key, 'a'); assert.equal(p.url, CODING); assert.equal(p.model, 'glm-5.3-flash') })
t('(c) ZAI_API_KEY accepted', () => { reset(); process.env.ZAI_API_KEY = 'b'; assert.equal(resolveTextProvider()!.key, 'b') })
t('(c) precedence personal > ZAI', () => { reset(); process.env.Z_AI_PERSONAL_API_KEY = 'a'; process.env.ZAI_API_KEY = 'b'; assert.equal(resolveTextProvider()!.key, 'a') })
t('(c) empty personal falls to ZAI', () => { reset(); process.env.Z_AI_PERSONAL_API_KEY = ''; process.env.ZAI_API_KEY = 'b'; assert.equal(resolveTextProvider()!.key, 'b') })
t('no keys -> null', () => { reset(); assert.equal(resolveTextProvider(), null) })
t('no legacy url/model', () => { reset(); process.env.ZAI_API_KEY = 'b'; const p = resolveTextProvider()!; assert.ok(!p.url.includes('/api/paas/v4')); assert.ok(!/glm-4/.test(p.model)) })
t('(d) OSBORN_DEMO_FAST_MODEL overrides', () => { reset(); process.env.ZAI_API_KEY = 'b'; process.env.OSBORN_DEMO_FAST_MODEL = 'zz'; assert.equal(resolveTextProvider()!.model, 'zz') })
t('(d) OSBORN_DEMO_FAST_MODEL empty -> default', () => { reset(); process.env.ZAI_API_KEY = 'b'; process.env.OSBORN_DEMO_FAST_MODEL = ''; assert.equal(resolveTextProvider()!.model, 'glm-5.3-flash') })
t('Fireworks still wins when set', () => { reset(); process.env.FIREWORKS_API_KEY = 'f'; process.env.ZAI_API_KEY = 'b'; assert.equal(resolveTextProvider()!.name, 'Fireworks') })
for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0)
