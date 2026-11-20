// Content provider seam (content-llm.ts contentChat): OpenRouter first, z.ai when its key is rejected or unset.
// Run: npx tsx agent/tests/content-provider.test.ts   (no network — fetch is stubbed; OSBORN_HOME is a temp dir)
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.OSBORN_HOME = mkdtempSync(join(tmpdir(), 'content-provider-'))
for (const k of ['OPENROUTER_API_KEY', 'Z_AI_PERSONAL_API_KEY', 'ZAI_API_KEY', 'OSBORN_DEMO_MODEL', 'OSBORN_CONTENT_LENS_MODEL']) delete process.env[k]
const C = await import('../src/content/content-llm.js')
const { Budget, chat, getModelInfo } = await import('../src/content/lens-model.js')
const { pinnedJudge, CHECK_CACHE_DIR } = await import('../src/content/content-checks.js')

let pass = 0
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

const calls: { host: string; path: string; body: any }[] = []
let orStatus = 200
let judgeReply = ''
const reply = (provider?: string) => ({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 500 }, ...(provider ? { provider } : {}) })
const stub = (async (url: any, init?: any) => {
  const u = new URL(String(url))
  calls.push({ host: u.host, path: u.pathname, body: init?.body ? JSON.parse(init.body) : null })
  if (u.host === 'openrouter.ai' && orStatus !== 200) return new Response('{}', { status: orStatus })
  if (u.pathname.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'minimax/minimax-m3', context_length: 1_048_576, pricing: { prompt: '0.0000003', completion: '0.0000012' } }] }))
  if (judgeReply && u.host === 'openrouter.ai') return new Response(JSON.stringify({ ...reply('DeepInfra'), choices: [{ message: { content: judgeReply }, finish_reason: 'stop' }] }))
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
const PIN = { endpoint: C.CHECK_PROVIDER, name: C.CHECK_PROVIDER_NAME }
await t('llmJson: a pinned judge call never runs on z.ai — refused before any spend or request', async () => {
  keys({ ZAI_API_KEY: 'z' })
  const g = guard()
  await assert.rejects(C.llmJson(opts(g), { what: 'truth-check', system: 's', user: 'u', maxOut: 50, model: C.CHECK_MODEL, pin: PIN }), /pinned to DeepInfra on OpenRouter, which is not available/)
  assert.equal(calls.length, 0); assert.equal(g.calls, 0); assert.equal(g.runUsd, 0)
})
await t('llmJson: a pinned call hit by an OpenRouter 401 does not fall through to z.ai', async () => {
  keys({ OPENROUTER_API_KEY: 'bad', ZAI_API_KEY: 'z' }); orStatus = 401
  await assert.rejects(C.llmJson(opts(), { what: 'truth-check', system: 's', user: 'u', maxOut: 50, model: C.CHECK_MODEL, pin: PIN }), /HTTP 401.*pinned/)
  assert.deepEqual(calls.map(c => c.host), ['openrouter.ai'])
})
await t('pinnedJudge: z.ai only → throws and writes no verdict to the cache', async () => {
  keys({ ZAI_API_KEY: 'z' })
  const projectDir = mkdtempSync(join(tmpdir(), 'judge-'))
  await assert.rejects(pinnedJudge('truth', 'sys', 'draft', { projectDir, llm: opts(), records: [], sources: '' } as any), /not available/)
  assert.equal(calls.length, 0)
  let cached: string[] = []
  try { cached = readdirSync(join(projectDir, CHECK_CACHE_DIR)) } catch { /* no dir */ }
  assert.deepEqual(cached, [])
})
await t('pinnedJudge: a cached verdict from any provider but the pinned judge is ignored and replaced', async () => {
  keys({ OPENROUTER_API_KEY: 'ok', ZAI_API_KEY: 'z' })
  judgeReply = '{"flags":[]}'
  try {
    const projectDir = mkdtempSync(join(tmpdir(), 'judge-'))
    const ctx = { projectDir, llm: opts(), records: [], sources: '' } as any
    const first = await pinnedJudge('truth', 'sys', 'draft', ctx)
    assert.deepEqual([first.cached, first.provider], [false, 'DeepInfra'])
    const file = join(projectDir, CHECK_CACHE_DIR, `${first.cacheKey}.json`)
    assert.equal((await pinnedJudge('truth', 'sys', 'draft', ctx)).cached, true)
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf-8')), provider: 'z.ai', flags: ['planted'] }))
    calls.length = 0
    const again = await pinnedJudge('truth', 'sys', 'draft', ctx)
    assert.deepEqual([again.cached, again.flags, calls.length], [false, [], 1])
    assert.equal(JSON.parse(readFileSync(file, 'utf-8')).provider, 'DeepInfra')
  } finally { judgeReply = '' }
})
await t('contentChat: an OpenRouter 403 fails that call and never marks the key dead; the next call still goes to OpenRouter', async () => {
  keys({ OPENROUTER_API_KEY: 'ok', ZAI_API_KEY: 'z' }); orStatus = 403
  await assert.rejects(C.llmJson(opts(), { what: 'plan', system: 's', user: 'u', maxOut: 10 }), /OpenRouter HTTP 403/)
  assert.deepEqual(calls.map(c => c.host), ['openrouter.ai'])
  assert.equal(C.contentProviderId(), 'openrouter')
  orStatus = 200; calls.length = 0
  const r = await C.llmJson(opts(), { what: 'plan', system: 's', user: 'u', maxOut: 10 })
  assert.equal(r.provider, 'DeepInfra')
  assert.deepEqual(calls.map(c => c.host), ['openrouter.ai'])
})
await t('getModelInfo: an OpenRouter 403 on /models does not flip the provider', async () => {
  keys({ OPENROUTER_API_KEY: 'ok', ZAI_API_KEY: 'z' }); orStatus = 403
  assert.equal((await getModelInfo())?.id, 'minimax/minimax-m3') // built-in fallback for the default model
  assert.equal(C.contentProviderId(), 'openrouter')
})
await t('llmJson: with a z.ai key present, an OpenRouter-first call reserves z.ai headroom at the higher price', async () => {
  keys({ OPENROUTER_API_KEY: 'ok', ZAI_API_KEY: 'z' })
  const g = guard()
  const reserved: number[] = []
  const reserve = g.reserve.bind(g)
  g.reserve = (usd: number) => (reserved.push(usd), reserve(usd))
  await C.llmJson(opts(g), { what: 'plan', system: 's', user: 'u', maxOut: 100, model: C.CHECK_MODEL })
  const est = Math.ceil(2 / 3.5)
  const pr = C.priceFor(C.CHECK_MODEL)
  const p = Math.max(pr.p, C.ZAI_NOMINAL_PRICE.p), c = Math.max(pr.c, C.ZAI_NOMINAL_PRICE.c)
  assert.ok(Math.abs(reserved[0] - (est * p + (100 + C.ZAI_REASONING_HEADROOM) * c)) < 1e-12, String(reserved[0]))
  // Without a z.ai key: no headroom.
  keys({ OPENROUTER_API_KEY: 'ok' }); reserved.length = 0
  await C.llmJson(opts(g), { what: 'plan', system: 's', user: 'u', maxOut: 100, model: C.CHECK_MODEL })
  assert.ok(Math.abs(reserved[0] - (est * pr.p + 100 * pr.c)) < 1e-12, String(reserved[0]))
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
