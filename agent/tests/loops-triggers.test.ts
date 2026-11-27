// Follow-through (#378): every trigger reaches the flush, and the capture hooks are wired.
// Source-anchored (like tests/regression/mem-recycle.ts) plus one real detached spawn.
// Run: npx tsx agent/tests/loops-triggers.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = (f: string) => readFileSync(join(here, '..', 'src', f), 'utf-8')
const idx = src('index.ts')
const llm = src('claude-llm.ts')
const launch = src('content/lens-launch.ts')

let pass = 0
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) }
  catch (e: any) { console.log('FAIL ', name, '\n     ', String(e?.message ?? e).split('\n')[0]); process.exitCode = 1 }
}
/** The body of a function/arrow from its anchor to the next anchor. */
const slice = (s: string, from: string, to: string) => {
  const a = s.indexOf(from)
  assert.ok(a >= 0, `anchor not found: ${from}`)
  const b = s.indexOf(to, a + from.length)
  return s.slice(a, b < 0 ? undefined : b)
}

await t('launchLibraryOnSessionEnd launches the loops flush first, before the lens lock', () => {
  const body = slice(launch, 'export function launchLibraryOnSessionEnd(', '\n}\n')
  const flush = body.indexOf('launchLoopsFlush(')
  const lens = body.indexOf('launchCompactionLens(')
  assert.ok(flush > 0 && lens > 0 && flush < lens, 'flush must come before launchCompactionLens')
})

