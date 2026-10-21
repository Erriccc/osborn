/**
 * Click-time overlap contract (sub-second first-answer, 0.9.258).
 *
 * Eager-prime the resume so the JSONL replay overlaps the connect handshake
 * instead of being paid serially on the user's first message. The safety-
 * critical invariant: a PRIME must NEVER push a user message (no spurious turn/
 * output) and must reuse the EXACT turn sdkOptions (so the primed subprocess IS
 * the session's — zero drift).
 *
 *   C1  default-ON with an `=off` escape hatch (OSBORN_CONNECT_OVERLAP).
 *   C2  primeResume: no double-spawn guard; starts the query with an EMPTY
 *       MessageChannel (no push); registers + starts the background consumer.
 *   C3  prewarmResume: guards (nothing-to-resume / already-live) then drives the
 *       prime via chat({ primeOnly: true }) — reusing run()'s sdkOptions.
 *   C4  THE NO-PUSH INVARIANT — in run()'s skipTTSQueue branch, the primeOnly
 *       diversion calls primeResume and `return`s BEFORE the pushMessage call,
 *       so a prime can never deliver a turn to the model.
 *   C5  single-source: the diversion passes the SAME `sdkOptions` local the
 *       pushMessage path uses (no second construction → no drift).
 *   C6  index.ts integration gated on CONNECT_OVERLAP && resumeSessionId &&
 *       !reattached (skip when re-attaching — it already holds a live brain).
 *   C7  pipeline proxy: PipelineDirectLLM.prewarmResume delegates to the inner LLM.
 */
import { readSource, anchoredSlice, stripComments, check, finish } from './_shared.js'

const llmSrc = stripComments(readSource('agent/src/claude-llm.ts'))
const idxSrc = stripComments(readSource('agent/src/index.ts'))
const pipeSrc = stripComments(readSource('agent/src/pipeline-direct-llm.ts'))

// ── C1: default-ON with an `=off` escape hatch ──────────────────────────────
check('C1', /const CONNECT_OVERLAP = process\.env\.OSBORN_CONNECT_OVERLAP !== 'off'/.test(idxSrc),
  'CONNECT_OVERLAP defaults ON with an OSBORN_CONNECT_OVERLAP=off kill switch')

// ── C2: primeResume shape ───────────────────────────────────────────────────
const prime = anchoredSlice(llmSrc, 'primeResume(', { endAnchor: '#startBackgroundConsumer(callbacks)' })
check('C2a', /if \(this\.#persistentQuery\)\s*\{[\s\S]*?return/.test(prime),
  'primeResume no-ops if a persistent query already exists (no double-spawn)')
check('C2b', /this\.#messageChannel = new MessageChannel/.test(prime) && !/\.push\(/.test(prime),
  'primeResume starts an EMPTY channel and never pushes a message')
check('C2c', /this\.#persistentQuery = query\(\{ prompt: this\.#messageChannel/.test(prime)
  && /this\.#activeQueries\.add\(this\.#persistentQuery\)/.test(prime)
  && /this\.#startBackgroundConsumer\(callbacks\)/.test(prime),
  'primeResume wires query + activeQueries + background consumer (reclaimable on teardown)')

// ── C3: prewarmResume guards + drives via chat(primeOnly) ───────────────────
const prewarm = anchoredSlice(llmSrc, 'prewarmResume(', { endAnchor: 'primeOnly: true })' })
check('C3a', /if \(!this\.#opts\.resumeSessionId && !this\.#sessionId\)[\s\S]*?return/.test(prewarm),
  'prewarmResume no-ops when there is nothing to resume')
check('C3b', /if \(this\.#persistentQuery\)[\s\S]*?return/.test(prewarm),
  'prewarmResume no-ops when a query is already live')
check('C3c', /this\.chat\(\{ chatCtx: new llm\.ChatContext\(\), primeOnly: true \}\)/.test(prewarm),
  'prewarmResume drives the prime through chat({ primeOnly: true }) — reuses run() sdkOptions')

// ── C4: THE NO-PUSH INVARIANT (prime returns before pushMessage) ────────────
// Slice the skipTTSQueue branch and prove the primeOnly diversion's return
// precedes the pushMessage call textually.
const skipBranch = anchoredSlice(llmSrc, 'if (this.#opts.skipTTSQueue)', { len: 2000 })
const primeDivertIdx = skipBranch.indexOf('if (this.#primeOnly)')
const primeResumeCallIdx = skipBranch.indexOf('this.#llmRef.primeResume(')
const pushIdx = skipBranch.indexOf('this.#llmRef.pushMessage(')
check('C4a', primeDivertIdx > 0 && primeResumeCallIdx > primeDivertIdx && pushIdx > primeResumeCallIdx,
  'skipTTSQueue branch: primeOnly diversion → primeResume appears BEFORE pushMessage')
// The diversion block must contain a `return` between primeResume and pushMessage.
const betweenDivertAndPush = skipBranch.slice(primeResumeCallIdx, pushIdx)
check('C4b', /\n\s*return\n/.test(betweenDivertAndPush) || /\}\s*\n\s*const steerNow/.test(betweenDivertAndPush),
  'primeOnly diversion RETURNS before reaching pushMessage (no turn pushed in prime mode)')

// ── C5: single-source sdkOptions ────────────────────────────────────────────
check('C5', /this\.#llmRef\.primeResume\(sdkOptions,/.test(llmSrc),
  'prime diversion passes the SAME `sdkOptions` local as the pushMessage path (no drift)')

// ── C6: index integration gating ────────────────────────────────────────────
const idxCall = anchoredSlice(idxSrc, 'if (CONNECT_OVERLAP && resumeSessionId && !reattached)', { len: 300 })
check('C6', /prewarmResume\?\.\(\)/.test(idxCall),
  'index calls prewarmResume only when CONNECT_OVERLAP && resumeSessionId && !reattached')

// ── C7: pipeline proxy ──────────────────────────────────────────────────────
check('C7', /prewarmResume\(\)\s*\{\s*this\.#claudeLLM\.prewarmResume\(\)\s*\}/.test(pipeSrc),
  'PipelineDirectLLM.prewarmResume delegates to the inner ClaudeLLM')

finish('connect-overlap')
