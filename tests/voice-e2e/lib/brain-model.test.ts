import assert from 'node:assert/strict'
import { geminiCandidates, pickGeminiModel, DEFAULT_GEMINI_MODEL } from './brain-model'

assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.5-flash-lite')
assert.deepEqual(geminiCandidates({}), ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'])
assert.deepEqual(geminiCandidates({ OSBORN_ENGINE_GEMINI_MODEL: 'gemini-x' }), ['gemini-x', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'])
assert.deepEqual(geminiCandidates({ OSBORN_ENGINE_GEMINI_MODEL: 'gemini-3.1-flash-lite' }), ['gemini-3.1-flash-lite', 'gemini-3.8-flash'])
assert.equal(geminiCandidates({ OSBORN_ENGINE_GEMINI_MODEL: '  ' })[0], DEFAULT_GEMINI_MODEL)

const run = async (statuses: Record<string, number | null>) => {
  const calls: string[] = []
  const r = await pickGeminiModel(async (m) => { calls.push(m); return m in statuses ? statuses[m] : 404 }, {})
  return { ...r, calls }
}
void (async () => {
  let r = await run({ 'gemini-3.5-flash-lite': 200 })
  assert.equal(r.model, 'gemini-3.5-flash-lite'); assert.deepEqual(r.calls, ['gemini-3.5-flash-lite'])
  r = await run({ 'gemini-3.1-flash-lite': 200 })
  assert.equal(r.model, 'gemini-3.1-flash-lite'); assert.deepEqual(r.tried, ['gemini 404 (gemini-3.5-flash-lite)'])
  r = await run({ 'gemini-3.8-flash': 200 })
  assert.deepEqual(r.calls, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'])
  r = await run({})
  assert.equal(r.model, null); assert.equal(r.tried.length, 3)
  for (const s of [401, 402, 429, null]) {
    r = await run({ 'gemini-3.5-flash-lite': s })
    assert.equal(r.model, null); assert.equal(r.calls.length, 1, `status ${s} must not try the fallback list`)
    assert.deepEqual(r.tried, [`gemini ${s ?? 'network'} (gemini-3.5-flash-lite)`])
  }
  console.log('brain-model tests passed')
})()
