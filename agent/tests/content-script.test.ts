// Stage A dev-voice pre-pass (rule 7: dev lines verbatim from USER rows only). BLIND; stubbed LLM/network.
// Driven through the run entry so it does not depend on the guessed shape of content-script.ts internals.
// Run: npx tsx agent/tests/content-script.test.ts
import { fresh, runOnce, allBodies, devOverride, DEV_LINE, t, done } from './_content-stage-a-harness.js'
import { pick, ASSISTANT_LINE } from './_content-fixture.js'

// ===== IMPORT ADAPTER (only place with guessed names) =====
const runMod: Record<string, any> = await import('../src/content/content-run.js')
const runStageA = pick(runMod, ['runContentStep', 'runContentPlanStep', 'runContentPipeline', 'runContentPipelineStep', 'runContentRun', 'runContent', 'runStageA'], 'Stage A entry (content-run.ts)')
await import('../src/content/content-script.js') // must exist per spec; behavior is asserted via the entry point
// ==========================================================

import assert from 'node:assert/strict'
const norm = (s: string) => s.replace(/\s+/g, ' ')
async function withDev(name: string, line: string) {
  const fx = await fresh(name); devOverride.text = line
  const o = await runOnce(runStageA, fx); devOverride.text = null
  assert.equal(o.threw, null, String((o.threw as any)?.stack))
  return { fx, body: norm(allBodies(fx)) }
}
const rejects = async (name: string, line: string) => { const r = await withDev(name, line); assert.ok(!r.body.includes(norm(line)), `rejected dev line survived: ${line}`) }

await t('control: verbatim user-row dev line is kept in the ingested draft', async () => {
  const r = await withDev('dv-ok', DEV_LINE); assert.ok(r.body.includes(DEV_LINE), 'verbatim line missing: positive control failed (later rejects may be vacuous)')
})
await t('dev line not found in any user row is rejected', () => rejects('dv-fab', 'Nobody warned me compaction would be this painful'))
await t('dev line matching only an ASSISTANT row is rejected', () => rejects('dv-asst', ASSISTANT_LINE))
await t('dev piece under 12 chars is rejected (even though a substring of a user row)', () => rejects('dv-short', 'Great, the'.slice(0, 11)))
await t('ellipsis pieces covering <80% of the user row are rejected', () => rejects('dv-ell-low', 'We finally shipped … writer today'))
await t('ellipsis pieces covering >=80% of the user row are accepted (control)', async () => {
  const line = 'We finally shipped … period library writer today'
  const r = await withDev('dv-ell-ok', line); assert.ok(r.body.includes(norm(line)) || r.body.includes('We finally shipped'), 'high-coverage ellipsis line wrongly rejected')
})
await t('ASCII "..." ellipsis is treated like "…" (low coverage rejected)', () => rejects('dv-ell-ascii', 'We finally shipped ... writer today'))
await t('empty dev line: no throw', async () => { await withDev('dv-empty', '') })
done()
