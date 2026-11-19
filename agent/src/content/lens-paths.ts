/**
 * lens-paths.ts — LIGHT path + lock helpers shared by the hook-side launcher
 * and the background worker. node: builtins only (safe to import in the live agent).
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

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

/** Monotonic: never moves the mark backwards. Atomic write via rename. */
export function writeHwm(projectDir: string, sessionId: string, lastRowId: number, lastTs?: string): void {
  const all = readHwmFile(projectDir)
  if ((all[sessionId]?.lastRowId ?? 0) >= lastRowId) return
  all[sessionId] = { lastRowId, lastTs, updatedAt: new Date().toISOString() }
  const p = join(projectDir, HWM_FILE)
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
  renameSync(tmp, p)
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
  finishedAt?: string
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

/** Merge `patch` into the status file (atomic). Never throws. */
export function writeSweepStatus(patch: Partial<SweepStatus>, home = libraryHomeDir()): void {
  try {
    mkdirSync(home, { recursive: true })
    let prev: Partial<SweepStatus> = {}
    try {
      prev = JSON.parse(readFileSync(join(home, SWEEP_STATUS_FILE), 'utf-8'))
    } catch {
      /* first write */
    }
    const next = { ...prev, ...patch, errors: (patch.errors ?? prev.errors ?? []).slice(0, 20) }
    const p = join(home, SWEEP_STATUS_FILE)
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, p)
  } catch {
    /* status is best-effort */
  }
}

/** A sweep does not start within this long of the last one finishing (agent start and every session end launch one). */
export const SWEEP_COOLDOWN_MS = 30 * 60_000

/** True while the last sweep finished less than `cooldownMs` ago. */
export function sweepCoolingDown(cooldownMs = SWEEP_COOLDOWN_MS, home = libraryHomeDir()): boolean {
  const s = readSweepStatus(home)
  const at = s?.status === 'done' && s.finishedAt ? Date.parse(s.finishedAt) : NaN
  return Number.isFinite(at) && Date.now() - at < cooldownMs
}
