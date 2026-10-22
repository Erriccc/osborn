/**
 * MEM probe v2 + graceful self-recycle contract (0.9.263).
 *
 * The recycle guard pre-empts the heap-OOM crash (11x since 2026-10-02) by
 * restarting the process BEFORE V8 hits its ceiling. The exit-code semantics
 * are safety-critical on Fly's on-failure restart policy:
 *   exit(0) → machine STOPS  (only allowed when idle — same shape as idle-exit)
 *   exit(1) → process RESTARTS (the mid-session emergency path)
 * Getting these backwards either bills an idle machine forever or strands a
 * live user on a stopped machine.
 *
 *   R1  guard is default-ON with an OSBORN_RECYCLE=off escape hatch
 *   R2  ceiling read from V8 (getHeapStatistics), not hardcoded
 *   R3  SOFT tier: exit(0) gated on safeToRecycle() (no user in room + voice
 *       quiet + no bg agents) — never fires mid-session
 *   R4  HARD tier: exit(1) (process restart, machine stays up) + frontend
 *       notice BEFORE the exit
 *   R5  local-dev guard: no FLY_APP_NAME → never self-exits
 *   R6  spike detection: ≥200MB delta between 15s samples → [MEM-SPIKE] line
 *   R7  probe can never break the agent (whole tick wrapped in try/catch)
 *   R8  consumer attribution (claude-llm.ts): per-message char tally with NO
 *       JSON.stringify (allocation-free measurement), surfaced via getMemDebug
 */
import { readSource, anchoredSlice, stripComments, check, finish } from './_shared.js'

const idx = stripComments(readSource('agent/src/index.ts'))
const llm = stripComments(readSource('agent/src/claude-llm.ts'))

// The whole probe block, from ceiling constant to the interval close.
const block = anchoredSlice(idx, 'const HEAP_LIMIT_MB', { endAnchor: "}, 15_000).unref()" })

// ── R1: default-ON + escape hatch ───────────────────────────────────────────
check('R1', /const RECYCLE_ON = process\.env\.OSBORN_RECYCLE !== 'off'/.test(block),
  'recycle guard default-ON with OSBORN_RECYCLE=off escape hatch')

// ── R2: ceiling from V8 ─────────────────────────────────────────────────────
check('R2', /getHeapStatistics\(\)\.heap_size_limit/.test(block),
  'heap ceiling read from V8 getHeapStatistics (tracks the launcher flag, not hardcoded)')

// ── R3: SOFT tier gated on idle, exits 0 ────────────────────────────────────
const softIdx = block.indexOf('RECYCLE_SOFT_MB && safeToRecycle()')
check('R3a', softIdx > 0, 'SOFT tier requires safeToRecycle() in the same condition')
const softBranch = block.slice(softIdx, softIdx + 500)
check('R3b', /process\.exit\(0\)/.test(softBranch) && !/process\.exit\(1\)/.test(softBranch),
  'SOFT tier exits 0 (machine stops like idle-exit) — never exit(1)')
const safeFn = anchoredSlice(idx, 'const safeToRecycle = ', { endAnchor: 'agentsActive()' })
check('R3c', /remoteParticipants\.size === 0/.test(safeFn) && /voiceQueue\.length === 0/.test(safeFn) && /userState !== 'speaking'/.test(safeFn),
  'safeToRecycle requires: no user in room + empty voice queue + user not speaking + no bg agents')

// ── R4: HARD tier exits 1 with frontend notice first ────────────────────────
const hardIdx = block.indexOf('usedMB >= RECYCLE_HARD_MB')
check('R4a', hardIdx > 0, 'HARD tier present')
const hardBranch = block.slice(hardIdx, block.indexOf('else if', hardIdx))
check('R4b', /process\.exit\(1\)/.test(hardBranch) && !/process\.exit\(0\)/.test(hardBranch),
  'HARD tier exits 1 (on-failure restart; machine stays up) — never exit(0)')
const noticeIdx = hardBranch.indexOf("type: 'agent_recycling'")
const exitIdx = hardBranch.indexOf('process.exit(1)')
check('R4c', noticeIdx > 0 && exitIdx > noticeIdx, 'frontend agent_recycling notice sent BEFORE exit(1)')

// ── R5: local-dev guard ─────────────────────────────────────────────────────
check('R5', /if \(!RECYCLE_ON \|\| !process\.env\.FLY_APP_NAME \|\| recycling\) return/.test(block),
  'no FLY_APP_NAME (local dev) → never self-exits; recycling latch prevents double-fire')

// ── R6: spike detection ─────────────────────────────────────────────────────
check('R6', /usedMB - memLastSampleMB >= 200/.test(block) && /MEM-SPIKE/.test(block),
  '≥200MB inter-sample delta logs an immediate [MEM-SPIKE] line')

// ── R7: probe is try/catch-wrapped ──────────────────────────────────────────
const tickIdx = block.indexOf('setInterval(() => {')
const tickHead = block.slice(tickIdx, tickIdx + 120)
check('R7', /setInterval\(\(\) => \{\s*try \{/.test(tickHead),
  'probe tick body opens with try { — a probe bug can never break the agent')

// ── R8: allocation-free consumer attribution ────────────────────────────────
const tap = anchoredSlice(llm, '#memMsgCount++', { len: 400 })
const tapCtx = anchoredSlice(llm, 'let chars = 0', { endAnchor: '#memLastMsg = {' })
check('R8a', !/JSON\.stringify/.test(tapCtx), 'consumer tap measures via text lengths, never JSON.stringify')
check('R8b', /charsSeenMB/.test(llm) && /maxMsgKB/.test(llm) && /lastMsg/.test(llm),
  'getMemDebug surfaces msg attribution (charsSeenMB / maxMsgKB / lastMsg)')
void tap

// ── R9: checkpoints array is capped (bounded-leak fix, 0.9.264) ─────────────
const cap = anchoredSlice(llm, 'captureCheckpoint(checkpointId: string)', { len: 900 })
check('R9a', /#checkpoints\.length > 600/.test(cap) && /splice\(1,/.test(cap),
  'captureCheckpoint caps the array (drop the middle, splice from index 1)')
check('R9b', /splice\(1/.test(cap) && !/splice\(0/.test(cap),
  'cap PRESERVES [0] — getFirstCheckpoint (rewind-to-session-start) must survive')

// ── R10: per-agent pairing released at SubagentStop, both maps together ─────
const rel = anchoredSlice(llm, 'releaseAgentTracking(agentId: string | undefined)', { len: 400 })
check('R10a', /#toolUseByAgentId\.delete\(agentId\)/.test(rel) && /#typeByAgentId\.delete\(agentId\)/.test(rel),
  'releaseAgentTracking deletes BOTH maps together (keeps stale-stop resolve at null — no retargeting)')
check('R10b', !/#dispatchedFor\.delete/.test(rel),
  'releaseAgentTracking does NOT touch #dispatchedFor (it is the SubagentStop double-fire dedup)')
const stopHook = anchoredSlice(llm, "SubagentStop: [{", { endAnchor: 'TaskCreated: [{' })
const relIdx = stopHook.indexOf('releaseAgentTracking')
const chainIdx = stopHook.indexOf('markChainDispatched')
check('R10c', relIdx > 0 && chainIdx > 0 && relIdx > chainIdx,
  'SubagentStop hook releases tracking AFTER the verifier-chain logic has run')

finish('mem-recycle')
