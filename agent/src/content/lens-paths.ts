/**
 * lens-paths.ts — LIGHT path + lock helpers shared by the hook-side launcher
 * and the background worker. node: builtins only (safe to import in the live agent).
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

export const PROFILE_FILE = 'content-profile.md'
export const LOCK_FILE = '.content-lens.lock'
export const LOG_FILE = 'content-lens.log'
export const LOCK_TTL_MS = 15 * 60_000

export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** Same slug rule as session-access.ts projectPathToSlug(). */
export function slugDir(cwd: string): string {
  return join(claudeDir(), 'projects', cwd.replace(/\//g, '-'))
}

/** True if `dir` is a project dir: strictly under <claudeDir>/projects/ and not a subagents dir. */
export function isProjectDir(dir: string): boolean {
  const root = resolve(claudeDir(), 'projects') + sep
  const d = resolve(dir)
  if (!d.startsWith(root)) return false
  return !d.slice(root.length).split(sep).includes('subagents')
}

/**
 * The transcript's project dir (guarded), else the cwd slug fallback, else null.
 * A sub-agent transcript (…/<sid>/subagents/x.jsonl) never qualifies.
 */
export function resolveProjectDir(transcriptPath?: string, cwd?: string): string | null {
  if (transcriptPath && transcriptPath.endsWith('.jsonl')) {
    const d = dirname(resolve(transcriptPath))
    if (isProjectDir(d)) return d
  }
  if (cwd) return slugDir(cwd)
  return null
}

const SID_RE = /^[A-Za-z0-9._-]{1,128}$/

/** Locate `<claudeDir>/projects/<any>/<sessionId>.jsonl` (project-scoped). */
export function findTranscriptBySessionId(sessionId: string, preferDir?: string | null): string | null {
  if (!sessionId || !SID_RE.test(sessionId)) return null
  const name = `${sessionId}.jsonl`
  if (preferDir && existsSync(join(preferDir, name))) return join(preferDir, name)
  const root = join(claudeDir(), 'projects')
  try {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const p = join(root, ent.name, name)
      if (existsSync(p)) return p
    }
  } catch {
    /* no projects dir */
  }
  return null
}

/**
 * Acquire the per-project lock. Returns false if a FRESH (<15 min) lock exists.
 * Stale locks are replaced. Exclusive-create avoids a check-then-write race.
 */
export function acquireLock(projectDir: string, now = Date.now()): boolean {
  const p = join(projectDir, LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(p, 'wx', 0o600)
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }))
      closeSync(fd)
      return true
    } catch (e: any) {
      if (e?.code !== 'EEXIST') return false
      try {
        if (now - statSync(p).mtimeMs < LOCK_TTL_MS) return false
        rmSync(p, { force: true }) // stale → replace once
      } catch {
        return false
      }
    }
  }
  return false
}

export function releaseLock(projectDir: string): void {
  try {
    rmSync(join(projectDir, LOCK_FILE), { force: true })
  } catch {
    /* ignore */
  }
}

/** Refresh the lock's mtime so a long (backfill) run isn't treated as stale. */
export function touchLock(projectDir: string): void {
  try {
    const now = new Date()
    utimesSync(join(projectDir, LOCK_FILE), now, now)
  } catch {
    /* ignore */
  }
}

export const sessionIdFromPath = (p: string): string => basename(p, '.jsonl')

// ── Per-session high-water mark (last session.db content.id the profile covers) ──

export const HWM_FILE = '.content-lens-hwm.json'

export interface HwmEntry {
  lastRowId: number
  lastTs?: string
  updatedAt: string
}

