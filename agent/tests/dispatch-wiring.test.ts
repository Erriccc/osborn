// Guards two things, with a stub query (no API call):
//  1. behaviour: a pipeline hub given `hubTools` hands the `dispatch` server to the SDK, and a ClaudeLLM given none (a slot) hands none
//     (this builds its own options, so it catches claude-llm.ts / pipeline-direct-llm.ts dropping hubTools);
//  2. wiring in index.ts, read as text: every createPipelineDirectLLM({...}) literal (exactly two: connect, recovery) passes
//     `hubTools`, and the slot's createClaudeLLM literal does not.
// Run: npx tsx agent/tests/dispatch-wiring.test.ts
import assert from 'node:assert/strict'
import { llm, initializeLogger } from '@livekit/agents'
import { createPipelineDirectLLM } from '../src/pipeline-direct-llm.js'
import { createClaudeLLM } from '../src/claude-llm.js'
import { dispatchServers } from '../src/dispatch-tool.js'

initializeLogger({ pretty: false, level: 'warn' })
const hubTools = dispatchServers(async () => 'ok')
const cwd = process.cwd()
const stub = (seen: { servers?: any; called?: boolean }) => ((args: any) => {
  seen.called = true
  seen.servers = args.options.mcpServers
  return { async *[Symbol.asyncIterator]() { await new Promise(() => {}) }, interrupt: async () => {}, close: () => {} } as any
})
async function coldStart(l: any, seen: { servers?: any; called?: boolean }) {
  const ctx = new llm.ChatContext(); ctx.addMessage({ role: 'user', content: 'hello there, what is up' })
  try { const s = l.chat({ chatCtx: ctx }); for await (const _ of s) {} } catch { /* the stub query never answers */ }
  for (let i = 0; i < 40 && !seen.called; i++) await new Promise((r) => setTimeout(r, 100))
}

const hub: { servers?: any; called?: boolean } = {}
await coldStart(createPipelineDirectLLM({ workingDirectory: cwd, voiceMode: 'direct', skipTTSQueue: true, mcpServers: {}, hubTools, queryFn: stub(hub) }), hub)
assert.ok(hub.called, 'the hub started a query')
assert.deepEqual(Object.keys(hub.servers || {}), ['dispatch'], 'the pipeline hub passes dispatch to the SDK')
assert.deepEqual(Object.keys(hub.servers.dispatch.instance._registeredTools), ['send'])

const slot: { servers?: any; called?: boolean } = {}
await coldStart(createClaudeLLM({ workingDirectory: cwd, voiceMode: 'direct', skipTTSQueue: true, permissionMode: 'bypassPermissions', queryFn: stub(slot) } as any), slot)
assert.ok(slot.called, 'the slot started a query')
assert.equal(slot.servers, undefined, 'a slot has no mcpServers at all')
import { readFileSync } from 'node:fs'
const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf-8')
const sites = [...idx.matchAll(/createPipelineDirectLLM\(\{/g)].map((m) => idx.slice(m.index!, m.index! + 700))
assert.equal(sites.length, 2, 'the hub is built in exactly two places: connect and recovery')
sites.forEach((s, i) => assert.match(s.slice(0, 400), /\n\s+hubTools,/, `createPipelineDirectLLM site ${i} passes hubTools`))
const slotLiteral = idx.slice(idx.indexOf('const bgLLM = createClaudeLLM('), idx.indexOf('const slot = slots.add('))
assert.ok(slotLiteral.length > 20 && !/hubTools|mcpServers/.test(slotLiteral), 'the slot is built without hubTools')
console.log('dispatch-wiring: ok')
process.exit(0)
