// Outbound-query gate (Stage A research): private text must never reach HN / GitHub search.
// Run: npx tsx agent/tests/content-query-gate.test.ts   (no network: fetch is stubbed)
import assert from 'node:assert/strict'
import { gateQuery, gateQueries, privateSegments } from '../src/content/content-query-gate.js'
import { researchTopic } from '../src/content/content-research.js'
import { validateCandidates } from '../src/content/content-brief.js'
import { SpendGuard } from '../src/content/content-llm.js'

let pass = 0, fail = 0
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { fail++; console.log('FAIL ', name, '\n     ', String(e?.message ?? e)) }
}

const priv = privateSegments(['/Users/x/acme-billing', 'acme-billing'])

await t('"acme-billing refresh_token bug" with project basename acme-billing is dropped', () => {
  assert.equal(gateQuery('acme-billing refresh_token bug', priv), null)
})
await t('project basename alone (no underscore) still drops the query, case-insensitive, incl. as a spaced phrase', () => {
  assert.equal(gateQuery('ACME-Billing token bug', priv), null)
  assert.equal(gateQuery('acme billing token bug', priv), null)
})
await t('"/Users/x/repo error" is dropped', () => {
  assert.equal(gateQuery('/Users/x/repo error', priv), null)
  assert.equal(gateQuery('/Users/x/repo error'), null)
})
await t('"claude code memory compaction" is kept', () => {
  assert.equal(gateQuery('claude code memory compaction', priv), 'claude code memory compaction')
})
await t('drops \\ @ :// _ CamelCase-in-the-middle and other characters', () => {
  for (const q of ['C:\\repo crash', 'mail me@x.com bug', 'https://x.io timeout', 'snake_case names', 'refreshToken expiry bug', 'MyApp login loop', 'why "quotes" fail', 'what is this?'])
    assert.equal(gateQuery(q, priv), null, q)
})
await t('requires 2-5 plain words', () => {
  assert.equal(gateQuery('compaction', priv), null)
  assert.equal(gateQuery('one two three four five six', priv), null)
  assert.equal(gateQuery('api key - auth', priv), null)
  assert.equal(gateQuery('c++ build cache', priv), 'c++ build cache')
  assert.equal(gateQuery('node.js memory leak', priv), 'node.js memory leak')
})
await t('gateQueries keeps survivors only, de-duplicated', () => {
  assert.deepEqual(gateQueries(['acme-billing bug', 'claude code compaction', 'Claude Code compaction'], priv), ['claude code compaction'])
})
await t('subtopic fallback is gated too (no query planned, private subtopic → no queries)', () => {
  const c = validateCandidates({ pieces: [{ kind: 'highlight', subtopic: 'fixing AcmeBilling refresh_token rotation', queries: [] }] }, { from: 1, to: 10 }, 4)
  assert.equal(c.length, 1)
  assert.deepEqual(c[0].queries, [])
  const ok = validateCandidates({ pieces: [{ kind: 'highlight', subtopic: 'context loss at compaction', queries: ['x'] }] }, { from: 1, to: 10 }, 4)
  assert.deepEqual(ok[0].queries, ['context loss at compaction'])
})
await t('all-dropped topic: no fetch is called, research takes the no-threads path', async () => {
  const real = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (u: any) => { urls.push(String(u)); return new Response('{}', { status: 200 }) }) as typeof fetch
  try {
    const guard = new SpendGuard(null, { periodUsd: 1, dailyUsd: 1, maxPieces: 4 })
    const r = await researchTopic(
      { subtopic: 'acme-billing token refresh', queries: ['acme-billing refresh_token bug', '/Users/x/repo error'] },
      { projectDir: null, llm: { apiKey: 'none', guard, scrub: s => s }, privateTerms: priv },
    )
    assert.equal(urls.length, 0, `fetched: ${urls.join(', ')}`)
    assert.equal(r.status, 'no-threads')
    assert.deepEqual(r.topic.queries, [])
  } finally {
    globalThis.fetch = real
  }
})
await t('control: a clean query does reach the stubbed search', async () => {
  const real = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (u: any) => { urls.push(String(u)); return new Response('{}', { status: 200 }) }) as typeof fetch
  try {
    const guard = new SpendGuard(null, { periodUsd: 1, dailyUsd: 1, maxPieces: 4 })
    await researchTopic({ subtopic: 'compaction', queries: ['claude code memory compaction'] }, { projectDir: null, llm: { apiKey: 'none', guard, scrub: s => s }, privateTerms: priv })
    assert.ok(urls.length > 0)
    assert.ok(urls.every(u => !/acme|Users/i.test(decodeURIComponent(u))))
  } finally {
    globalThis.fetch = real
  }
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
