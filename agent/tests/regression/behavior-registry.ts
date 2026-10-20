/**
 * Behavioral regression tests — per-flow stop correlation chain (ClaudeLLM task
 * registry). Ported from /tmp/osborn-regression/behavior-registry.ts so it
 * survives reboots. All original checks kept; one hardened check added
 * (2-B6c-hard: a terminal pairing must never retarget another agent's task —
 * the "pairing exists but task gone → null" rule in #resolveTaskId).
 *
 * claude-llm.ts writes ~/.claude/settings.json at module load, so this suite
 * self-sandboxes $HOME BEFORE importing it (run-all.sh also sandboxes HOME).
 *
 * Run: npx tsx agent/tests/regression/behavior-registry.ts
 */
import { sandboxHome, captureLogs } from './_shared.js'

sandboxHome() // MUST precede the claude-llm import (module-load $HOME write)
const { ClaudeLLM } = await import('../../src/claude-llm.js')

let failures = 0
function check(id: string, cond: boolean, evidence: string) {
  if (cond) console.log(`PASS  ${id}: ${evidence}`)
  else { failures++; console.log(`FAIL  ${id}: ${evidence}`) }
}

const started = (task_id: string, tool_use_id: string | undefined, subagent_type: string, description = 'desc-' + task_id) =>
  ({ type: 'system', subtype: 'task_started', task_id, tool_use_id, subagent_type, description })
const updated = (task_id: string, status: string) =>
  ({ type: 'system', subtype: 'task_updated', task_id, patch: { status } })
const notified = (task_id: string, status: 'completed' | 'failed' | 'stopped') =>
  ({ type: 'system', subtype: 'task_notification', task_id, status })

