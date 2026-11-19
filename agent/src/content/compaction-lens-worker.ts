/**
 * compaction-lens-worker.ts — DETACHED worker entry for the content lens.
 *
 * Two entries:
 *   node compaction-lens-worker.js <argfile>
 *       per-compaction (spawned by lens-launch.ts). The argfile (mode 0600,
 *       deleted immediately after reading) carries only
 *       { sessionId, transcriptPath?, cwd?, lockDir? }. INCREMENTAL: only
 *       session.db rows newer than the per-session high-water mark.
 *   node compaction-lens-worker.js --backfill <sessionId> [--cwd <dir>] [--max-windows N] [--out <path>]
 *       BACKFILL: pages the whole session from row 0 (bounded by the per-run
 *       cost/call cap). Takes the per-project lock itself. --out writes a review
 *       copy to <path> instead of content-profile.md and leaves the HWM alone.
 *   node compaction-lens-worker.js --library <sessionId> [--cwd <dir>] [--dry] [--out-dir <dir>]
 *       LIBRARY step only (manual / dry run). Takes the per-project lock itself.
 *   node compaction-lens-worker.js --sweep [--exclude <id,id>] [--dry] [--max N]
 *       CATCH-UP SWEEP only (lens-library-sweep.ts): the Library backlog of every session on the
 *       machine plus the daily digests, newest first, capped. Takes the machine-wide sweep lock.
 *       The agent also launches it shortly after start (argfile { sweep }) and after each
 *       session-end run (the session-end argfile carries { sweep }; it runs after the steps).
 *   node compaction-lens-worker.js --content <sessionId> [--cwd <dir>] [--dry] [--research-refresh]
 *       CONTENT step (Stage A) only: manual / the per-project "Refresh research"
 *       backend. --dry = no ingest (still spends, capped). Takes the per-project lock.
 * Per-compaction runs do THREE independent, fail-open steps under one lock:
 *   1. the content lens (content-profile.md + HWM), unchanged;
 *   2. the library step (lens-library.ts): one period-map page for the period
 *      that just ended + INDEX.md;
 *   3. the content step (content-run.ts, Stage A): research → briefs → scripts →
 *      checks → draft ingest for that period. A failure in any never stops the others.
 * Fully self-contained: top-level try/catch, redacted log in the project dir,
 * refreshes + releases the per-project lock, always exits.
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { runCompactionLens, type LensRunOptions } from './compaction-lens.js'
import { resolveSessionDb } from './lens-db.js'
import { acquireLock, libraryHomeDir, readSweepStatus, refuseOutPath, releaseLock, resolveProjectDir, touchLock, writeSweepStatus } from './lens-paths.js'
import { logLine } from './lens-profile.js'
import { runLibraryStep, type LibraryStepOptions } from './lens-library.js'
import { errorLine, runLibrarySweep } from './lens-library-sweep.js'
import { runContentStep } from './content-run.js'
import type { SweepRequest } from './lens-launch.js'

// ≤2 big windows + reduce at ≤6 min/call, then the library step (1 call ≤6 min + model meta),
// then the content step (Stage A: ~10-18 small calls, ≤4 min each, capped in $).
const INCREMENTAL_TIMEOUT_MS = 45 * 60_000
const BACKFILL_TIMEOUT_MS = 3 * 60 * 60_000
const LIBRARY_TIMEOUT_MS = 15 * 60_000
const CONTENT_TIMEOUT_MS = 20 * 60_000
// The sweep stops starting pages after SWEEP_BUDGET_MS (60 min); one page call is ≤6 min.
const SWEEP_TIMEOUT_MS = 80 * 60_000

interface Job {
  opts: LensRunOptions
  /** 'library' = the --library CLI entry: library step only. 'content' = the --content entry: content step only. 'sweep' = sweep only. */
  kind?: 'lens' | 'library' | 'content' | 'sweep'
  /** Run the catch-up sweep (after the steps, if any). */
  sweep?: SweepRequest & { dry?: boolean; max?: number; print?: boolean }
  /** The launcher already took the machine-wide sweep lock for this worker. */
  sweepLockHeld?: boolean
  /** Session-end launch: skip step 1 (the profile lens). */
  skipLens?: boolean
  library?: Pick<LibraryStepOptions, 'dry' | 'outDir'>
  content?: { dry: boolean; researchRefresh: boolean }
  lockDir: string | null
  logDir: string | null
  timeoutMs: number
}