function readHwmFile(projectDir: string): Record<string, HwmEntry> {
  try {
    const o = JSON.parse(readFileSync(join(projectDir, HWM_FILE), 'utf-8'))
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}

export function readHwm(projectDir: string | null, sessionId: string): number {
  if (!projectDir) return 0
  const n = Number(readHwmFile(projectDir)[sessionId]?.lastRowId)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * A review --out path must never be the profile or the HWM file (of this or any
 * project; symlinks resolved). Returns a reason string when refused, else null.
 */
export function refuseOutPath(outPath: string | undefined, projectDir?: string | null): string | null {
  if (typeof outPath !== 'string' || !outPath.trim() || outPath.startsWith('--')) return '--out requires a file path'
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  const abs = resolve(outPath)
  const targets = new Set([abs, real(abs)])
  for (const name of [PROFILE_FILE, HWM_FILE]) {
    if ([...targets].some(t => basename(t) === name)) return `--out must not be ${name}`
    if (projectDir) {
      const p = join(projectDir, name)
      if (targets.has(resolve(p)) || targets.has(real(p))) return `--out must not be ${name}`
    }
  }
  return null
}

/** Owner-only file written via tmp + rename. */
function writePrivateAtomic(p: string, text: string): void {
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, p)
}

/** Monotonic: never moves the mark backwards. Atomic write via rename. */
export function writeHwm(projectDir: string, sessionId: string, lastRowId: number, lastTs?: string): void {
  const all = readHwmFile(projectDir)
  if ((all[sessionId]?.lastRowId ?? 0) >= lastRowId) return
  all[sessionId] = { lastRowId, lastTs, updatedAt: new Date().toISOString() }
  writePrivateAtomic(join(projectDir, HWM_FILE), JSON.stringify(all, null, 2))
}

// ── Short read-modify-write lock on a shared file (the spend ledger, the sweep status) ──

const FILE_LOCK_STALE_MS = 30_000
const FILE_LOCK_WAIT_MS = 50
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const lockToken = () => `${process.pid}.${randomBytes(8).toString('hex')}`

/**
 * Remove `path` if it is stale: rename it to a unique name (only ONE caller's
 * rename can succeed), check the renamed file is the same stale file we judged
 * (inode, mtime, content), and put it back with link() if a fresh one was
 * swapped in (link fails rather than clobbers). True only to the caller that
 * removed a stale file; any error = keep waiting.
 */
function removeIfStale(path: string): boolean {
  let seen: { ino: number; mtimeMs: number; body: string }
  try {
    const fd = openSync(path, 'r')
    try {
      const st = fstatSync(fd)
      if (Date.now() - st.mtimeMs <= FILE_LOCK_STALE_MS) return false
      seen = { ino: st.ino, mtimeMs: st.mtimeMs, body: readFileSync(fd, 'utf-8') }
    } finally {
      closeSync(fd)
    }
  } catch {
    return false // vanished between calls
  }
  const claimed = `${path}.stale.${process.pid}.${randomBytes(6).toString('hex')}`
  try {
    renameSync(path, claimed)
  } catch {
    return false // another caller claimed it first
  }
  let same = false
  try {
    const st = statSync(claimed)
    same = st.ino === seen.ino && st.mtimeMs === seen.mtimeMs && readFileSync(claimed, 'utf-8') === seen.body
  } catch {
    /* treat as not ours */
  }
  if (!same) {
    try {
      linkSync(claimed, path) // a live file was swapped in: restore it
    } catch {
      /* a newer one already exists */
    }
  }
  try {
    unlinkSync(claimed)
  } catch {
    /* already gone */
  }
  return same
}

/**
 * Claim a stale ledger lock. The judge-then-rename step runs under a short
 * `<lock>.reap` guard so two waiters can never both act on one stale lock (or
 * rename away the fresh lock the other just created). A guard left by a crash
 * goes stale too and is removed the same way.
 */
function claimStaleLock(lock: string): boolean {
  const guard = `${lock}.reap`
  let g: number
  try {
    g = openSync(guard, 'wx')
  } catch {
    removeIfStale(guard)
    return false
  }
  const token = lockToken()
  try {
    writeSync(g, token)
    return removeIfStale(lock)
  } catch {
    return false
  } finally {
    closeSync(g)
    releaseOwnedLock(guard, token)
  }
}

/** Release only a lock this holder owns (its token is still in the file). */
function releaseOwnedLock(lock: string, token: string): void {
  try {
    if (readFileSync(lock, 'utf-8') === token) unlinkSync(lock)
  } catch {
    /* already gone */
  }
}

/**
 * Run `fn` under a short `wx` lock file holding a unique token (stale after 30s, claimed via
 * rename so only one waiter can remove it). Returns false, without running `fn`, when the lock
 * could not be taken in `tries` attempts; an fs error other than EEXIST throws.
 */
export function withFileLock(lock: string, fn: () => void, tries: number): boolean {
  for (let i = 0; i < tries; i++) {
    let fd: number
    try {
      fd = openSync(lock, 'wx')
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e
      if (claimStaleLock(lock)) continue // we removed the stale lock: retry the wx create now
      sleepSync(FILE_LOCK_WAIT_MS)
      continue
    }
    const token = lockToken()
    try {
      writeSync(fd, token)
      fn()
      return true
    } finally {
      closeSync(fd)
      releaseOwnedLock(lock, token)
    }
  }
  return false
}

// ── Machine-wide Library sweep: lock, log and status (one dir per machine) ──

export const SWEEP_STATUS_FILE = 'library-sweep-status.json'

/** <claudeDir>/osb-library: the sweep's lock (LOCK_FILE), log (LOG_FILE), status file and the daily digests. */
export function libraryHomeDir(): string {
  return join(claudeDir(), 'osb-library')
}

export interface SweepError {
  /** 'period' | 'digest' | 'scan' | 'worker' | 'timeout' | 'spawn' */
  kind: string
  /** 8-char session id or a YYYY-MM-DD day. Never a path. */
  ref?: string
  /** Redacted, one line. Kept in the file only; /health shows kind + ref. */
  message?: string
}

export interface SweepStatus {
  status: 'running' | 'done' | 'disabled' | 'no-key' | 'cooldown' | 'error' | 'timeout' | 'died'
  trigger: string
  at: string
  /** null while a sweep runs (the previous run's end is cleared, its backlog kept). */
  finishedAt?: string | null
  pid?: number
  pagesWritten: number
  digestsWritten: number
  modelCalls: number
  costUsd: number
  /** True when the per-run cap or time budget stopped the run with work left. */
  capHit?: boolean
  errors: SweepError[]
  /** Unwritten work left after this run: eligible periods, past days with undigested short chats, and today's short chats (digested tomorrow). */
  backlog?: { periods: number; digestDays: number; todayChats: number }
  /** Outcome of the last per-session Library step (session end / compaction), from the worker itself. */
  lastStep?: { at: string; session: string; status: string; period?: number; costUsd: number }
  /** Last failure of ANY Library worker (crash, or a session-end page that failed). */
  workerError?: { at: string; kind: string; ref?: string; message?: string }
}

export function readSweepStatus(home = libraryHomeDir()): SweepStatus | null {
  try {
    const s = JSON.parse(readFileSync(join(home, SWEEP_STATUS_FILE), 'utf-8')) as SweepStatus
    if (!s || typeof s !== 'object') return null
    // "running" with no live process: the worker crashed or was killed before writing its result.
    if (s.status === 'running' && s.pid) {
      try {
        process.kill(s.pid, 0)
      } catch (e: any) {
        if (e?.code === 'ESRCH') return { ...s, status: 'died' }
      }
    }
    return s
  } catch {
    return null
  }
}

/**
 * Merge `patch` into the status file (atomic). Only the patch's own fields change: the sweep and a
 * session-end worker write different fields of the same file, so the read-merge-write runs under a
 * short exclusive lock (withFileLock) and never loses the other's
 * fields. Never throws.
 */
export function writeSweepStatus(patch: Partial<SweepStatus>, home = libraryHomeDir()): void {
  const path = join(home, SWEEP_STATUS_FILE)
  const merge = () => {
    let prev: Partial<SweepStatus> = {}
    try {
      prev = JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
      /* first write */
    }
    // Only the fields the patch sets: an undefined one never wipes the previous value (e.g. the backlog while a sweep runs).
    const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
    const next = { ...prev, ...set, errors: (patch.errors ?? prev.errors ?? []).slice(0, 20) }
    writePrivateAtomic(path, JSON.stringify(next, null, 2) + '\n')
  }
  try {
    mkdirSync(home, { recursive: true })
    if (!withFileLock(`${path}.lock`, merge, 10)) merge() // lock still held: write anyway, the status is best-effort
  } catch {
    /* status is best-effort */
  }
}

/** A sweep does not start within this long of the last one finishing (agent start and every session end launch one). */
export const SWEEP_COOLDOWN_MS = 30 * 60_000

/**
 * True while the last sweep ended (done, timeout, error or died) less than `cooldownMs` ago,
 * measured from its finishedAt, else its start (a sweep that died never wrote finishedAt).
 */
export function sweepCoolingDown(cooldownMs = SWEEP_COOLDOWN_MS, home = libraryHomeDir()): boolean {
  const s = readSweepStatus(home)
  if (!s || !['done', 'timeout', 'error', 'died'].includes(s.status)) return false
  const at = Date.parse(s.finishedAt ?? s.at)
  return Number.isFinite(at) && Date.now() - at < cooldownMs
}

// ── Live sessions, as the agent sees them now (read by a running sweep before each page) ──

const LIVE_FILE = 'live-sessions.json'
let lastLive = ''

/** Record the live session ids for running sweeps. Rewritten only when the list changes (or to refresh its age). Never throws. */
export function writeLiveSessions(ids: string[], home = libraryHomeDir()): void {
  const list = [...new Set(ids.filter(Boolean))].sort()
  const key = list.join(',')
  const path = join(home, LIVE_FILE)
  try {
    const fresh = Date.now() - statSync(path).mtimeMs < 60_000
    if (key === lastLive && fresh) return
  } catch {
    /* not written yet */
  }
  try {
    mkdirSync(home, { recursive: true })
    writePrivateAtomic(path, JSON.stringify({ at: new Date().toISOString(), ids: list }) + '\n')
    lastLive = key
  } catch {
    /* best-effort */
  }
}

/** Live session ids the agent wrote within `maxAgeMs`, else null (no agent, or a stale file). */
export function readLiveSessions(maxAgeMs = 3 * 60_000, home = libraryHomeDir()): string[] | null {
  try {
    const path = join(home, LIVE_FILE)
    if (Date.now() - statSync(path).mtimeMs > maxAgeMs) return null
    const o = JSON.parse(readFileSync(path, 'utf-8'))
    return Array.isArray(o?.ids) ? o.ids.map(String) : null
  } catch {
    return null
  }
}
