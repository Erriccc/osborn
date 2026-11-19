// Run: npx tsx agent/tests/phone-tool-deny.test.ts
// A phone call is talk-only (#361, until the per-call code in #362): while a
// phone caller holds the session the REAL PreToolUse hook (driven through
// chat() → run() → pushMessage against a fake SDK query) denies every tool,
// including the ones allowedTools auto-approves, sub-agent dispatch and MCP
// tools. With the flag off the hook behaves as before.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fakeHome = mkdtempSync(join(tmpdir(), 'osb-phone-tools-'))
process.env.HOME = fakeHome
process.env.CLAUDE_CONFIG_DIR = join(fakeHome, '.claude')

const { ClaudeLLM } = await import('../src/claude-llm.js')
const { PipelineDirectLLM } = await import('../src/pipeline-direct-llm.js')
const { PHONE_TOOLS_DENIED } = await import('../src/prompts.js')
const { PHONE_TOOLS_ENABLED } = await import('../src/data-sender-auth.js')
const { llm, initializeLogger } = await import('@livekit/agents')
initializeLogger({ pretty: false, level: 'warn' })

let pass = 0, fail = 0
async function t(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log('PASS', name) }
  catch (e: any) { fail++; console.log('FAIL', name, '-', String(e?.message).split('\n')[0].slice(0, 300)) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error('timeout waiting for condition'); await sleep(10) }
}

function makeFakeQueryFn() {
  const spawned: any[] = []
  const fn = ({ options }: { prompt: any; options: any }) => {
    const q: any = {
      options, closed: false,
      close() { q.closed = true },
      interrupt: async () => {},
      async *[Symbol.asyncIterator]() { while (!q.closed) await sleep(20) },
    }
    spawned.push(q)
    return q
  }
  return { fn, spawned }
}

function turn(l: any, text: string) {
  const ctx = new llm.ChatContext()
  ctx.addMessage({ role: 'user', content: text })
  const stream = l.chat({ chatCtx: ctx })
  ;(async () => { try { for await (const _ of stream) { /* drain */ } } catch { /* aborted */ } })()
}

/** The PreToolUse hook the SDK was handed for this LLM's session. */
async function preToolUseHook(l: any, fq: ReturnType<typeof makeFakeQueryFn>) {
  turn(l, 'hello')
  await until(() => fq.spawned.length > 0)
  const hook = fq.spawned[0].options?.hooks?.PreToolUse?.[0]?.hooks?.[0]
  assert.equal(typeof hook, 'function', 'PreToolUse hook passed to the SDK')
  return (tool_name: string, tool_input: Record<string, unknown> = {}, agent_type?: string) =>
    hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, agent_type, tool_use_id: `tu_${tool_name}` })
}

const TOOLS: [string, Record<string, unknown>, string?][] = [
  ['Bash', { command: 'cat ~/.env' }],
  ['WebFetch', { url: 'https://example.com', prompt: 'x' }],
  ['Read', { file_path: '/etc/passwd' }],
  ['Task', { subagent_type: 'researcher', description: 'dig', prompt: 'dig' }],
  ['Agent', { subagent_type: 'writer', description: 'w', prompt: 'w' }],
  ['mcp__github__create_issue', { title: 'x' }],
  ['Glob', { pattern: '**/*' }],
  ['Grep', { pattern: 'secret' }],
  ['WebSearch', { query: 'x' }],
  ['TodoWrite', { todos: [] }],
  // A sub-agent's own tool call goes through the same hook.
  ['Bash', { command: 'ls' }, 'researcher'],
]

const isDeny = (r: any) => r?.hookSpecificOutput?.permissionDecision === 'deny'

await t('phone tools are off by default', () => {
  assert.equal(PHONE_TOOLS_ENABLED, false)
})

await t('phone call ON: the hook denies Bash, WebFetch, Read, Task, Agent, an MCP tool and the rest, with the phone reason', async () => {
  const fq = makeFakeQueryFn()
  const l: any = new ClaudeLLM({ workingDirectory: fakeHome, voiceMode: 'direct', skipTTSQueue: true, queryFn: fq.fn as any })
  l.setPhoneCall(true)
  const call = await preToolUseHook(l, fq)
  for (const [name, input, agent] of TOOLS) {
    const r = await call(name, input, agent)
    assert.ok(isDeny(r), `${name}${agent ? ` (${agent})` : ''} must be denied, got ${JSON.stringify(r)}`)
    assert.equal(r.reason, PHONE_TOOLS_DENIED)
  }
  l.closeSession?.()
})

await t('phone call OFF: behaviour unchanged (none of these is denied)', async () => {
  const fq = makeFakeQueryFn()
  const l: any = new ClaudeLLM({ workingDirectory: fakeHome, voiceMode: 'direct', skipTTSQueue: true, queryFn: fq.fn as any })
  const call = await preToolUseHook(l, fq)
  for (const [name, input, agent] of TOOLS) {
    const r = await call(name, input, agent)
    assert.ok(!isDeny(r), `${name} must not be denied with the flag off, got ${JSON.stringify(r)}`)
  }
  l.closeSession?.()
})

await t('the flag is read at each tool call: clearing it mid-session lets tools through again', async () => {
  const fq = makeFakeQueryFn()
  const l: any = new ClaudeLLM({ workingDirectory: fakeHome, voiceMode: 'direct', skipTTSQueue: true, queryFn: fq.fn as any })
  l.setPhoneCall(true)
  const call = await preToolUseHook(l, fq)
  assert.ok(isDeny(await call('Read', { file_path: '/etc/hosts' })))
  l.setPhoneCall(false)
  assert.equal(l.phoneCall, false)
  assert.ok(!isDeny(await call('Read', { file_path: '/etc/hosts' })))
  l.closeSession?.()
})

await t('PipelineDirectLLM proxies setPhoneCall to its inner ClaudeLLM (pipeline mode is the voice default)', async () => {
  const fq = makeFakeQueryFn()
  const pd: any = new PipelineDirectLLM({ workingDirectory: fakeHome, voiceMode: 'direct', skipTTSQueue: true, queryFn: fq.fn as any })
  pd.setPhoneCall(true)
  assert.equal(pd.inner.phoneCall, true)
  const call = await preToolUseHook(pd.inner, fq)
  assert.ok(isDeny(await call('WebFetch', { url: 'https://example.com', prompt: 'x' })))
  pd.setPhoneCall(false)
  assert.equal(pd.inner.phoneCall, false)
  pd.inner.closeSession?.()
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
