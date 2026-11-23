// The fast brain's default Fireworks model is glm-5p3-flash (gpt-oss-120b returns 404), and a failed lookup does not reach the chat.
// npx tsx agent/tests/fastbrain-model-default.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const fb = read('../src/pipeline-fastbrain.ts')
assert.ok(fb.includes("(FIREWORKS ? 'accounts/fireworks/models/glm-5p3-flash' :"), 'the fast brain default model')
const idx = read('../src/index.ts')
const handler = idx.slice(idx.indexOf('const onPipelineFastBrainResult'), idx.indexOf('const onPipelineFastBrainResult') + 900)
assert.ok(handler.indexOf("r.type === 'error') {") > 0 && handler.indexOf("r.type === 'error') {") < handler.indexOf("type: 'fast_brain_response'"), 'an error result is not sent to the chat')
assert.ok(idx.includes('fastBrain: { errors: fastBrainErrors.count, lastErrorAt: fastBrainErrors.lastAt }'), '/health says how many fast-brain lookups failed, since they no longer reach the chat')
console.log('fastbrain-model-default: ok')