await t('killWarm path (grace and keep_working_cap) reaches the flush', () => {
  const kill = slice(idx, 'const killWarm = (reason: string): void => {', '\n  }\n')
  assert.match(kill, /launchLibraryOnSessionEnd\(warmSessionId/)
  assert.match(slice(idx, 'const freeWarm = (reason: string): void => {', '\n  }\n'), /killWarm\(reason\)/)
  assert.match(idx, /freeWarm\('keep_working_cap'\)/)
})

await t('soft recycle calls the flush before exit', () => {
  assert.match(idx, /flushLastSessionThenExit\('mem_soft', 0, 1500\)/)
  assert.doesNotMatch(idx, /setTimeout\(\(\) => process\.exit\(0\), 1500\)/)
  // Both paths flush now: the in-process flush here, and bin/cli.js onAbnormalExit --last where
  // `exec osborn` runs through cli.js (cli-signals.test.ts). The per-session lock and filed records
  // serialize them. agent/Dockerfile runs src/index.ts with no cli.js wrapper, so there the
  // in-process flush is the only one.
  assert.match(idx, /flushLastSessionThenExit\('mem_hard', 1, 1500, 3000\)/)
  const hard = slice(idx, 'usedMB >= RECYCLE_HARD_MB', 'else if')
  assert.ok(hard.indexOf("type: 'agent_recycling'") > 0 && hard.indexOf("type: 'agent_recycling'") < hard.indexOf('mem_hard'), 'notice first')
})

await t('exitAfterFlush: flushes then exits with the code; a throwing flush still exits', async () => {
  const { exitAfterFlush } = await import('../src/content/lens-launch.js')
  const calls: string[] = []
  await exitAfterFlush({ flush: async () => { calls.push('flush') }, exit: (c) => calls.push(`exit${c}`), code: 1, delayMs: 5, boxMs: 200 })
  await new Promise(r => setTimeout(r, 40))
  assert.deepEqual(calls.slice(0, 2), ['flush', 'exit1'])
  const c2: number[] = []
  await exitAfterFlush({ flush: async () => { throw new Error('boom') }, exit: (c) => c2.push(c), code: 1, delayMs: 5, boxMs: 200 })
  await new Promise(r => setTimeout(r, 40))
  assert.equal(c2[0], 1)
})

await t('exitAfterFlush: a flush that never settles still exits within the box', async () => {
  const { exitAfterFlush } = await import('../src/content/lens-launch.js')
  const codes: number[] = []
  void exitAfterFlush({ flush: () => new Promise<void>(() => {}), exit: (c) => codes.push(c), code: 1, delayMs: 5, boxMs: 60 })
  await new Promise(r => setTimeout(r, 40))
  assert.equal(codes.length, 0, 'not before the box (the flush is still pending)')
  for (let i = 0; i < 50 && !codes.length; i++) await new Promise(r => setTimeout(r, 100))
  assert.deepEqual(codes, [1])
})

await t('idle exit calls the flush before exit', () => {
  const body = slice(idx, 'const armIdleExitTimer = (reason: string) => {', '\n  }\n')
  assert.match(body, /flushLastSessionThenExit\('idle_exit', 0, 2000\)/)
  assert.doesNotMatch(body, /process\.exit\(/)
})

await t('slot cap refusal appends slot_refused', () => {
  const body = slice(idx, 'async function spawnBackgroundSession(', 'const slotWorkingDir')
  assert.match(body, /kind: 'slot_refused'/)
  assert.ok(body.indexOf("kind: 'slot_refused'") < body.indexOf('return'), 'recorded before the early return')
})

await t('the spoken dispatch and the panel dispatch keep a capped instruction in the target ledger, not the hub', () => {
  const spawn = slice(idx, 'async function spawnBackgroundSession(', 'const slotWorkingDir')
  assert.doesNotMatch(spawn, /queued/i, 'the spawn refusal never writes the hub ledger with the instruction')
  const keep = slice(idx, 'const keepQueued = ', 'const DISPATCH_REPORT_CAP_MS')
  assert.match(keep, /appendQueuedLoop\(sessionId, cwd, instruction, project, \{ typed \}\)/)
  const byName = slice(idx, 'async function dispatchByName(', 'const hubTools')
  assert.match(byName, /pick\.reason !== 'cap'[\s\S]*resolveCwdForSession\(pick\.sessionId, pick\.cwd\)[\s\S]*keepQueued\(pick\.sessionId, cwd,/)
  assert.doesNotMatch(byName, /recordLoop/)
  const slot = slice(idx, 'async function dispatchToSlot(', 'const slot = slots.get(targetSessionId)')
  assert.match(slot, /seat\.reason === 'cap'[\s\S]*keepQueued\(targetSessionId, capCwd,[\s\S]*if \(kept\) return fail\(/)
  assert.ok(slot.indexOf('if (kept) return') < slot.indexOf('spawnBackgroundSession('), 'a kept instruction returns before the spawn, so the hub ledger gets no slot_refused')
})

await t('index registers SIGINT and SIGTERM handlers that flush', () => {
  assert.match(idx, /for \(const sig of \['SIGINT', 'SIGTERM'\] as const\)/)
  const body = slice(idx, "for (const sig of ['SIGINT', 'SIGTERM'] as const)", '\n}\n')
  assert.match(body, /flushLastSessionThenExit\(`signal_\$\{sig\}`, 0, 1500\)/)
  assert.match(body, /if \(stopSignalled\) process\.exit\(sig === 'SIGINT' \? 130 : 143\)/, 'a second signal quits at once')
})

await t('the abort path records pending permissions and cut-off sub-agents before closing (killCurrentLLM → abortQuery → closeSession)', () => {
  assert.match(slice(llm, '  abortQuery(): void {', '\n  }\n'), /this\.closeSession\(\)/)
  const close = slice(llm, '  closeSession(): void {', '\n  }\n')
  const sev = close.indexOf("kind: 'dispatch_severed'")
  const perm = close.indexOf("by: 'abort'")
  const clear = close.indexOf('this.#typeByAgentId.clear()')
  assert.ok(sev > 0 && perm > 0 && clear > sev && clear > perm, 'recorded before the tracking maps are cleared')
})

await t('UserPromptSubmit appends the raw prompt (main thread only)', () => {
  const ups = slice(llm, 'UserPromptSubmit: [{', 'PreCompact: [{')
  assert.match(ups, /const loopRecap = fromSubagent \? '' : this\.#llmRef\.noteUserTurn\(String\(input\?\.prompt \|\| ''\), sid\)/)
  assert.match(ups, /\[reminder, recalled, loopRecap, machineNudge[,\]]/)
  assert.match(slice(llm, '  noteUserTurn(', '\n  }\n'), /kind: 'prompt'/)
})

await t('SubagentStart and SubagentStop append dispatch lines', () => {
  assert.match(slice(llm, 'SubagentStart: [{', 'SubagentStop: [{'), /kind: 'dispatch_started'/)
  assert.match(slice(llm, 'SubagentStop: [{', 'TaskCreated: [{'), /kind: 'dispatch_stopped'/)
})

await t('TodoWrite, TaskCreate and TaskUpdate are captured at PostToolUse', () => {
  const post = slice(llm, 'PostToolUse: [{', 'UserPromptSubmit: [{')
  assert.match(post, /toolName === 'TodoWrite'/)
  assert.match(post, /toolName === 'TaskCreate'/)
  assert.match(post, /toolName === 'TaskUpdate'/)
})

await t('only the foreground voice sessions opt into filing; background slots do not', () => {
  assert.equal((idx.match(/followThrough: true,/g) || []).length, 3)
  const slot = slice(idx, 'const bgLLM = createClaudeLLM({', '})')
  assert.doesNotMatch(slot, /followThrough/)
  assert.match(llm, /followThrough: !!opts\.followThrough/)
})

await t('next start drains unfiled ledgers', () => {
  assert.match(idx, /launchLoopsFlush\('drain', 'startup'\)/)
})

await t('launchLoopsFlush resolves only after the detached worker has spawned', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loops-trigger-test-'))
  process.env.CLAUDE_CONFIG_DIR = home
  const { launchLoopsFlush } = await import('../src/content/lens-launch.js')
  const r = await launchLoopsFlush({ sessionId: 'nope', cwd: home }, 'test')
  assert.equal(r, 'spawned')
  process.env.OSBORN_FOLLOW_THROUGH = 'off'
  assert.equal(await launchLoopsFlush('drain', 'test'), 'disabled')
  delete process.env.OSBORN_FOLLOW_THROUGH
  assert.match(slice(launch, 'export function launchLoopsFlush(', '\n}\n'), /child\.once\('spawn', \(\) => \{[\s\S]*child\.unref\(\)/)
  rmSync(home, { recursive: true, force: true })
})

console.log(`\n${pass} passed`)
