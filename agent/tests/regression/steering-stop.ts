/**
 * Steering/stop source contracts (contract C, 0.9.253/0.9.254) — anchored
 * source-text checks for the pieces private state keeps out of behavioral
 * reach. Complements static-checks.ts (items 1/5/6) and behavior-registry.ts.
 *
 *   S1  sdkOptions object literal declares perTaskStopAffordance: true
 *   S2  turn end ('result' message) clears stale pending Task-dispatch ids
 *   S3  #resolveTaskId: pairing exists but task gone → null BEFORE the
 *       type fallback (no cross-agent retarget) — source-level twin of the
 *       behavioral check 2-B6c-hard
 *   S4  stopAgent is declared (agentId: string): Promise<boolean> and guards
 *       on the SDK actually exposing stopTask
 *   S5  index.ts stop_dispatch: statusManager row marked failed ONLY when
 *       stopped === true; agent_stopped carries runningTasks from
 *       getRunningTasks()
 *
 * Run: npx tsx agent/tests/regression/steering-stop.ts  (read-only, no HOME needed)
 */
import { check, finish, readSource, anchoredSlice, balancedBlock } from './_shared.js'

const llmSrc = readSource('agent/src/claude-llm.ts')
const indexSrc = readSource('agent/src/index.ts')

// ── S1: sdkOptions declares the flag ────────────────────────────────────────
{
  const declIdx = llmSrc.indexOf('const sdkOptions: Options = {')
  check('S1-pre', declIdx >= 0, 'sdkOptions: Options object literal exists')
  const obj = balancedBlock(llmSrc, declIdx)
  check('S1a', /perTaskStopAffordance:\s*true/.test(obj), 'sdkOptions sets perTaskStopAffordance: true')
  check('S1b', /enableFileCheckpointing:\s*true/.test(obj), 'sdkOptions still sets enableFileCheckpointing: true (rewind contract)')
}

// ── S2: stale dispatch ids cleared at turn end ──────────────────────────────
{
  const resultIdx = llmSrc.indexOf("if (msg.type === 'result') {")
  check('S2-pre', resultIdx >= 0, "background consumer has a msg.type === 'result' turn-end branch")
  const block = balancedBlock(llmSrc, llmSrc.indexOf('{', resultIdx + 3))
  check('S2a', block.includes('#pendingToolUseByType.clear()'),
    "turn end ('result') clears stale pending Task-dispatch ids (a denied/aborted dispatch can't poison the next pairing)")
}

// ── S3: terminal pairing never retargets (source twin of 2-B6c-hard) ────────
{
  // Anchor on the DECLARATION (typed param), not the call site inside stopAgent.
  const m = anchoredSlice(llmSrc, '#resolveTaskId(agentId: string)', { len: 1100 })
  const byToolUse = m.indexOf('this.#taskIdByToolUse.get(toolUse)')
  const earlyNull = m.indexOf('return null', byToolUse)
  const typeFallback = m.indexOf('this.#typeByAgentId.get(agentId)')
  check('S3a', byToolUse >= 0 && earlyNull >= 0 && typeFallback >= 0 && earlyNull < typeFallback,
    'pairing-exists-but-task-gone returns null BEFORE the subagent-type fallback (no cross-agent retarget)')
  check('S3b', m.includes("t.status === 'running' || t.status === 'pending'") && m.includes('candidates.length === 1'),
    'type fallback only resolves when exactly ONE running/pending task of the type exists')
}

// ── S4: stopAgent declaration + stopTask guard ──────────────────────────────
{
  check('S4a', llmSrc.includes('async stopAgent(agentId: string): Promise<boolean>'),
    'ClaudeLLM.stopAgent(agentId: string): Promise<boolean> signature kept')
  const m = anchoredSlice(llmSrc, 'async stopAgent(agentId: string)', { len: 1100 })
  check('S4b', m.includes("typeof this.#persistentQuery.stopTask !== 'function'"),
    'stopAgent guards on the SDK exposing stopTask (returns false instead of throwing on an older SDK)')
  check('S4c', m.includes('await this.#persistentQuery.stopTask(taskId)'), 'stopAgent issues a REAL query.stopTask(taskId)')
  check('S4d', /return false/.test(m.slice(m.indexOf('catch'))), 'a stopTask throw resolves false (truthful), never bubbles')
}

// ── S5: index.ts stop_dispatch truthfulness details ─────────────────────────
{
  const handler = anchoredSlice(indexSrc, "data.type === 'stop_dispatch'", { endAnchor: "type: 'agent_stopped'" })
  // statusManager failure-marking must live INSIDE if (stopped) { ... }
  const ifStopped = handler.indexOf('if (stopped)')
  check('S5-pre', ifStopped >= 0, 'stop_dispatch has an if (stopped) branch')
  const stoppedBlock = balancedBlock(handler, handler.indexOf('{', ifStopped))
  check('S5a', stoppedBlock.includes("dispatchState: 'failed'"),
    "statusManager row marked 'failed' inside if (stopped) …")
  const outside = handler.slice(0, ifStopped) + handler.slice(ifStopped + stoppedBlock.length)
  check('S5b', !outside.includes("dispatchState: 'failed'"),
    '… and NOWHERE else — an unmatched stop never pre-fails a live row')
  check('S5c', handler.includes('getRunningTasks'),
    'runningTasks computed from currentLLM.getRunningTasks() for the agent_stopped payload')
  const payload = anchoredSlice(indexSrc, "type: 'agent_stopped'", { len: 120 })
  check('S5d', /stopped\s*,/.test(payload) && /runningTasks/.test(payload),
    `agent_stopped payload carries { stopped, runningTasks }: ${payload.split('\n')[0]}`)
}

finish('steering-stop')
