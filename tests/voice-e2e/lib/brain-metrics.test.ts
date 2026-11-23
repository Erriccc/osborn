/**
 *   npx tsx --test lib/brain-metrics.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { metricsDelta, NO_USAGE, readTotals } from './brain-metrics.ts'

test('a snapshot does not follow the live totals Stagehand keeps adding to', async () => {
  const live = { totalPromptTokens: 100, totalCompletionTokens: 10, totalReasoningTokens: 0, totalInferenceTimeMs: 500 }
  const sh = { get metrics() { return Promise.resolve(live) } }  // Stagehand 3.7 local mode
  const before = await readTotals(sh)
  live.totalPromptTokens += 1000; live.totalCompletionTokens += 50; live.totalReasoningTokens += 40; live.totalInferenceTimeMs += 1200
  assert.deepEqual(metricsDelta(before, await readTotals(sh)), { tokens: { prompt: 1000, completion: 50, reasoning: 40, total: 1090 }, modelMs: 1200 })
})

test('no brain or a failed read gives no snapshot', async () => {
  assert.equal(await readTotals(null), null)
  assert.equal(await readTotals({ get metrics(): Promise<never> { return Promise.reject(new Error('api down')) } }), null)
})

test('a fresh act reports the tokens and model time it added', () => {
  const u = metricsDelta({ totalPromptTokens: 100, totalCompletionTokens: 10, totalReasoningTokens: 0, totalInferenceTimeMs: 500 }, { totalPromptTokens: 1100, totalCompletionTokens: 60, totalReasoningTokens: 300, totalInferenceTimeMs: 1700 })
  assert.deepEqual(u, { tokens: { prompt: 1000, completion: 50, reasoning: 300, total: 1350 }, modelMs: 1200 })
})

test('a cached replay (totals unchanged) reports 0', () => {
  const t = { totalPromptTokens: 5, totalCompletionTokens: 2, totalInferenceTimeMs: 90 }
  assert.deepEqual(metricsDelta(t, { ...t }), NO_USAGE)
})

test('missing snapshots or a counter reset report 0, never negative', () => {
  assert.deepEqual(metricsDelta(null, { totalPromptTokens: 1 }), NO_USAGE)
  assert.deepEqual(metricsDelta({ totalPromptTokens: 9 }, { totalPromptTokens: 3 }), NO_USAGE)
})
