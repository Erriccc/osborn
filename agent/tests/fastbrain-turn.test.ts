// npx tsx agent/tests/fastbrain-turn.test.ts
// #547: an empty fast-brain reply is a hand-off (no "didn't find" card); a reply the model wrote stays an answer.
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY = 'or'
delete process.env.FIREWORKS_API_KEY
delete process.env.OSBORN_FAST_BRAIN_MODEL
delete process.env.OSBORN_DEMO_PASS
const fb = await import('../src/pipeline-fastbrain.js')

let reply = ''
globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }))) as typeof fetch
const ask = async (content: string) => { reply = content; return fb.askPipelineFastBrain(process.cwd(), 'sess-547', 'Cloud.') }

for (const empty of ['', '   ']) {
  const r = await ask(empty)
  assert.deepEqual([r.type, r.script], ['research_needed', ''], `empty reply ${JSON.stringify(empty)} hands off with no text`)
}
const real = await ask("I didn't find that in the session history.")
assert.equal(real.type, 'answer', 'a model-written not-found stays an answer')
console.log('fastbrain-turn ok')
