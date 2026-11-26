import assert from 'node:assert/strict'
import { pickGeminiModel, DEFAULT_GEMINI_MODEL } from './brain-model'

assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.5-flash-lite')

const run = async (statuses: Record<string, number | null>, env: Record<string, string> = {}) => {
  const calls: string[] = []
  const r = await pickGeminiModel(async (m) => { calls.push(m); return m in statuses ? statuses[m] : 404 }, env)
  return { ...r, calls }
}
void (async () => {
  // Candidate order: the env model (else the default), then the fallbacks, without repeats.
  assert.deepEqual((await run({})).calls, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'])
  assert.deepEqual((await run({}, { OSBORN_ENGINE_GEMINI_MODEL: 'gemini-x' })).calls, ['gemini-x', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'])
  assert.deepEqual((await run({}, { OSBORN_ENGINE_GEMINI_MODEL: 'gemini-3.1-flash-lite' })).calls, ['gemini-3.1-flash-lite', 'gemini-3.8-flash'])
  assert.equal((await run({}, { OSBORN_ENGINE_GEMINI_MODEL: '  ' })).calls[0], DEFAULT_GEMINI_MODEL)

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
