// Content provider seam (content-llm.ts contentChat): OpenRouter first, z.ai when its key is rejected or unset.
// Run: npx tsx agent/tests/content-provider.test.ts   (no network — fetch is stubbed; OSBORN_HOME is a temp dir)
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.OSBORN_HOME = mkdtempSync(join(tmpdir(), 'content-provider-'))
for (const k of ['OPENROUTER_API_KEY', 'Z_AI_PERSONAL_API_KEY', 'ZAI_API_KEY', 'OSBORN_DEMO_MODEL', 'OSBORN_CONTENT_LENS_MODEL']) delete process.env[k]
const C = await import('../src/content/content-llm.js')
const { Budget, chat, getModelInfo } = await import('../src/content/lens-model.js')

let pass = 0
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

const calls: { host: string; path: string; body: any }[] = []
let orStatus = 200
const reply = (provider?: string) => ({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 500 }, ...(provider ? { provider } : {}) })
const stub = (async (url: any, init?: any) => {
  const u = new URL(String(url))
  calls.push({ host: u.host, path: u.pathname, body: init?.body ? JSON.parse(init.body) : null })
  if (u.host === 'openrouter.ai' && orStatus !== 200) return new Response('{}', { status: orStatus })
  if (u.pathname.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'minimax/minimax-m3', context_length: 1_048_576, pricing: { prompt: '0.0000003', completion: '0.0000012' } }] }))
  return new Response(JSON.stringify(reply(u.host === 'openrouter.ai' ? 'DeepInfra' : undefined)))
}) as typeof fetch
globalThis.fetch = stub

const keys = (k: Record<string, string>) => {
  for (const n of ['OPENROUTER_API_KEY', 'Z_AI_PERSONAL_API_KEY', 'ZAI_API_KEY']) delete process.env[n]
  Object.assign(process.env, k)
  C.resetContentProviders(); calls.length = 0; orStatus = 200
}
const guard = () => new C.SpendGuard(null, { periodUsd: 10, dailyUsd: 10, maxPieces: 4 })
const opts = (g = guard()) => ({ guard: g, scrub: (s: string) => s })

await t('llmJson: OpenRouter 401 → z.ai serves the call; result names z.ai and the GLM model', async () => {
  keys({ OPENROUTER_API_KEY: 'bad', ZAI_API_KEY: 'z' }); orStatus = 401
  const r = await C.llmJson(opts(), { what: 'plan', system: 's', user: 'u', maxOut: 100 })
  assert.deepEqual(calls.map(c => c.host), ['openrouter.ai', 'api.z.ai'])
  assert.equal(calls[1].path, '/api/coding/paas/v4/chat/completions')
  assert.equal(calls[1].body.max_tokens, 100 + C.ZAI_REASONING_HEADROOM)
  assert.deepEqual([r.provider, r.model, r.json?.ok], ['z.ai', 'glm-5.3', true])
})
await t('llmJson: z.ai is priced at the nominal rate, so the caps still count and reserve (reasoning headroom included)', async () => {
  keys({ ZAI_API_KEY: 'z' })
  const g = guard()
  const reserved: number[] = []
  const reserve = g.reserve.bind(g)
  g.reserve = (usd: number) => (reserved.push(usd), reserve(usd))
  const r = await C.llmJson(opts(g), { what: 'plan', system: 's', user: 'u', maxOut: 100 })
  const est = Math.ceil(2 / 3.5)
  assert.ok(Math.abs(reserved[0] - (est * C.ZAI_NOMINAL_PRICE.p + (100 + C.ZAI_REASONING_HEADROOM) * C.ZAI_NOMINAL_PRICE.c)) < 1e-12)
  assert.ok(Math.abs(r.costUsd - (1000 * C.ZAI_NOMINAL_PRICE.p + 500 * C.ZAI_NOMINAL_PRICE.c)) < 1e-12)
  assert.equal(g.calls, 1)
  assert.ok(g.runUsd > 0)
})
await t('llmJson: a provider-pinned judge call served by z.ai is not refused as a pin mismatch', async () => {
  keys({ ZAI_API_KEY: 'z' })
  const r = await C.llmJson(opts(), { what: 'truth-check', system: 's', user: 'u', maxOut: 50, model: C.CHECK_MODEL, pin: { endpoint: C.CHECK_PROVIDER, name: C.CHECK_PROVIDER_NAME } })
  assert.equal(r.provider, 'z.ai')
})
await t('llmJson: on OpenRouter the pin is still enforced', async () => {
  keys({ OPENROUTER_API_KEY: 'ok' })
  await assert.rejects(C.llmJson(opts(), { what: 'truth-check', system: 's', user: 'u', maxOut: 50, pin: { endpoint: 'x/y', name: 'Other' } }), /expected pinned Other/)
})
await t('llmJson: neither key → throws the no-key error, nothing sent', async () => {
  keys({})
  await assert.rejects(C.llmJson(opts(), { what: 'plan', system: 's', user: 'u', maxOut: 10 }), new RegExp(C.NO_CONTENT_KEY.replace(/[()]/g, '.')))
  assert.equal(calls.length, 0)
  assert.equal(C.hasContentModelKey(), false)
})
await t('getModelInfo: z.ai → documented 1M context at the nominal price, no OpenRouter /models call', async () => {
  keys({ Z_AI_PERSONAL_API_KEY: 'z' })
  const info = await getModelInfo()
  assert.deepEqual(info, { id: 'glm-5.3', contextLength: 1_000_000, promptPerTok: C.ZAI_NOMINAL_PRICE.p, completionPerTok: C.ZAI_NOMINAL_PRICE.c, verified: false })
  assert.equal(calls.length, 0)
})
await t('getModelInfo: an OpenRouter 401 on /models marks the key rejected and answers for z.ai', async () => {
  keys({ OPENROUTER_API_KEY: 'bad', ZAI_API_KEY: 'z' }); orStatus = 401
  assert.equal((await getModelInfo())?.id, 'glm-5.3')
  assert.equal(C.contentProviderId(), 'zai')
})
await t('lens chat: z.ai worst case includes the reasoning headroom; result says via zai', async () => {
  keys({ ZAI_API_KEY: 'z' })
  const info = (await getModelInfo())!
  const b = new Budget(info, { maxCalls: 1, maxCostUsd: 1 })
  const r = await chat(b, 'hello', 1000)
  assert.deepEqual([r?.via, r?.provider], ['zai', 'z.ai'])
  assert.equal(calls[0].body.max_tokens, 1000 + C.ZAI_REASONING_HEADROOM)
  // A cap that fits maxOut alone but not maxOut + headroom refuses the call.
  const tight = new Budget(info, { maxCalls: 5, maxCostUsd: (1000 + 100) * info.completionPerTok })
  assert.equal(await chat(tight, 'hello', 1000), null)
})

console.log(`\n${pass} passed`)
