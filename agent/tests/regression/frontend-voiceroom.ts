/**
 * Frontend contract (contract E) — anchored source checks on
 * frontend/src/components/VoiceRoom.tsx.
 *
 *   V1  agent_stopped handler: stopped === false && runningTasks > 0 →
 *       KEEP/RESTORE the flow row (a spared runaway never becomes invisible
 *       and unstoppable); otherwise the row is cleared
 *   V2  stop-dispatch click: sends { type: 'stop_dispatch', agentId } reliably
 *       and still optimistically clears the row locally
 *
 * Run: npx tsx agent/tests/regression/frontend-voiceroom.ts  (read-only)
 */
import { check, finish, readSource, anchoredSlice } from './_shared.js'

const src = readSource('frontend/src/components/VoiceRoom.tsx')

// ── V1: agent_stopped handler ───────────────────────────────────────────────
{
  const handler = anchoredSlice(src, "data.type === 'agent_stopped'", { len: 1400 })
  check('V1a', handler.includes('data.stopped === false') && handler.includes('(data.runningTasks ?? 0) > 0'),
    'keep/restore condition is exactly stopped === false && (runningTasks ?? 0) > 0')

  const condIdx = handler.indexOf('data.stopped === false')
  const elseIdx = handler.indexOf('} else {', condIdx)
  check('V1-pre', condIdx >= 0 && elseIdx > condIdx, 'handler has keep branch + clear branch')
  const keepBranch = handler.slice(condIdx, elseIdx)
  const clearBranch = handler.slice(elseIdx, elseIdx + 450)

  check('V1b', keepBranch.includes('stop failed') && /status:\s*'running'/.test(keepBranch),
    "keep branch RESTORES a missing row as status 'running' with a 'stop failed' note")
  check('V1c', !/\.filter\(f => f\.agentId !== data\.agent_id\)/.test(keepBranch),
    'keep branch never filters the row out')
  check('V1d', /\.filter\(f => f\.agentId !== data\.agent_id\)/.test(clearBranch),
    'clear branch removes the row (stopped, or ghost with 0 running tasks)')
}

// ── V2: stop-dispatch click — optimistic clear kept ─────────────────────────
{
  const click = anchoredSlice(src, 'onStopDispatch={(agentId)', { len: 800 })
  check('V2a', click.includes("type: 'stop_dispatch', agentId") && click.includes('reliable: true'),
    'click sends { type: stop_dispatch, agentId } as a reliable data message')
  check('V2b', /setBackgroundFlows\(prev => prev\.filter\(f => f\.agentId !== agentId\)\)/.test(click),
    'click still optimistically clears the row (user can always dismiss a stuck row)')
}

finish('frontend-voiceroom')