function argVal(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function parseJob(argv: string[]): Job {
  if (argv[0] === '--sweep') {
    const max = Number(argVal(argv, '--max'))
    const exclude = (argVal(argv, '--exclude') ?? '').split(',').map(s => s.trim()).filter(Boolean)
    return {
      opts: { sessionId: '', mode: 'incremental' },
      kind: 'sweep',
      sweep: { exclude, trigger: 'manual', dry: argv.includes('--dry'), max: Number.isFinite(max) && max > 0 ? max : undefined, print: true },
      lockDir: null,
      logDir: libraryHomeDir(),
      timeoutMs: SWEEP_TIMEOUT_MS,
    }
  }
  if (argv[0] === '--content') {
    const sessionId = argv[1]
    if (!sessionId || sessionId.startsWith('--')) throw new Error('usage: --content <sessionId> [--cwd <dir>] [--dry] [--research-refresh]')
    const cwd = argVal(argv, '--cwd')
    const db = resolveSessionDb(sessionId, null, cwd)
    const projectDir = db ? dirname(dirname(dirname(db))) : null
    if (!projectDir || !acquireLock(projectDir)) throw new Error(`content: project dir ${projectDir ?? '(none)'} missing or locked`)
    return {
      opts: { sessionId, cwd, mode: 'incremental' },
      kind: 'content',
      content: { dry: argv.includes('--dry'), researchRefresh: argv.includes('--research-refresh') },
      lockDir: projectDir,
      logDir: projectDir,
      timeoutMs: CONTENT_TIMEOUT_MS,
    }
  }
  if (argv[0] === '--library') {
    const sessionId = argv[1]
    if (!sessionId || sessionId.startsWith('--')) throw new Error('usage: --library <sessionId> [--cwd <dir>] [--dry] [--out-dir <dir>]')
    const cwd = argVal(argv, '--cwd')
    const db = resolveSessionDb(sessionId, null, cwd)
    const projectDir = db ? dirname(dirname(dirname(db))) : null
    const outDir = argv.includes('--out-dir') ? argVal(argv, '--out-dir') : undefined
    if (argv.includes('--out-dir') && (!outDir || outDir.startsWith('--'))) throw new Error('library: --out-dir requires a directory')
    if (!projectDir || !acquireLock(projectDir)) throw new Error(`library: project dir ${projectDir ?? '(none)'} missing or locked`)
    return {
      opts: { sessionId, cwd, mode: 'incremental' },
      kind: 'library',
      library: { dry: argv.includes('--dry'), outDir },
      lockDir: projectDir,
      logDir: projectDir,
      timeoutMs: LIBRARY_TIMEOUT_MS,
    }
  }
  if (argv[0] === '--backfill') {
    const sessionId = argv[1]
    if (!sessionId) throw new Error('usage: --backfill <sessionId> [--cwd <dir>] [--max-windows N] [--out <path>]')
    const cwd = argVal(argv, '--cwd')
    const db = resolveSessionDb(sessionId, null, cwd)
    const projectDir = db ? dirname(dirname(dirname(db))) : cwd ? resolveProjectDir(undefined, cwd) : null
    // review copy: overwrite this file, never the profile, never move the HWM.
    // Validated BEFORE the lock so a bad --out aborts without leaving a lock behind.
    const outPath = argv.includes('--out') ? argVal(argv, '--out') : undefined
    if (argv.includes('--out')) {
      const why = refuseOutPath(outPath, projectDir)
      if (why) throw Object.assign(new Error(`backfill: ${why}`), { logDir: projectDir })
    }
    if (!projectDir || !acquireLock(projectDir)) throw new Error(`backfill: project dir ${projectDir ?? '(none)'} missing or locked`)
    const mw = Number(argVal(argv, '--max-windows'))
    return {
      opts: {
        sessionId, cwd, mode: 'backfill', maxWindows: Number.isFinite(mw) && mw > 0 ? mw : undefined,
        ...(outPath ? { outPath, updateHwm: false } : {}),
      },
      lockDir: projectDir,
      logDir: projectDir,
      timeoutMs: BACKFILL_TIMEOUT_MS,
    }
  }
  const argFile = argv[0]
  let payload: { sessionId?: string; transcriptPath?: string; cwd?: string; lockDir?: string | null; skipLens?: boolean; sweep?: SweepRequest; sweepLockHeld?: boolean } = {}
  try {
    payload = JSON.parse(readFileSync(argFile, 'utf-8'))
  } finally {
    try {
      rmSync(argFile, { force: true })
    } catch {
      /* ignore */
    }
  }
  const sweep = payload.sweep && Array.isArray(payload.sweep.exclude) ? { exclude: payload.sweep.exclude.map(String), trigger: String(payload.sweep.trigger ?? 'launch') } : undefined
  if (sweep && !payload.sessionId) {
    // Standalone sweep (agent start, or a session end whose project was busy).
    return { opts: { sessionId: '', mode: 'incremental' }, kind: 'sweep', sweep, sweepLockHeld: payload.sweepLockHeld === true, lockDir: null, logDir: libraryHomeDir(), timeoutMs: SWEEP_TIMEOUT_MS }
  }
  const lockDir = payload.lockDir || null
  const logDir = lockDir || resolveProjectDir(payload.transcriptPath, payload.cwd)
  if (!payload.sessionId) throw Object.assign(new Error('payload missing sessionId'), { lockDir, logDir })
  return {
    opts: { sessionId: payload.sessionId, transcriptPath: payload.transcriptPath, cwd: payload.cwd, mode: 'incremental' },
    skipLens: payload.skipLens === true,
    sweep,
    lockDir,
    logDir,
    timeoutMs: INCREMENTAL_TIMEOUT_MS + (sweep ? SWEEP_TIMEOUT_MS : 0),
  }
}

/** Set while this worker holds the machine-wide sweep lock. */
let sweepHome: string | null = null

async function main(): Promise<number> {
  let job: Job | null = null
  let logDir: string | null = null
  let lockDir: string | null = null
  try {
    try {
      job = parseJob(process.argv.slice(2))
    } catch (err: any) {
      lockDir = err?.lockDir ?? null
      logDir = err?.logDir ?? null
      throw err
    }
    lockDir = job.lockDir
    logDir = job.logDir
    const sid = job.opts.sessionId.substring(0, 8) || 'sweep'
    const steps = job.kind !== 'sweep'

    const killer = setTimeout(() => {
      logLine(logDir, `session ${sid}: hard timeout — exiting`)
      if (lockDir) releaseLock(lockDir)
      if (sweepHome) {
        writeSweepStatus({ status: 'timeout', finishedAt: new Date().toISOString(), errors: [...(readSweepStatus(sweepHome)?.errors ?? []), { kind: 'timeout' }] }, sweepHome)
        releaseLock(sweepHome)
      }
      process.exit(2)
    }, job.timeoutMs)
    killer.unref()

    const t0 = Date.now()
    let lensErr: unknown = null
    // Step 1 — content lens (skipped by the --library entry).
    if (steps && job.kind !== 'library' && job.kind !== 'content' && !job.skipLens) {
      try {
        const r = await runCompactionLens({
          ...job.opts,
          onWindow: () => lockDir && touchLock(lockDir),
          log: m => logLine(logDir, `session ${sid} [${job!.opts.mode}]: ${m}`),
        })
        logDir = r.projectDir || logDir
        logLine(
          logDir,
          `session ${sid}: done status=${r.status} mode=${r.mode} rows=${r.records} windows=${r.windowsProcessed}/${r.windowsTotal} ` +
            `calls=${r.modelCalls} cost=$${r.costUsd.toFixed(4)} kept=${r.kept.angles}A/${r.kept.capabilities}C ` +
            `dropped=${r.mapDropped.angles + r.dropped.angles}A/${r.mapDropped.capabilities + r.dropped.capabilities}C ` +
            `notDone=${r.notDone} billing=${r.billingDropped} hwm=${r.hwmBefore}→${r.hwmAfter} ${Date.now() - t0}ms`,
        )
      } catch (err) {
        lensErr = err
        logLine(logDir, `worker error: ${err instanceof Error ? err.stack || err.message : String(err)}`)
      }
    }
    // Step 2 — library page for the period that just ended (per-compaction + --library only; never backfill).
    // runLibraryStep never throws; any failure is logged and the worker still exits cleanly.
    let libPeriod: Awaited<ReturnType<typeof runLibraryStep>>['period'] = null
    if (steps && job.opts.mode === 'incremental' && job.kind !== 'content') {
      if (lockDir) touchLock(lockDir)
      const lib = await runLibraryStep({
        sessionId: job.opts.sessionId,
        projectDir: lockDir,
        cwd: job.opts.cwd,
        ...job.library,
        keepAlive: () => lockDir && touchLock(lockDir),
        log: m => logLine(logDir, `session ${sid} [library]: ${m}`),
      })
      logLine(logDir, `session ${sid}: library status=${lib.status} cost=$${lib.costUsd.toFixed(4)}${lib.page ? ` page=${lib.page}` : ''}`)
      if (job.kind === 'library') process.stdout.write(`${JSON.stringify({ status: lib.status, page: lib.page, index: lib.index, period: lib.period, cost: lib.costUsd, errors: lib.errors })}\n`)
      if (lib.status === 'written') libPeriod = lib.period
      // The step's real outcome, on /health (the worker's own output goes nowhere).
      if (job.kind !== 'library') {
        writeSweepStatus({ lastStep: { at: new Date().toISOString(), session: sid, status: lib.status, ...(lib.period ? { period: lib.period.index } : {}), costUsd: lib.costUsd } })
      }
      if (lib.status === 'failed' || lib.status === 'model-error') {
        writeSweepStatus({ workerError: { at: new Date().toISOString(), kind: `library-${lib.status}`, ref: sid, message: errorLine(lib.errors.join('; ')) } })
      }
    }
    // Step 3 — content plan (Stage A) for the period (per-compaction + --content; never backfill / --library).
    // runContentStep never throws; the try is belt and braces so nothing here can fail the worker.
    if (steps && job.opts.mode === 'incremental' && job.kind !== 'library') {
      try {
        if (lockDir) touchLock(lockDir)
        const c = await runContentStep({
          sessionId: job.opts.sessionId,
          projectDir: lockDir,
          cwd: job.opts.cwd,
          period: libPeriod,
          dry: job.content?.dry,
          researchRefresh: job.content?.researchRefresh,
          keepAlive: () => lockDir && touchLock(lockDir),
          log: m => logLine(logDir, `session ${sid} [content]: ${m}`),
        })
        logLine(logDir, `session ${sid}: content status=${c.status} pieces=${c.pieces.length} cost=$${c.costUsd.toFixed(4)}${c.capHit ? ` cap=${c.capHit}` : ''}`)
        if (job.kind === 'content') process.stdout.write(`${JSON.stringify(c)}\n`)
      } catch (err) {
        logLine(logDir, `content step error (ignored): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // Step 4 — catch-up sweep (agent start, after a session end, or --sweep). Never two at once:
    // the machine-wide sweep lock is either handed over by the launcher or taken here.
    if (job.sweep) {
      const home = libraryHomeDir()
      mkdirSync(home, { recursive: true })
      // This session's steps are done: free its project for the next compaction run; the sweep
      // takes each project's lock only while it writes a page there.
      if (lockDir) releaseLock(lockDir)
      lockDir = null
      if (job.sweepLockHeld || acquireLock(home)) {
        sweepHome = home
        // A manual --sweep (print) is never held back by the cooldown.
        const s = await runLibrarySweep({ exclude: job.sweep.exclude, trigger: job.sweep.trigger, dry: job.sweep.dry, maxPages: job.sweep.max, ...(job.sweep.print ? { cooldownMs: 0 } : {}) })
        logLine(logDir, `session ${sid}: sweep status=${s.status} pages=${s.pagesWritten} digests=${s.digestsWritten} calls=${s.modelCalls} cost=$${s.costUsd.toFixed(4)} errors=${s.errors.length}`)
        if (job.sweep.print) process.stdout.write(`${JSON.stringify(s)}\n`)
      } else {
        logLine(logDir, `session ${sid}: sweep skipped (another sweep is running)`)
        if (job.sweep.print) process.stderr.write('sweep: another sweep is running\n')
      }
    }
    return lensErr ? 1 : 0
  } catch (err) {
    logLine(logDir, `worker error: ${err instanceof Error ? err.stack || err.message : String(err)}`)
    if (err instanceof Error && /^(backfill|library|content):/.test(err.message)) process.stderr.write(`${err.message}\n`)
    // Visible on /health: a crashed worker no longer disappears into stdio 'ignore'.
    writeSweepStatus({
      ...(sweepHome ? { status: 'error' as const, finishedAt: new Date().toISOString() } : {}),
      workerError: { at: new Date().toISOString(), kind: job?.kind ?? 'worker', message: errorLine(err) },
    })
    return 1
  } finally {
    if (lockDir) releaseLock(lockDir)
    if (sweepHome) releaseLock(sweepHome)
  }
}

main()
  .then(code => process.exit(code))
  .catch(() => process.exit(1))
