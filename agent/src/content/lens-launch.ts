/**
 * lens-launch.ts — HOOK-SIDE launcher for the compaction content lens.
 *
 * Called from the PostCompact hook. It only: takes the per-project lock, writes
 * a tiny 0600 temp JSON payload (session id + transcript_path + cwd — nothing
 * else), and spawns a DETACHED Node process running compaction-lens-worker.
 * No awaits, no heavy imports (node: builtins only), never throws.
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LOCK_FILE, LOCK_TTL_MS, LOG_FILE, acquireLock, findTranscriptBySessionId, libraryHomeDir, readSweepStatus, releaseLock, resolveProjectDir, slugDir, writeSweepStatus } from './lens-paths.js'

export interface LensLaunchPayload {
  sessionId: string
  transcriptPath?: string
  cwd?: string
  /** Session-end runs: Library + content steps only, not the profile lens (step 1). */
  skipLens?: boolean
  /** Run the machine-wide catch-up sweep after the steps (session end), skipping these live sessions. */
  sweep?: SweepRequest
}

export interface SweepRequest {
  /** Session ids that are live right now: never swept. */
  exclude: string[]
  trigger: string
}

export type LensLaunchResult =
  | { status: 'disabled' }
  | { status: 'no-key' }
  | { status: 'locked'; projectDir: string }
  | { status: 'unlockable'; projectDir: string | null }
  | { status: 'no-worker' }
  | { status: 'spawned'; pid?: number; projectDir: string | null; worker: string }
  | { status: 'error'; error: string }

/** ON by default; kill switch: OSBORN_CONTENT_LENS=0 | off | false | no. */
export function isContentLensEnabled(): boolean {
  const v = (process.env.OSBORN_CONTENT_LENS ?? '').trim().toLowerCase()
  return !['0', 'off', 'false', 'no'].includes(v)
}

/**
 * Worker entry + node args. From dist → dist/content/compaction-lens-worker.js.
 * From a tsx/src dev run → the .ts sibling, loaded through tsx's ESM hook.
 */
export function resolveWorkerCommand(): { args: string[]; worker: string } | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const js = join(here, 'compaction-lens-worker.js')
  if (existsSync(js)) return { args: [js], worker: js }
  const ts = join(here, 'compaction-lens-worker.ts')
  if (existsSync(ts)) {
    try {
      const tsxEsm = createRequire(import.meta.url).resolve('tsx/esm')
      return { args: ['--import', pathToFileURL(tsxEsm).href, ts], worker: ts }
    } catch {
      return null
    }
  }
  return null
}

let warnedSpawn = false

/** The worker command, or why no worker can run (switched off, no OpenRouter key, no worker file). */
function workerOrSkip(): { args: string[]; worker: string } | Extract<LensLaunchResult, { status: 'disabled' | 'no-key' | 'no-worker' }> {
  if (!isContentLensEnabled()) return { status: 'disabled' }
  // OpenRouter is the only model path; without a key the worker can do nothing.
  if (!(process.env.OPENROUTER_API_KEY || '').trim()) return { status: 'no-key' }
  return resolveWorkerCommand() ?? { status: 'no-worker' }
}

/**
 * Spawn the detached worker on `argFile`. Its stderr goes to <logDir>/content-lens.log, so a
 * crash before the worker's own logging (bad import, OOM) is not lost.
 */
