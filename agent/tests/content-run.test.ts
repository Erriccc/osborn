// Stage A content pipeline: run-level contract (BLIND, spec-derived; all network/LLM stubbed, no spend).
// Run: npx tsx agent/tests/content-run.test.ts   (one file at a time)
import { fresh, runOnce, statusOf, slugOf, scriptPosts, t, done } from './_content-stage-a-harness.js'
import { pick } from './_content-fixture.js'

// ===== IMPORT ADAPTER (only place with guessed names) =====
const mod: Record<string, any> = await import('../src/content/content-run.js')
const runStageA = pick(mod, ['runContentStep', 'runContentPlanStep', 'runContentPipeline', 'runContentPipelineStep', 'runContentRun', 'runContent', 'runStageA'], 'Stage A entry (content-run.ts)')
// ==========================================================

import assert from 'node:assert/strict'
const run = (fx: any, extra = {}) => runOnce(runStageA, fx, extra)
const chats = (fx: any) => fx.scenario.chat.length
const posts = (fx: any) => scriptPosts(fx.scenario)

await t('default ON: unset OSBORN_CONTENT_PIPELINE runs, calls the LLM and ingests script drafts', async () => {
  const fx = await fresh('default-on'); const o = await run(fx)
  assert.equal(o.threw, null); assert.ok(chats(fx) > 0, 'no LLM call'); assert.ok(posts(fx).length > 0, `no script ingest, status=${statusOf(o.res)}`)
})

for (const v of ['0', 'off', 'false', 'no', 'OFF', ' No ']) {
  await t(`kill switch OSBORN_CONTENT_PIPELINE=${JSON.stringify(v)} -> no LLM, no ingest, no throw`, async () => {
    const fx = await fresh('kill', { OSBORN_CONTENT_PIPELINE: v }); const o = await run(fx)
    assert.equal(o.threw, null); assert.equal(chats(fx), 0); assert.equal(fx.scenario.ingest.length, 0)
  })
}
for (const k of ['OSBORN_CONTENT_LENS', 'OSBORN_CONTENT_INGEST']) {
  await t(`${k}=0 also disables the pipeline`, async () => {
    const fx = await fresh('kill2', { [k]: '0' }); const o = await run(fx)
    assert.equal(o.threw, null); assert.equal(chats(fx), 0); assert.equal(fx.scenario.ingest.length, 0)
  })
}

await t('idempotent per period: second run makes zero new LLM calls and spends nothing', async () => {
  const fx = await fresh('idem'); const a = await run(fx); assert.equal(a.threw, null)
  const c1 = chats(fx); assert.ok(c1 > 0 && posts(fx).length > 0)
  const b = await run(fx); assert.equal(b.threw, null)
  assert.equal(chats(fx), c1, 'second run re-spent (extra LLM calls)')
  const cost = b.res?.costUsd ?? b.res?.spentUsd ?? b.res?.cost ?? 0
  assert.ok(!cost, `second run reported cost ${cost}`)
})

await t('period cap default ($0.75): exceeding it yields status "capped", not error, no throw', async () => {
  const fx = await fresh('pcap'); fx.scenario.costPerCall = 0.8; const o = await run(fx)
  assert.equal(o.threw, null); assert.equal(statusOf(o.res), 'capped', `status=${statusOf(o.res)}`)
})
await t('period cap env override is honoured', async () => {
  const fx = await fresh('pcap2', { OSBORN_CONTENT_PERIOD_CAP_USD: '0.0001' }); const o = await run(fx)
  assert.equal(o.threw, null); assert.equal(statusOf(o.res), 'capped')
})
await t('daily cap default ($2.00) with period cap lifted: status "capped"', async () => {
  const fx = await fresh('dcap', { OSBORN_CONTENT_PERIOD_CAP_USD: '1000' }); fx.scenario.costPerCall = 2.5; const o = await run(fx)
  assert.equal(o.threw, null); assert.equal(statusOf(o.res), 'capped', `status=${statusOf(o.res)}`)
})
await t('below both caps is NOT capped (control)', async () => {
  const fx = await fresh('nocap'); fx.scenario.costPerCall = 0.001; const o = await run(fx)
  assert.notEqual(statusOf(o.res), 'capped'); assert.notEqual(statusOf(o.res), 'error')
})

await t('any truth-check flag blocks ingest of script drafts', async () => {
  const fx = await fresh('truth'); fx.scenario.truthFlags = true; const o = await run(fx)
  assert.equal(o.threw, null); assert.equal(posts(fx).length, 0, 'flagged piece was ingested')
})
await t('truth-check control: zero flags -> ingest happens', async () => {
  const fx = await fresh('truth0'); await run(fx); assert.ok(posts(fx).length > 0)
})

for (const mode of ['throw', 'http500', 'garbage'] as const) {
  await t(`fail-open: injected LLM ${mode} never throws, nothing bogus ingested`, async () => {
    const fx = await fresh('fo-' + mode); fx.scenario.mode = mode; const o = await run(fx)
    assert.equal(o.threw, null, String((o.threw as any)?.stack ?? o.threw)); assert.equal(posts(fx).length, 0)
  })
}
await t('fail-open: ingest endpoint HTTP 500 never throws', async () => {
  const fx = await fresh('fo-ing'); fx.scenario.ingestStatus = 500; const o = await run(fx); assert.equal(o.threw, null)
})
await t('fail-open: no sync token -> quiet skip, never throws', async () => {
  const fx = await fresh('fo-tok', { OSBORN_SYNC_TOKEN: undefined }); const o = await run(fx); assert.equal(o.threw, null)
})

await t('ingest payload: type text_post, project_slug in source_anchors', async () => {
  const fx = await fresh('payload'); await run(fx); const p = posts(fx); assert.ok(p.length > 0)
  for (const x of p) {
    assert.equal(x.payload.type, 'text_post')
    assert.equal(typeof x.payload.source_anchors?.project_slug, 'string'); assert.ok(x.payload.source_anchors.project_slug.length > 0)
    assert.ok(/^[0-9a-f]{64}$/.test(x.payload.content_hash ?? ''), 'content_hash missing')
    assert.ok(!('status' in x.payload) && !('published_at' in x.payload), 'payload must not set status/published_at')
  }
})
await t('ingest payload: project_slug equals the project dir slug (assumed derivation)', async () => {
  const fx = await fresh('slug'); await run(fx); const p = posts(fx); assert.ok(p.length > 0)
  for (const x of p) assert.equal(x.payload.source_anchors.project_slug, slugOf(fx))
})
await t('ingest uses content_ingest RPC with p_token/p_payload envelope', async () => {
  const fx = await fresh('env'); await run(fx); const x = posts(fx)[0]; assert.ok(x)
  const b = JSON.parse(x.body); assert.equal(Object.keys(b).sort().join(), 'p_payload,p_token'); assert.equal(b.p_token, 'test-sync-token')
})
done()
