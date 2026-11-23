// npx tsx agent/tests/fastbrain-fallback.test.ts
import assert from 'node:assert/strict'

process.env.FIREWORKS_API_KEY = 'fw'
process.env.OPENROUTER_API_KEY = 'or'
delete process.env.OSBORN_FAST_BRAIN_MODEL
delete process.env.OSBORN_DEMO_PASS
const fb = await import('../src/pipeline-fastbrain.js')

assert.equal(fb.isModelNotFound(404, '{"error":"Model not found, inaccessible, and/or not deployed"}'), true)
assert.equal(fb.isModelNotFound(404, 'No endpoints found that support tool use'), false)
assert.equal(fb.isModelNotFound(400, '{"error":{"code":"model_not_found"}}'), true)
assert.equal(fb.isModelNotFound(429, 'model not found'), false)

let script: Array<[number, string]> = []
const urls: string[] = []
globalThis.fetch = (async (url: any) => {
  urls.push(String(url))
  const [status, body] = script.shift() ?? [200, '{}']
  return new Response(body, { status })
}) as typeof fetch
const ok: [number, string] = [200, '{"ok":1}']
const gone: [number, string] = [404, 'Model not found']

// 404 with model-not-found, then 200: retried once on the next model, first marked dead.
script = [gone, ok]
await fb.requestWithFallback({})
assert.equal(urls.length, 2)
assert.match(urls[0], /fireworks/); assert.match(urls[1], /openrouter/)
assert.deepEqual(fb.fastBrainModelStatus(), { model: 'deepseek/deepseek-chat', fallbackFrom: 'accounts/fireworks/models/glm-5p3-flash' })

// Later turns skip the dead model.
urls.length = 0; script = [ok]
await fb.requestWithFallback({})
assert.deepEqual(urls.map((u) => /openrouter/.test(u)), [true])

// TTL expiry: the dead model is tried again.
const realNow = Date.now
Date.now = () => realNow() + 11 * 60_000
urls.length = 0; script = [ok]
await fb.requestWithFallback({})
assert.match(urls[0], /fireworks/)
Date.now = realNow

// A bare 404 is not retirement: it throws, marks nothing dead, and the next turn tries the same model.
fb.resetFastBrainFallback()
urls.length = 0; script = [[404, 'No endpoints found']]
await assert.rejects(fb.requestWithFallback({}))
assert.equal(urls.length, 1)
script = [ok]; urls.length = 0
await fb.requestWithFallback({})
assert.match(urls[0], /fireworks/)

// Single candidate: a model-not-found never marks it dead; every turn retries it.
fb.resetFastBrainFallback()
delete process.env.FIREWORKS_API_KEY
const solo = await import('../src/pipeline-fastbrain.js?solo')
solo.resetFastBrainFallback()
for (let i = 0; i < 2; i++) {
  urls.length = 0; script = [gone]
  await assert.rejects(solo.requestWithFallback({}))
  assert.equal(urls.length, 1)
}
console.log('fastbrain-fallback: ok')
