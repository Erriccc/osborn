// The fast brain's default Fireworks model must be one the API serves, and a failed lookup must not reach the chat.
// npx tsx agent/tests/fastbrain-model-default.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const fb = read('../src/pipeline-fastbrain.ts')
assert.ok(fb.includes("(FIREWORKS ? 'accounts/fireworks/models/glm-5p3-flash' :"), 'the fast brain default model')
assert.ok(!/\(FIREWORKS \? 'accounts\/fireworks\/models\/gpt-oss-120b'/.test(fb), 'gpt-oss-120b returns 404 on Fireworks')
const mp = read('../../frontend/src/lib/model-provider.ts')
assert.ok(mp.includes("model: 'accounts/fireworks/models/glm-5p3-flash'") && !mp.includes("model: 'accounts/fireworks/models/gpt-oss-120b'"), 'the content routes use the same served model')
const idx = read('../src/index.ts')
const handler = idx.slice(idx.indexOf('const onPipelineFastBrainResult'), idx.indexOf('const onPipelineFastBrainResult') + 900)
assert.ok(handler.indexOf("r.type === 'error') return") > 0 && handler.indexOf("r.type === 'error') return") < handler.indexOf("type: 'fast_brain_response'"), 'an error result is not sent to the chat')
console.log('fastbrain-model-default: ok')
