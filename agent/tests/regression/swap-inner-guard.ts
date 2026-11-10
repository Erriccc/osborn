/**
 * Swap port step 1 — inner-guard contract for PipelineDirectLLM / ClaudeLLM.
 * Nothing calls swapInner() yet; these pin the guards so a later step can wire it.
 *
 *   SW1  inner / swapInner / setWorkingContext / hasSession surface exists;
 *        swapInner returns the previous inner and `inner` reports the new one
 *   SW2  swapInner aborts the in-flight fast-brain turn: with the same setup a
 *        turn that is NOT swapped reports onFastBrainResult, a swapped one does not
 *   SW3  stale agentControl closures are no-ops after the inner is swapped
 *        (and after the turn signal aborts); fresh closures still reach the inner
 *   SW4  consumer finally only clears #persistentQuery/#messageChannel/
 *        #backgroundConsumerRunning when this.#persistentQuery === pq
 *        (source-anchored: driving the real consumer needs an SDK subprocess)
 *
 * Run: npx tsx agent/tests/regression/swap-inner-guard.ts  (self-sandboxes HOME)
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, finish, sandboxHome, sleep, readSource, anchoredSlice, stripComments } from './_shared.js'

sandboxHome()
// Fast brain returns instantly without a provider key → observable via onFastBrainResult.
delete process.env.OPENROUTER_API_KEY
delete process.env.FIREWORKS_API_KEY
const { ClaudeLLM } = await import('../../src/claude-llm.js')
const { PipelineDirectLLM, buildGuardedAgentControl } = await import('../../src/pipeline-direct-llm.js')
const { llm } = await import('@livekit/agents')

// Never spawn the SDK subprocess.
const SENTINEL_STREAM = { __regressionSentinel: true } as any
;(ClaudeLLM as any).prototype.chat = function () { return SENTINEL_STREAM }

const workingDir = mkdtempSync(join(tmpdir(), 'osborn-regress-swap-'))
const makeCtx = (text: string) => {
  const ctx = new llm.ChatContext()
  ctx.addMessage({ role: 'user', content: text })
  return ctx
}

// ── SW1 surface ──────────────────────────────────────────────────────────────
{
  const pd = new PipelineDirectLLM({ workingDirectory: workingDir } as any)
  const a = pd.inner
  const b = new ClaudeLLM({ workingDirectory: workingDir } as any)
  check('SW1a', a instanceof ClaudeLLM, 'inner getter returns the wrapped ClaudeLLM')
  check('SW1b', pd.hasSession() === false, 'hasSession() proxies to inner (false at rest)')
  const prev = pd.swapInner(b)
  check('SW1c', prev === a && pd.inner === b, 'swapInner returns the previous inner; inner reports the new one')
  check('SW1d', pd.events === b.events, 'events proxy follows the swapped inner')
  let threw: unknown = null
  try { pd.setWorkingContext({ workingDirectory: workingDir }) } catch (e) { threw = e }
  check('SW1e', threw === null, 'setWorkingContext({workingDirectory}) accepted')
}

// ── SW2 swapInner aborts the prior turn ──────────────────────────────────────
// The fast brain waits for session_id on the inner the turn started on; we release
// it by emitting on that (old) inner. A live turn then reports a result; an aborted
// one returns before onFastBrainResult.
async function runTurn(swap: boolean): Promise<number> {
  let results = 0
  const pd = new PipelineDirectLLM({
    workingDirectory: workingDir,
    onFastBrainResult: () => { results++ },
  } as any)
  const oldInner = pd.inner
  pd.chat({ chatCtx: makeCtx(swap ? 'swapped turn question' : 'control turn question') })
  await sleep(20)
  if (swap) pd.swapInner(new ClaudeLLM({ workingDirectory: workingDir } as any))
  oldInner.events.emit('session_id', { sessionId: '00000000-0000-0000-0000-000000000000' })
  await sleep(300)
  return results
}
{
  const control = await runTurn(false)
  check('SW2a', control === 1, `control: unswapped turn reports onFastBrainResult (got ${control})`)
  const swapped = await runTurn(true)
  check('SW2b', swapped === 0, `swapInner aborted the in-flight turn → no onFastBrainResult (got ${swapped})`)
}

// ── SW3 stale closures are no-ops ────────────────────────────────────────────
function fakeInner() {
  const calls = { interrupt: 0, abort: 0, chat: 0, hasActive: 0 }
  const inner: any = {
    events: new EventEmitter(),
    interruptQuery: async () => { calls.interrupt++; return true },
    abortQuery: () => { calls.abort++ },
    hasActiveQuery: () => { calls.hasActive++; return true },
    chat: () => { calls.chat++; return SENTINEL_STREAM },
  }
  return { inner, calls }
}
const history = () => [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]
{
  // Fresh turn: callbacks reach the inner.
  const A = fakeInner()
  let current: any = A.inner
  const ac = new AbortController()
  const ctl = buildGuardedAgentControl({ inner: A.inner, signal: ac.signal, getCurrentInner: () => current, getChatHistory: history })
  const r = await ctl.interrupt()
  ctl.abort(); ctl.sendPrompt('p')
  check('SW3a', r === true && A.calls.interrupt === 1 && A.calls.abort === 1 && A.calls.chat === 1
    && ctl.hasActiveAgent() === true && ctl.getRecentUserMessages(5).length === 1,
    `live turn: all callbacks reach the bound inner (${JSON.stringify(A.calls)})`)

  // Swap (identity changes, signal NOT aborted) → stale.
  const B = fakeInner()
  current = B.inner
  const r2 = await ctl.interrupt()
  ctl.abort(); ctl.sendPrompt('p2')
  const active = ctl.hasActiveAgent()
  const recent = ctl.getRecentUserMessages(5)
  check('SW3b', r2 === false && active === false && recent.length === 0
    && A.calls.interrupt === 1 && A.calls.abort === 1 && A.calls.chat === 1,
    `after inner swap: stale closures are no-ops on the old inner (${JSON.stringify(A.calls)})`)
  check('SW3c', B.calls.interrupt === 0 && B.calls.abort === 0 && B.calls.chat === 0 && B.calls.hasActive === 0,
    `after inner swap: nothing reaches the new inner (${JSON.stringify(B.calls)})`)
}
{
  // Aborted signal alone (same inner) → stale.
  const A = fakeInner()
  const ac = new AbortController()
  const ctl = buildGuardedAgentControl({ inner: A.inner, signal: ac.signal, getCurrentInner: () => A.inner, getChatHistory: history })
  ac.abort()
  await ctl.interrupt(); ctl.abort(); ctl.sendPrompt('p')
  check('SW3d', A.calls.interrupt === 0 && A.calls.abort === 0 && A.calls.chat === 0,
    `after turn abort: closures are no-ops (${JSON.stringify(A.calls)})`)
}
{
  // Real wrapper: a control bound before swapInner goes stale after it.
  const pd = new PipelineDirectLLM({ workingDirectory: workingDir } as any)
  const A = fakeInner()
  pd.swapInner(A.inner)
  const ac = new AbortController()
  const ctl = buildGuardedAgentControl({ inner: A.inner, signal: ac.signal, getCurrentInner: () => pd.inner, getChatHistory: history })
  pd.swapInner(fakeInner().inner)
  ctl.sendPrompt('p'); await ctl.interrupt()
  check('SW3e', A.calls.chat === 0 && A.calls.interrupt === 0,
    'control bound to a pre-swap inner is a no-op after PipelineDirectLLM.swapInner')
}

// ── SW4 consumer finally ownership guard (source-anchored) ───────────────────
{
  const src = stripComments(readSource('agent/src/claude-llm.ts'))
  const consumer = anchoredSlice(src, 'async #startBackgroundConsumer(', { endAnchor: 'consumer exited' })
  const fin = consumer.slice(consumer.lastIndexOf('} finally {'))
  check('SW4a', /const pq = this\.#persistentQuery!?/.test(consumer), 'consumer captures the query it owns as pq')
  const guardIdx = fin.indexOf('if (this.#persistentQuery === pq)')
  check('SW4b', guardIdx > 0, 'finally gates teardown on this.#persistentQuery === pq')
  const guarded = guardIdx > 0 ? fin.slice(guardIdx) : ''
  const pre = guardIdx > 0 ? fin.slice(0, guardIdx) : fin
  for (const f of ['#persistentQuery = null', '#messageChannel = null', '#backgroundConsumerRunning = false']) {
    check(`SW4c ${f}`, guarded.includes(f) && !pre.includes(f), `\`${f}\` only inside the ownership guard`)
  }
}

finish('swap-inner-guard')
