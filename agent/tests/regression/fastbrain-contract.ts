/**
 * Fast-brain behavioral contract (contract A) — pins pipeline-fastbrain.ts
 * BEFORE the noise-gate feature touches this path.
 *
 * Runs askPipelineFastBrain against a STUBBED global fetch (no network, no
 * OpenRouter) and a spy agentControl, pinning:
 *   FB1  input guards: sessionId 'pending' / missing OPENROUTER_API_KEY
 *   FB2  tool set WITHOUT agentControl = exactly [search_session, get_recent]
 *   FB3  tool set WITH agentControl adds emergency_stop (required: ['reason'])
 *   FB4  emergency_stop semantics: awaits agentControl.interrupt() (never abort),
 *        THEN sends a redirect prompt via sendPrompt ([EMERGENCY STOP] + reason +
 *        recent user messages); tool result names "background sub-agents unaffected";
 *        emergency_stop is NOT counted in toolsUsed
 *   FB5  [RESEARCH_NEEDED] marker → type 'research_needed', marker stripped
 *   FB6  result shape { script, type, toolsUsed }
 *
 * Run: npx tsx agent/tests/regression/fastbrain-contract.ts  (self-sandboxes HOME)
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, finish, sandboxHome, sleep } from './_shared.js'

sandboxHome()
// Module-level consts read env at import time — pin the default model path.
delete process.env.OSBORN_FAST_BRAIN_MODEL
delete process.env.OPENROUTER_API_KEY
const fb = await import('../../src/pipeline-fastbrain.js')

const workingDir = mkdtempSync(join(tmpdir(), 'osborn-regress-fb-'))

// ── fetch stub ──────────────────────────────────────────────────────────────
type CapturedCall = { url: string; body: any }
const captured: CapturedCall[] = []
let responseQueue: any[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: any, init: any) => {
  captured.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') })
  const next = responseQueue.shift()
  if (!next) throw new Error('regression fetch stub: response queue empty')
  return { ok: true, status: 200, json: async () => next, text: async () => '' } as any
}) as any

const assistantText = (content: string) =>
  ({ choices: [{ message: { role: 'assistant', content } }] })
const toolCall = (name: string, args: any) =>
  ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
    { id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } },
  ] } }] })

const toolNames = (body: any): string[] => (body?.tools ?? []).map((t: any) => t?.function?.name)

try {
  // ── FB1: guards ───────────────────────────────────────────────────────────
  {
    const pending = await fb.askPipelineFastBrain(workingDir, 'pending', 'anything')
    check('FB1a', pending.script === 'Session is still initializing.' && pending.type === 'acknowledgment',
      `sessionId 'pending' → acknowledgment "${pending.script}"`)
    const noKey = await fb.askPipelineFastBrain(workingDir, 'sess-guard', 'anything')
    check('FB1b', noKey.script === 'Search system not available right now.' && noKey.type === 'acknowledgment'
        && Array.isArray(noKey.toolsUsed) && noKey.toolsUsed.length === 0,
      `missing OPENROUTER_API_KEY → acknowledgment "${noKey.script}" (no fetch attempted: ${captured.length === 0})`)
    check('FB1c', captured.length === 0, 'guards short-circuit before any network call')
  }

  process.env.OPENROUTER_API_KEY = 'test-key-regression'

  // ── FB2: tool set WITHOUT agentControl ───────────────────────────────────
  {
    fb.clearPipelineFastBrainSession()
    responseQueue = [assistantText('hi there')]
    const r = await fb.askPipelineFastBrain(workingDir, 'sess-tools-off', 'hello')
    const names = toolNames(captured.at(-1)?.body)
    check('FB2a', JSON.stringify(names) === JSON.stringify(['search_session', 'get_recent']),
      `no agentControl → tools exactly [search_session, get_recent] (got ${JSON.stringify(names)})`)
    check('FB2b', captured.at(-1)?.body?.model === 'deepseek/deepseek-chat',
      `default model pinned: ${captured.at(-1)?.body?.model}`)
    check('FB6a', r.script === 'hi there' && r.type === 'answer' && Array.isArray(r.toolsUsed),
      `result shape { script, type, toolsUsed }: ${JSON.stringify(r)}`)
  }

  // ── FB3: tool set WITH agentControl ──────────────────────────────────────
  const makeControl = () => {
    const events: string[] = []
    const control: import('../../src/pipeline-fastbrain.js').AgentControlCallbacks = {
      interrupt: async () => { events.push('interrupt:start'); await sleep(15); events.push('interrupt:resolved'); return true },
      abort: () => { events.push('abort') },
      hasActiveAgent: () => true,
      getRecentUserMessages: (count: number) => { events.push(`getRecent:${count}`); return ['stop that', 'no wait'] },
      sendPrompt: (prompt: string) => { events.push('sendPrompt'); prompts.push(prompt) },
    }
    const prompts: string[] = []
    return { control, events, prompts }
  }

  {
    fb.clearPipelineFastBrainSession()
    responseQueue = [assistantText('ok')]
    const { control } = makeControl()
    await fb.askPipelineFastBrain(workingDir, 'sess-tools-on', 'hello again', { agentControl: control })
    const body = captured.at(-1)?.body
    const names = toolNames(body)
    check('FB3a', JSON.stringify(names) === JSON.stringify(['search_session', 'get_recent', 'emergency_stop']),
      `agentControl present → emergency_stop added (got ${JSON.stringify(names)})`)
    const estop = (body?.tools ?? []).find((t: any) => t?.function?.name === 'emergency_stop')?.function
    check('FB3b', JSON.stringify(estop?.parameters?.required) === JSON.stringify(['reason']),
      `emergency_stop requires ['reason'] (got ${JSON.stringify(estop?.parameters?.required)})`)
  }

  // ── FB4: emergency_stop semantics ────────────────────────────────────────
  {
    fb.clearPipelineFastBrainSession()
    responseQueue = [
      toolCall('emergency_stop', { reason: 'stop the deploy' }),
      assistantText('Stopped and awaiting direction.'),
    ]
    const { control, events, prompts } = makeControl()
    const r = await fb.askPipelineFastBrain(workingDir, 'sess-estop', 'no no no stop', { agentControl: control })

    check('FB4a', events.filter(e => e === 'interrupt:start').length === 1, `interrupt() called exactly once (${JSON.stringify(events)})`)
    check('FB4b', !events.includes('abort'), 'abort() NEVER called by emergency_stop')
    const iResolved = events.indexOf('interrupt:resolved')
    const iSend = events.indexOf('sendPrompt')
    check('FB4c', iResolved >= 0 && iSend > iResolved,
      `interrupt() is AWAITED before sendPrompt (order: ${JSON.stringify(events)})`)
    check('FB4d', events.includes('getRecent:10'), 'getRecentUserMessages(10) consulted for the redirect prompt')

    const prompt = prompts[0] ?? ''
    check('FB4e', prompt.startsWith('[EMERGENCY STOP]'), 'redirect prompt starts with [EMERGENCY STOP]')
    check('FB4f', prompt.includes('stop the deploy') && prompt.includes('stop that') && prompt.includes('no wait'),
      'redirect prompt carries the reason + recent user messages')

    // The tool result fed back to the model must claim interrupt-only semantics.
    const round2 = captured.at(-1)?.body
    const toolMsg = (round2?.messages ?? []).find((m: any) => m.role === 'tool')
    check('FB4g', typeof toolMsg?.content === 'string'
        && toolMsg.content.includes('interrupted and redirected (background sub-agents unaffected)'),
      `tool result names interrupt-only semantics: "${String(toolMsg?.content).slice(0, 90)}"`)

    check('FB4h', !r.toolsUsed.includes('emergency_stop'),
      `emergency_stop not counted in toolsUsed (got ${JSON.stringify(r.toolsUsed)})`)
    check('FB4i', r.script === 'Stopped and awaiting direction.' && r.type === 'answer',
      `loop continues to the follow-up answer: "${r.script}"`)
  }

  // ── FB5: [RESEARCH_NEEDED] mapping ───────────────────────────────────────
  {
    fb.clearPipelineFastBrainSession()
    responseQueue = [assistantText('This needs live code analysis [RESEARCH_NEEDED]')]
    const r = await fb.askPipelineFastBrain(workingDir, 'sess-research', 'refactor the auth layer')
    check('FB5a', r.type === 'research_needed', `marker → type research_needed (got ${r.type})`)
    check('FB5b', !r.script.includes('[RESEARCH_NEEDED]') && r.script.includes('live code analysis'),
      `marker stripped from script: "${r.script}"`)
  }
} finally {
  globalThis.fetch = realFetch
}

finish('fastbrain-contract')
