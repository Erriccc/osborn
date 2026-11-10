// Run: cd agent && npx tsx tests/zai-fastbrain-endpoint.test.ts
// The house demo pass fast brain must hit the z.ai GLM Coding Plan endpoint
// (/api/coding/paas/v4). The standard /api/paas/v4 endpoint bills the
// pay-as-you-go wallet instead of the plan quota.
import assert from 'node:assert/strict'
import { resolveFastBrainProvider } from '../src/pipeline-fastbrain.js'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('ok   ', name) } catch (e: any) { fail++; console.log('FAIL ', name, String(e?.message || e).slice(0, 400)) }
}
const KEYS = ['OSBORN_DEMO_PASS', 'Z_AI_PERSONAL_API_KEY', 'ZAI_API_KEY', 'OSBORN_DEMO_FAST_MODEL']
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
function reset() { for (const k of KEYS) delete process.env[k] }

t('no demo pass -> null (user pays own providers)', () => {
  reset(); process.env.Z_AI_PERSONAL_API_KEY = 'k'
  assert.equal(resolveFastBrainProvider(), null)
})
t('demo pass uses the Coding Plan endpoint and glm-5.3-flash', () => {
  reset(); process.env.OSBORN_DEMO_PASS = 'zai'; process.env.Z_AI_PERSONAL_API_KEY = 'k'
  const p = resolveFastBrainProvider()
  assert.ok(p)
  assert.equal(p!.url, 'https://api.z.ai/api/coding/paas/v4/chat/completions')
  assert.ok(!/\/api\/paas\/v4/.test(p!.url))
  assert.equal(p!.model, 'glm-5.3-flash')
})
t('ZAI_API_KEY alone also enables the demo-pass fast brain', () => {
  reset(); process.env.OSBORN_DEMO_PASS = 'zai'; process.env.ZAI_API_KEY = 'k'
  assert.equal(resolveFastBrainProvider()!.url, 'https://api.z.ai/api/coding/paas/v4/chat/completions')
})
t('OSBORN_DEMO_FAST_MODEL overrides the fast model', () => {
  reset(); process.env.OSBORN_DEMO_PASS = 'zai'; process.env.Z_AI_PERSONAL_API_KEY = 'k'; process.env.OSBORN_DEMO_FAST_MODEL = 'glm-x'
  assert.equal(resolveFastBrainProvider()!.model, 'glm-x')
})

reset(); for (const k of KEYS) if (saved[k] !== undefined) process.env[k] = saved[k]
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
