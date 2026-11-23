// Guards two things, with a stub query (no API call):
//  1. behaviour: a pipeline hub given `hubTools` hands the `dispatch` server to the SDK, and a ClaudeLLM given none (a slot) hands none
//     (this builds its own options, so it catches claude-llm.ts / pipeline-direct-llm.ts dropping hubTools);
//  2. the real ClaudeLLM: the priority each kind of turn is pushed with (steering), and the real PreToolUse hook (the
//     dispatch tool is refused for a sub-agent, not for the hub);
//  3. wiring in index.ts, read as text: every createPipelineDirectLLM({...}) literal (exactly two: connect, recovery) passes
//     `hubTools`, and the slot's createClaudeLLM literal does not.
// Run: npx tsx agent/tests/dispatch-wiring.test.ts
import assert from 'node:assert/strict'
import { llm, initializeLogger } from '@livekit/agents'
import { createPipelineDirectLLM } from '../src/pipeline-direct-llm.js'
import { createClaudeLLM } from '../src/claude-llm.js'
import { dispatchServers } from '../src/dispatch-tool.js'
import { DISPATCH_TOOL } from '../src/dispatch.js'

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
// -- steering: a real ClaudeLLM with a stub query records the priority of each pushed message
{
  const pushed: any[] = []
  const queryFn = (args: any) => {
    ;(async () => { for await (const m of args.prompt) pushed.push(m) })()
    return { async *[Symbol.asyncIterator]() { await new Promise(() => {}) }, interrupt: async () => {}, close: () => {} } as any
  }
  const l: any = createClaudeLLM({ workingDirectory: cwd, voiceMode: 'direct', skipTTSQueue: true, queryFn } as any)
  const send = async (text: string) => {
    const c = new llm.ChatContext(); c.addMessage({ role: 'user', content: text })
    try { const s = l.chat({ chatCtx: c }); for await (const _ of s) {} } catch { /* stub */ }
    const before = pushed.length
    for (let i = 0; i < 30 && pushed.length === before; i++) await new Promise((r) => setTimeout(r, 100))
    return pushed[pushed.length - 1]?.priority
  }
  await send('hello there, start working on something long')
  const expect: Array<[string, string | undefined]> = [
    ['[SYSTEM note — the user enabled noise-cancellation mode. Do not read this aloud.]', undefined], ['[SYSTEM] plain note', undefined],
    ['[MEETING — bot1]:\nAlice: hi', undefined], ['[NOTIFICATION] Spoke report. Project: p.', undefined], ['now fix the login bug please', 'now'],
  ]
  for (const [text, want] of expect) assert.equal(await send(text), want, `priority of ${JSON.stringify(text.slice(0, 30))}`)
}
// -- the real PreToolUse hook
{
  const spawned: any[] = []
  const fn = ({ options }: any) => { const q: any = { options, closed: false, close() { q.closed = true }, interrupt: async () => {}, async *[Symbol.asyncIterator]() { while (!q.closed) await new Promise((r) => setTimeout(r, 20)) } }; spawned.push(q); return q }
  const l: any = createClaudeLLM({ workingDirectory: cwd, voiceMode: 'direct', skipTTSQueue: true, queryFn: fn } as any)
  const c = new llm.ChatContext(); c.addMessage({ role: 'user', content: 'hello' })
  const s = l.chat({ chatCtx: c }); void (async () => { try { for await (const _ of s) {} } catch { /* stub */ } })()
  for (let i = 0; i < 200 && !spawned.length; i++) await new Promise((r) => setTimeout(r, 20))
  const hook = spawned[0].options.hooks.PreToolUse[0].hooks[0]
  const call = (agent_type?: string, agent_id?: string) => hook({ hook_event_name: 'PreToolUse', tool_name: DISPATCH_TOOL, tool_input: { project: 'p', instruction: 'x' }, agent_type, agent_id, tool_use_id: 'tu1', session_id: 's', transcript_path: '/x', cwd: '/x' })
  const decision = (r: any) => r?.hookSpecificOutput?.permissionDecision
  assert.notEqual(decision(await call()), 'deny', 'the hub may dispatch')
  assert.equal(decision(await call('writer', 'a1')), 'deny', 'a writer sub-agent may not')
  assert.equal(decision(await call('general-purpose', 'a2')), 'deny', 'a general-purpose sub-agent may not')
  l.closeSession?.()
}
import { readFileSync } from 'node:fs'
const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf-8')
const sites = [...idx.matchAll(/createPipelineDirectLLM\(\{/g)].map((m) => idx.slice(m.index!, m.index! + 700))
assert.equal(sites.length, 2, 'the hub is built in exactly two places: connect and recovery')
sites.forEach((s, i) => assert.match(s.slice(0, 400), /\n\s+hubTools,/, `createPipelineDirectLLM site ${i} passes hubTools`))
const slotLiteral = idx.slice(idx.indexOf('const bgLLM = createClaudeLLM('), idx.indexOf('const slot = slots.add('))
assert.ok(slotLiteral.length > 20 && !/hubTools|mcpServers/.test(slotLiteral), 'the slot is built without hubTools')
const byName = idx.slice(idx.indexOf('async function dispatchByName'), idx.indexOf('const hubTools = dispatchServers'))
assert.ok(byName.indexOf('invalidateSessionListCache()') > 0 && byName.indexOf('invalidateSessionListCache()') < byName.indexOf('listAllClaudeSessions(1000)'), 'the session list is read fresh')
assert.match(idx.slice(idx.indexOf('async function dispatchToSlot'), idx.indexOf('function reportSlotWhenIdle')), /kickoffDone/, 'a cold slot answers its kickoff before the instruction is pushed')
const llmSrc = readFileSync(new URL('../src/claude-llm.ts', import.meta.url), 'utf-8')
assert.match(llmSrc, /mcpServers: this\.#opts\.hubTools\(\)/)
assert.match(llmSrc, /dispatchCallRefusal\(toolName, agentType\)/, 'the hook refuses sub-agents')
assert.doesNotMatch(llmSrc, /mcp__dispatch/, 'the tool is not in allowedTools')
console.log('dispatch-wiring: ok')
process.exit(0)
