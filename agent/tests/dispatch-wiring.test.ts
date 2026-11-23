// The hub built the way index.ts builds it (createPipelineDirectLLM with hubTools) hands the dispatch tool to the
// SDK query, and a slot built the way index.ts builds it does not. The query is a stub: no API call.
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
console.log('dispatch-wiring: ok')
process.exit(0)
