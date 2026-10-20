/**
 * PipelineDirectLLM surface contract (contracts C + D) — pins the wrapper the
 * LiveKit voice pipeline depends on. NO prototype patching here: this suite
 * pins the real class shape (it never calls chat(), so no SDK subprocess).
 *
 *   PD1  constructs with empty options; label() = 'pipeline-direct'
 *   PD2  chat() is a SYNCHRONOUS function (not async) — the voice pipeline
 *        treats the return value as llm.LLMStream, not a Promise
 *   PD3  stopAgent passthrough: (agentId) => Promise<boolean>, resolves false
 *        with no live task — never lies "stopped"
 *   PD4  getRunningTasks passthrough returns the registry array
 *   PD5  suppressMeetingTTS exists and defaults to false
 *   PD6  agent-control surface for the fast brain: interruptAgent/abortAgent/
 *        hasActiveAgent/sendPrompt all present; hasActiveAgent() false at rest;
 *        interruptAgent() resolves false with no active query
 *
 * Run: npx tsx agent/tests/regression/pipeline-direct-contract.ts  (self-sandboxes HOME)
 */
import { check, finish, sandboxHome, captureLogs } from './_shared.js'

sandboxHome()
const { PipelineDirectLLM, createPipelineDirectLLM } = await import('../../src/pipeline-direct-llm.js')

// PD1
let pd: InstanceType<typeof PipelineDirectLLM>
try {
  pd = new PipelineDirectLLM({} as any)
  check('PD1a', true, 'new PipelineDirectLLM({}) constructs without a live session')
} catch (e: any) {
  check('PD1a', false, `constructor threw: ${e?.message}`)
  finish('pipeline-direct')
}
check('PD1b', pd.label() === 'pipeline-direct', `label() = ${pd.label()}`)
check('PD1c', typeof createPipelineDirectLLM === 'function' && createPipelineDirectLLM({} as any) instanceof PipelineDirectLLM,
  'createPipelineDirectLLM factory export kept')

// PD2 — chat is synchronous. An async method's runtime constructor is
// AsyncFunction; the voice pipeline would break the moment this flips.
{
  const chatFn = Object.getPrototypeOf(pd).chat
  check('PD2a', typeof chatFn === 'function', 'chat() exists on the prototype')
  check('PD2b', chatFn.constructor.name === 'Function',
    `chat() is a plain synchronous function (constructor=${chatFn.constructor.name} — 'AsyncFunction' would return a Promise to the voice pipeline)`)
}

// PD3 — stopAgent passthrough
{
  const r = pd.stopAgent('ghost-agent')
  check('PD3a', typeof (r as any)?.then === 'function', 'stopAgent(agentId) returns a Promise')
  const { result, threw } = await captureLogs(() => r)
  check('PD3b', threw === null && result === false,
    `no live task → resolves false, never lies "stopped" (got ${threw ?? result})`)
}

// PD4 — getRunningTasks passthrough
{
  const tasks = pd.getRunningTasks()
  check('PD4a', Array.isArray(tasks) && tasks.length === 0, `getRunningTasks() → [] at rest (got ${JSON.stringify(tasks)})`)
}

// PD5 — suppressMeetingTTS default
check('PD5a', pd.suppressMeetingTTS === false, 'suppressMeetingTTS exists and defaults to false')

// PD6 — agent-control surface used by index.ts + fast brain
{
  check('PD6a', typeof pd.interruptAgent === 'function' && typeof pd.abortAgent === 'function'
      && typeof pd.hasActiveAgent === 'function' && typeof pd.sendPrompt === 'function',
    'interruptAgent / abortAgent / hasActiveAgent / sendPrompt all present')
  check('PD6b', pd.hasActiveAgent() === false, 'hasActiveAgent() false at rest')
  const { result, threw } = await captureLogs(() => pd.interruptAgent())
  check('PD6c', threw === null && result === false, `interruptAgent() with no active query resolves false (got ${threw ?? result})`)
  // events/sessionId proxies the voice wiring depends on
  check('PD6d', typeof (pd as any).events?.on === 'function' && pd.sessionId === null,
    'events EventEmitter proxy + sessionId proxy (null before SDK assigns one)')
}

finish('pipeline-direct')
