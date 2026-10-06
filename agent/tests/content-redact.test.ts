// Stage A redaction gate. BLIND; stubbed LLM/network. Plants a denylisted client + secret-shaped strings in the
// generated script and asserts none reach the ingest payload (or logs / files on disk).
// Run: npx tsx agent/tests/content-redact.test.ts
import { fresh, runOnce, allTreeText, t, done } from './_content-stage-a-harness.js'
import { pick, CLIENT, SECRETS } from './_content-fixture.js'

// ===== IMPORT ADAPTER (only place with guessed names) =====
const runMod: Record<string, any> = await import('../src/content/content-run.js')
const runStageA = pick(runMod, ['runContentStep', 'runContentPlanStep', 'runContentPipeline', 'runContentPipelineStep', 'runContentRun', 'runContent', 'runStageA'], 'Stage A entry (content-run.ts)')
const redMod: Record<string, any> = await import('../src/content/content-redact.js')
const makeScrubber = pick(redMod, ['makeScrubber', 'createScrubber', 'redactContent', 'scrubContent', 'redactText', 'scrubText', 'scrub', 'redact'], 'content-redact scrubber factory') // REMAP: actual export is makeScrubber(projectDir) -> { scrub(s), scrubDeep(v), isDirty(s) }
const redactText = (text: string, o: { projectDir: string }): string => makeScrubber(o.projectDir).scrub(text)
// ==========================================================

import assert from 'node:assert/strict'
const EXTRA = {
  fm2: 'fm2_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIj',
  snx: 'snx_0123456789abcdef0123456789abcdef',
  snxProj: 'snx_proj_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', // real Soniox key shape
}
const PLANTED: Record<string, string> = { client: CLIENT, clientLower: CLIENT.toLowerCase(), ...SECRETS, ...EXTRA }
// Distinctive cores (so partial survival e.g. "sk-or-v1-0123..." is also caught)
const NEEDLES = [CLIENT, CLIENT.toLowerCase(), 'Zorbotron', SECRETS.jwt, SECRETS.jwt.split('.')[1], SECRETS.fo1, EXTRA.fm2, EXTRA.snx, EXTRA.snxProj, 'fo1_AbCd', 'fm2_AbCd', 'snx_0123']
const leak = `Client ${CLIENT} (${CLIENT.toLowerCase()}) keys: ${Object.values(SECRETS).join(' ')} ${EXTRA.fm2} ${EXTRA.snx} ${EXTRA.snxProj}`
const survivors = (hay: string) => NEEDLES.filter(n => hay.toLowerCase().includes(n.toLowerCase()))

await t('no planted client name / secret survives into any script ingest payload (whole POST body)', async () => {
  const fx = await fresh('redact'); fx.scenario.leak = leak
  const o = await runOnce(runStageA, fx); assert.equal(o.threw, null)
  const bodies = fx.scenario.ingest.filter(i => i.payload?.source_kind !== 'library_page')
  const hay = bodies.map(b => b.body).join('\n')
  const sv = survivors(hay); assert.ok(sv.length === 0, 'leak reached ingest payload: ' + JSON.stringify(sv))
})
await t('control: leak planted reaches the LLM stub path (not a vacuous test) and run still completes', async () => {
  const fx = await fresh('redact-ctl'); fx.scenario.leak = leak
  const o = await runOnce(runStageA, fx); assert.equal(o.threw, null); assert.ok(fx.scenario.chat.length > 0, 'pipeline made no LLM calls')
})
await t('no planted secret / client name in logs or files persisted under the project dir', async () => {
  const fx = await fresh('redact-logs'); fx.scenario.leak = leak
  const o = await runOnce(runStageA, fx); assert.equal(o.threw, null)
  assert.deepEqual(survivors(o.logs.join('\n')), [], 'leak in logs')
  const lib = allTreeText(fx.libraryDir) // library pages are pre-redacted by the existing step; this also guards Stage A outputs next to them
  assert.deepEqual(survivors(allTreeText(fx.projectDir).replace(lib, '')).filter(n => !lib.includes(n)), [], 'leak persisted to disk')
})
await t('leak planted in every secret shape individually: none survive (per-shape)', async () => {
  for (const [k, v] of Object.entries(PLANTED)) {
    const fx = await fresh('redact-' + k.slice(0, 6)); fx.scenario.leak = `note ${v} end`
    const o = await runOnce(runStageA, fx); assert.equal(o.threw, null)
    const hay = fx.scenario.ingest.filter(i => i.payload?.source_kind !== 'library_page').map(b => b.body).join('\n')
    assert.ok(!hay.includes(v), `${k} survived into ingest payload`)
  }
})
await t('content-redact scrubber (adapter) removes secrets and the denylisted client', async () => {
  const fx = await fresh('redact-unit') // sets CLAUDE_CONFIG_DIR / denylist env
  let out: any = redactText(leak, { projectDir: fx.projectDir })
  if (typeof out === 'function') out = out(leak)
  if (out && typeof out.then === 'function') out = await out
  const s = typeof out === 'string' ? out : String(out?.text ?? out?.value ?? JSON.stringify(out))
  const sv = survivors(s); assert.ok(sv.length === 0, 'scrubber left: ' + JSON.stringify(sv))
})
done()