async function main() {
  // B1 — constructs without a live session
  let llm: InstanceType<typeof ClaudeLLM>
  try {
    llm = new ClaudeLLM({})
    check('2-B1', true, 'new ClaudeLLM({}) constructs without a live session')
  } catch (e: any) {
    check('2-B1', false, `constructor threw: ${e?.message}`)
    process.exit(1)
  }

  // B2 — stopAgent with no persistent query: async, resolves false, never throws
  {
    const r = llm.stopAgent('nonexistent-agent')
    check('2-B2a', typeof (r as any)?.then === 'function', 'stopAgent returns a Promise')
    const { result, threw } = await captureLogs(() => r)
    check('2-B2b', threw === null && result === false, `no query → resolves false (got ${threw ? 'throw: ' + threw : result})`)
  }

  // B3 — FIFO correctness: first-dispatched pairs with first-started of same type
  {
    llm.noteTaskDispatch('tu-1', 'researcher')
    llm.noteTaskDispatch('tu-2', 'researcher')
    llm.claimTaskDispatch('agent-A', 'researcher')   // must claim tu-1 (oldest)
    llm.claimTaskDispatch('agent-B', 'researcher')   // must claim tu-2
    llm.trackTaskMessage(started('task-1', 'tu-1', 'researcher', 'first task'))
    llm.trackTaskMessage(started('task-2', 'tu-2', 'researcher', 'second task'))

    const a = await captureLogs(() => llm.stopAgent('agent-A'))
    const b = await captureLogs(() => llm.stopAgent('agent-B'))
    const aTask = a.logs.join('\n').match(/taskId=([\w-]+)/)?.[1]
    const bTask = b.logs.join('\n').match(/taskId=([\w-]+)/)?.[1]
    check('2-B3a', aTask === 'task-1', `agent-A resolves to first-dispatched task (resolved: ${aTask})`)
    check('2-B3b', bTask === 'task-2', `agent-B resolves to second-dispatched task (resolved: ${bTask})`)
    check('2-B3c', a.result === false && b.result === false, `without a live query stopAgent still returns false, never lies "stopped" (${a.result}, ${b.result})`)
  }

  // B4 — getRunningTasks shape + contents
  {
    const tasks = llm.getRunningTasks()
    const t1 = tasks.find(t => t.taskId === 'task-1')
    const t2 = tasks.find(t => t.taskId === 'task-2')
    check('2-B4a', tasks.length === 2 && !!t1 && !!t2, `both live tasks listed (${JSON.stringify(tasks.map(t => t.taskId))})`)
    check('2-B4b', t1?.subagentType === 'researcher' && t1?.description === 'first task' && t1?.status === 'running',
      `shape {taskId, subagentType, description, status}: ${JSON.stringify(t1)}`)
  }

  // B5 — task_updated status transitions reflect in getRunningTasks
  {
    llm.trackTaskMessage(updated('task-2', 'pending'))
    let tasks = llm.getRunningTasks()
    check('2-B5a', tasks.find(t => t.taskId === 'task-2')?.status === 'pending', 'patched to pending → still live with status pending')
    llm.trackTaskMessage(updated('task-2', 'backgrounded'))
    tasks = llm.getRunningTasks()
    const gone = !tasks.find(t => t.taskId === 'task-2')
    check('2-B5b', gone, `non-running/pending status excluded from live list (backgrounded hidden: ${gone}) [contract: only running/pending are live]`)
    llm.trackTaskMessage(updated('task-2', 'running'))  // restore
    check('2-B5c', !!llm.getRunningTasks().find(t => t.taskId === 'task-2'), 'patched back to running → live again')
  }

  // B6 — terminal task_notification removes task + unmaps tool_use
  {
    llm.trackTaskMessage(notified('task-1', 'completed'))
    const tasks = llm.getRunningTasks()
    check('2-B6a', !tasks.find(t => t.taskId === 'task-1'), 'task_notification(completed) removes task-1 from getRunningTasks')

    // Unmap check: agent-A's tool_use tu-1 must no longer resolve to task-1.
    const a = await captureLogs(() => llm.stopAgent('agent-A'))
    const aTask = a.logs.join('\n').match(/taskId=([\w-]+)/)?.[1]
    check('2-B6b', aTask !== 'task-1', `tu-1 unmapped — stopAgent(agent-A) no longer resolves task-1 (resolved: ${aTask})`)
    // ADVERSARIAL observation probe: does agent-A now FALL BACK to agent-B's live task-2?
    console.log(`OBS   2-B6c: after agent-A's task completed, stopAgent(agent-A) resolved taskId=${aTask} ` +
      (aTask === 'task-2' ? '← CROSS-AGENT RETARGET: would stop agent-B\'s task!' : '(no cross-agent retarget)'))
    // HARDENED (contract 0.9.254): pairing exists but task gone → null. A stop for
    // a finished agent must resolve NOTHING — never fall through to the type
    // fallback and stop agent-B's still-running task-2.
    check('2-B6c-hard', aTask === 'none' || aTask === undefined,
      `terminal pairing never retargets another agent's task (resolved: ${aTask})`)

    // Clean terminal state: notify task-2 too → nothing resolvable at all
    llm.trackTaskMessage(notified('task-2', 'stopped'))
    check('2-B6d', llm.getRunningTasks().length === 0, 'task_notification(stopped) empties the live registry')
    const b = await captureLogs(() => llm.stopAgent('agent-B'))
    const bTask = b.logs.join('\n').match(/taskId=([\w-]+)/)?.[1]
    check('2-B6e', bTask === 'none' || bTask === undefined, `all terminal → stopAgent resolves nothing (taskId=${bTask})`)
  }

  // B7 — fallback resolution: pairing missing but exactly ONE running task of the type
  {
    const llm2 = new ClaudeLLM({})
    llm2.claimTaskDispatch('agent-C', 'writer')              // no noteTaskDispatch → no tool_use pairing
    llm2.trackTaskMessage(started('task-3', 'tu-x', 'writer'))
    const c = await captureLogs(() => llm2.stopAgent('agent-C'))
    const cTask = c.logs.join('\n').match(/taskId=([\w-]+)/)?.[1]
    check('2-B7a', cTask === 'task-3', `fallback: single running writer resolves (taskId=${cTask}); returns ${c.result} without live query`)

    // B8 — ambiguous fallback (two running writers) must NOT resolve
    llm2.trackTaskMessage(started('task-4', 'tu-y', 'writer'))
    const c2 = await captureLogs(() => llm2.stopAgent('agent-C'))
    const c2Task = c2.logs.join('\n').match(/taskId=([\w-]+)/)?.[1]
    check('2-B8', c2Task === 'none' || c2Task === undefined, `two running writers → ambiguous, no resolution (taskId=${c2Task})`)
  }

  // B9 — robustness: junk inputs never throw
  {
    let threw: unknown = null
    try {
      llm.noteTaskDispatch(undefined, 'researcher')
      llm.noteTaskDispatch('tu-z', undefined)
      llm.claimTaskDispatch(undefined, undefined)
      llm.trackTaskMessage(null)
      llm.trackTaskMessage({})
      llm.trackTaskMessage({ type: 'assistant' })
      llm.trackTaskMessage({ type: 'system', subtype: 'task_updated', task_id: 'ghost', patch: undefined })
      llm.trackTaskMessage({ type: 'system', subtype: 'task_notification', task_id: 'ghost', status: 'completed' })
    } catch (e) { threw = e }
    check('2-B9a', threw === null, `junk/undefined inputs never throw (${threw ?? 'ok'})`)
    const { result, threw: t2 } = await captureLogs(() => llm.stopAgent(''))
    check('2-B9b', t2 === null && result === false, 'stopAgent(\'\') returns false, no throw')
  }

  // B10 — closeSession clears the task registry (per-process ids)
  {
    const llm3 = new ClaudeLLM({})
    llm3.noteTaskDispatch('tu-q', 'reviewer')
    llm3.claimTaskDispatch('agent-D', 'reviewer')
    llm3.trackTaskMessage(started('task-9', 'tu-q', 'reviewer'))
    const before = llm3.getRunningTasks().length
    await captureLogs(() => { llm3.closeSession(); return null })
    const after = llm3.getRunningTasks().length
    check('2-B10', before === 1 && after === 0, `closeSession clears registry (before=${before}, after=${after})`)
  }

  console.log(failures === 0 ? '\nALL BEHAVIORAL CHECKS PASSED' : `\n${failures} BEHAVIORAL CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error('SUITE CRASH:', e); process.exit(2) })
