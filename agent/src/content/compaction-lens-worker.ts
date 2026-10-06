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
 * Per-compaction runs do TWO independent, fail-open steps under one lock:
 *   1. the content lens (content-profile.md + HWM), unchanged;
 *   2. the library step (lens-library.ts): one period-map page for the period
 *      that just ended + INDEX.md. A failure in either never stops the other.
 * Fully self-contained: top-level try/catch, redacted log in the project dir,
 * refreshes + releases the per-project lock, always exits.
 */

import { readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { runCompactionLens, type LensRunOptions } from './compaction-lens.js'
import { resolveSessionDb } from './lens-db.js'
import { acquireLock, refuseOutPath, releaseLock, resolveProjectDir, touchLock } from './lens-paths.js'
import { logLine } from './lens-profile.js'
import { runLibraryStep, type LibraryStepOptions } from './lens-library.js'

// ≤2 big windows + reduce at ≤6 min/call, then the library step (1 call ≤6 min + model meta).
const INCREMENTAL_TIMEOUT_MS = 35 * 60_000
const BACKFILL_TIMEOUT_MS = 3 * 60 * 60_000
const LIBRARY_TIMEOUT_MS = 15 * 60_000

interface Job {
  opts: LensRunOptions
  /** 'library' = the --library CLI entry: library step only, no lens step. */
  kind?: 'lens' | 'library'
  library?: Pick<LibraryStepOptions, 'dry' | 'outDir'>
  lockDir: string | null
  logDir: string | null
  timeoutMs: number
}

function argVal(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function parseJob(argv: string[]): Job {
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
  let payload: { sessionId?: string; transcriptPath?: string; cwd?: string; lockDir?: string | null } = {}
  try {
    payload = JSON.parse(readFileSync(argFile, 'utf-8'))
  } finally {
    try {
      rmSync(argFile, { force: true })
    } catch {
      /* ignore */
    }
  }
  const lockDir = payload.lockDir || null
  const logDir = lockDir || resolveProjectDir(payload.transcriptPath, payload.cwd)
  if (!payload.sessionId) throw Object.assign(new Error('payload missing sessionId'), { lockDir, logDir })
  return {
    opts: { sessionId: payload.sessionId, transcriptPath: payload.transcriptPath, cwd: payload.cwd, mode: 'incremental' },
    lockDir,
    logDir,
    timeoutMs: INCREMENTAL_TIMEOUT_MS,
  }
}

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
    const sid = job.opts.sessionId.substring(0, 8)

    const killer = setTimeout(() => {
      logLine(logDir, `session ${sid}: hard timeout — exiting`)
      if (lockDir) releaseLock(lockDir)
      process.exit(2)
    }, job.timeoutMs)
    killer.unref()

    const t0 = Date.now()
    let lensErr: unknown = null
    // Step 1 — content lens (skipped by the --library entry).
    if (job.kind !== 'library') {
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
    if (job.opts.mode === 'incremental') {
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
    }
    return lensErr ? 1 : 0
  } catch (err) {
    logLine(logDir, `worker error: ${err instanceof Error ? err.stack || err.message : String(err)}`)
    if (err instanceof Error && /^(backfill|library):/.test(err.message)) process.stderr.write(`${err.message}\n`)
    return 1
  } finally {
    if (lockDir) releaseLock(lockDir)
  }
}

main()
  .then(code => process.exit(code))
  .catch(() => process.exit(1))
