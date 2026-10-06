/**
 * lens-launch.ts — HOOK-SIDE launcher for the compaction content lens.
 *
 * Called from the PostCompact hook. It only: takes the per-project lock, writes
 * a tiny 0600 temp JSON payload (session id + transcript_path + cwd — nothing
 * else), and spawns a DETACHED Node process running compaction-lens-worker.
 * No awaits, no heavy imports (node: builtins only), never throws.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LOCK_FILE, acquireLock, findTranscriptBySessionId, releaseLock, resolveProjectDir } from './lens-paths.js'

export interface LensLaunchPayload {
  sessionId: string
  transcriptPath?: string
  cwd?: string
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

/** Fire-and-forget. Returns synchronously; the worker is never awaited. */
export function launchCompactionLens(payload: LensLaunchPayload): LensLaunchResult {
  let projectDir: string | null = null
  let lockHeld = false
  try {
    if (!isContentLensEnabled()) return { status: 'disabled' }
    // OpenRouter is the only model path; without a key the worker can do nothing.
    if (!(process.env.OPENROUTER_API_KEY || '').trim()) return { status: 'no-key' }
    const cmd = resolveWorkerCommand()
    if (!cmd) return { status: 'no-worker' }

    projectDir = resolveProjectDir(payload.transcriptPath, payload.cwd)
    if (!projectDir) {
      const t = findTranscriptBySessionId(payload.sessionId)
      projectDir = t ? dirname(t) : null
    }
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

    const argFile = join(tmpdir(), `osborn-lens-${process.pid}-${randomBytes(6).toString('hex')}.json`)
    writeFileSync(
      argFile,
      JSON.stringify({
        sessionId: payload.sessionId,
        transcriptPath: payload.transcriptPath,
        cwd: payload.cwd,
        lockDir: lockHeld ? projectDir : null,
      }),
      { mode: 0o600, flag: 'wx' },
    )

    {
      const child = spawn(process.execPath, [...cmd.args, argFile], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      })
      child.on('error', err => {
        if (lockHeld && projectDir) releaseLock(projectDir)
        if (!warnedSpawn) {
          warnedSpawn = true
          console.error('⚠️ content-lens: worker spawn failed:', err?.message)
        }
      })
      child.unref()
      return { status: 'spawned', pid: child.pid, projectDir, worker: cmd.worker }
    }
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