function spawnWorker(cmd: { args: string[] }, argFile: string, logDir: string | null, onError: (err: Error) => void): number | undefined {
  let fd: number | null = null
  try {
    if (logDir) fd = openSync(join(logDir, LOG_FILE), 'a', 0o600)
  } catch {
    fd = null
  }
  try {
    const child = spawn(process.execPath, [...cmd.args, argFile], {
      detached: true,
      stdio: ['ignore', 'ignore', fd ?? 'ignore'],
      env: { ...process.env },
    })
    child.on('error', onError)
    child.unref()
    return child.pid
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

function writeArgFile(payload: Record<string, unknown>): string {
  const argFile = join(tmpdir(), `osborn-lens-${process.pid}-${randomBytes(6).toString('hex')}.json`)
  writeFileSync(argFile, JSON.stringify(payload), { mode: 0o600, flag: 'wx' })
  return argFile
}

/** Fire-and-forget. Returns synchronously; the worker is never awaited. */
export function launchCompactionLens(payload: LensLaunchPayload): LensLaunchResult {
  let projectDir: string | null = null
  let lockHeld = false
  try {
    const cmd = workerOrSkip()
    if ('status' in cmd) return cmd

    // The session's own transcript decides the project (session-end launches pass none): a cwd
    // that slugs to another project would lock the wrong one and let two workers race (#272).
    const transcriptPath =
      payload.transcriptPath ?? findTranscriptBySessionId(payload.sessionId, payload.cwd ? slugDir(payload.cwd) : null) ?? undefined
    projectDir = resolveProjectDir(transcriptPath, payload.cwd)
    if (!projectDir) return { status: 'unlockable', projectDir: null }
    // mkdir then lock; if the dir can't be created or locked, skip the launch entirely
    // (an unlocked worker could race another one on the profile / high-water mark).
    try {
      mkdirSync(projectDir, { recursive: true })
    } catch {
      return { status: 'unlockable', projectDir }
    }
    if (!acquireLock(projectDir)) {
      return existsSync(join(projectDir, LOCK_FILE)) ? { status: 'locked', projectDir } : { status: 'unlockable', projectDir }
    }
    lockHeld = true

    const argFile = writeArgFile({
      sessionId: payload.sessionId,
      transcriptPath,
      cwd: payload.cwd,
      skipLens: !!payload.skipLens,
      lockDir: lockHeld ? projectDir : null,
      ...(payload.sweep ? { sweep: payload.sweep } : {}),
    })
    const lockDir = projectDir
    const pid = spawnWorker(cmd, argFile, projectDir, err => {
      if (lockHeld && lockDir) releaseLock(lockDir)
      if (!warnedSpawn) {
        warnedSpawn = true
        console.error('⚠️ content-lens: worker spawn failed:', err?.message)
      }
    })
    return { status: 'spawned', pid, projectDir, worker: cmd.worker }
  } catch (err) {
    if (lockHeld && projectDir) releaseLock(projectDir)
    const msg = err instanceof Error ? err.message : String(err)
    if (!warnedSpawn) {
      warnedSpawn = true
      console.error('⚠️ content-lens: launch failed:', msg)
    }
    return { status: 'error', error: msg }
  }
}

// Session-end Library run. Compaction (the hook trigger) needs ~750k tokens on a
// 1M window, so it almost never fires; the agent also launches the Library when a
// session ends (disconnect, switch, cleanup). The worker is idempotent per period.
type LastRun = { at: string; session: string; reason: string; status: LensLaunchResult['status']; attempt?: number }
let lastRun: LastRun | null = null
// The last launch that actually spawned a worker: a later locked / no-key attempt does not erase it (#270).
let lastSpawned: LastRun | null = null
export const lastLibraryRun = () => lastRun

/** Sessions still running on this machine (set by the agent); retries and sweeps never touch them. */
let liveSessions: () => string[] = () => []
export function setLibraryLiveSessions(fn: () => string[]): void {
  liveSessions = fn
}

/** A session end that found its project locked is retried after the lock can have expired (#268). */
export const sessionEndRetry = { delayMs: LOCK_TTL_MS + 60_000, max: 3 }
const retries = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * `live` = sessions still running on this machine (never swept). The worker writes this
 * session's page, then runs the catch-up sweep. When another worker holds this project's
 * lock, a standalone sweep is launched for the other sessions, and this launch is retried
 * (up to sessionEndRetry.max times) unless the session is live again by then.
 */
export function launchLibraryOnSessionEnd(
  sessionId: string | null | undefined, cwd: string | undefined, reason: string, live: string[] = liveSessions(), attempt = 0,
): LastRun | null {
  if (!sessionId) return null
  const exclude = live.filter(id => id && id !== sessionId)
  const r = launchCompactionLens({ sessionId, cwd, skipLens: true, sweep: { exclude, trigger: `session-end:${reason}` } })
  lastRun = { at: new Date().toISOString(), session: sessionId.slice(0, 8), reason, status: r.status, ...(attempt ? { attempt } : {}) }
  console.log(`📚 library on session end (${reason}${attempt ? `, retry ${attempt}` : ''}): ${lastRun.session} → ${r.status}`)
  if (r.status === 'spawned') lastSpawned = lastRun
  if (r.status === 'locked' || r.status === 'unlockable') {
    if (!attempt) launchLibrarySweep(exclude, `session-end:${reason}`)
    if (attempt < sessionEndRetry.max && !retries.has(sessionId)) {
      const timer = setTimeout(() => {
        retries.delete(sessionId)
        if (liveSessions().includes(sessionId)) return // resumed: its next end launches again
        launchLibraryOnSessionEnd(sessionId, cwd, reason, liveSessions(), attempt + 1)
      }, sessionEndRetry.delayMs)
      timer.unref?.()
      retries.set(sessionId, timer)
    }
  }
  return lastRun
}

/**
 * Catch-up sweep (lens-library-sweep.ts) in a detached worker: every unwritten period and
 * past-day digest on this machine, newest first, capped per run. The machine-wide sweep lock
 * is taken here, so two sweeps never run at once; the worker inherits and releases it.
 */
export function launchLibrarySweep(live: string[], trigger: string): LensLaunchResult {
  const home = libraryHomeDir()
  let lockHeld = false
  try {
    const cmd = workerOrSkip()
    if ('status' in cmd) return cmd
    mkdirSync(home, { recursive: true })
    if (!acquireLock(home)) return { status: 'locked', projectDir: home }
    lockHeld = true
    const argFile = writeArgFile({ sweep: { exclude: live.filter(Boolean), trigger }, sweepLockHeld: true })
    const pid = spawnWorker(cmd, argFile, home, err => {
      releaseLock(home)
      writeSweepStatus({ status: 'error', trigger, at: new Date().toISOString(), errors: [{ kind: 'spawn', message: String(err?.message ?? err).slice(0, 160) }] }, home)
    })
    console.log(`📚 library sweep (${trigger}) → spawned`)
    return { status: 'spawned', pid, projectDir: home, worker: cmd.worker }
  } catch (err) {
    if (lockHeld) releaseLock(home)
    const msg = err instanceof Error ? err.message : String(err)
    console.error('⚠️ library sweep: launch failed:', msg)
    return { status: 'error', error: msg }
  }
}

/**
 * The /health view of the sweep status file (survives restarts). Counts, kinds and 8-char
 * ids or days only: never messages or paths (/health is public).
 */
export function librarySweepHealth(): Record<string, unknown> {
  const s = readSweepStatus()
  return {
    lastSpawned,
    // 8-char ids of sessions waiting for a session-end retry.
    pendingRetries: [...retries.keys()].map(id => id.slice(0, 8)),
    lastStep: s?.lastStep ?? null,
    backlog: s?.backlog ?? null,
    lastSweep: s?.at
      ? {
          status: s.status, trigger: s.trigger, at: s.at, finishedAt: s.finishedAt ?? null,
          pagesWritten: s.pagesWritten, digestsWritten: s.digestsWritten, modelCalls: s.modelCalls, costUsd: s.costUsd,
          capHit: !!s.capHit, errors: (s.errors ?? []).map(e => ({ kind: e.kind, ref: e.ref ?? null })),
        }
      : null,
    workerError: s?.workerError ? { at: s.workerError.at, kind: s.workerError.kind, ref: s.workerError.ref ?? null } : null,
  }
}
