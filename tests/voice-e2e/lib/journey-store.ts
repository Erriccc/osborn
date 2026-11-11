/**
 * JOURNEY STORE — durable journey/run state so a mid-journey engine RESTART
 * does not silently lose the journey (#120).
 *
 * Background (#120): the engine's `journey` object and its `RUN_STAMP` run id
 * live ONLY in process memory. A restart — crash / OOM / Fly machine recycle,
 * observed most visibly at the Say step, where Fly's edge proxy returns an
 * EMPTY 502 as the dying process drops the connection — starts a fresh process
 * that re-stamps the run id and reconstructs `journey` as null. The caller then
 * reads `/status` → journey null, tabs reset, taskCount 0, and `/journey end`
 * → 400 "no journey in progress". The restart is silent and destructive.
 *
 * This module persists the active journey to a VOLUME-DURABLE file (the same
 * durability guarantee the engine already relies on for tab-state restore
 * across sleep) and decides, on the next boot, whether a persisted journey
 * should be ADOPTED by the new process — turning a silent, destructive restart
 * into a visible, recoverable one that keeps run-id continuity (previousRun).
 *
 * DESIGN: this file has ZERO imports on purpose. All logic here is pure and
 * synchronously testable (no fs, no browser, no volume) — the thin file I/O
 * wrappers live in session-engine.ts, which already imports `fs`. Keeping the
 * decision logic pure is what lets the unit tests cover run-id continuity and
 * the transient-502 retry discriminator without standing up an engine.
 */

/** The in-memory journey shape the engine owns, trimmed to what survives a restart. */
export interface PersistedJourney {
  name: string
  goal?: string
  owner?: string
  startUrl: string
  startedAt: number
}

/** The on-disk journey-state record (journey-state.json in the results dir). */
export interface JourneyStateFile {
  schema: 1
  /** The RUN_STAMP of the process that last wrote this record. */
  run: string
  /** 'active' while a journey is in progress; 'ended' after /journey end. */
  status: 'active' | 'ended'
  journey: PersistedJourney
  /** Progress markers so a recovered journey can point a caller at prior work. */
  lastTaskN: number
  tasksStamped: number
  updatedAt: number
}

export interface RecoveryOptions {
  now: number
  /** The NEW process's run id — recorded so continuity (old → new) is explicit. */
  currentRun: string
  /**
   * Don't resurrect a journey older than this. Defaults to the engine's mission
   * cap (2h) so recovery never outlives the idle-stop hold-awake window.
   */
  maxAgeMs?: number
}

export interface RecoveryDecision {
  recover: boolean
  reason: string
  journey?: PersistedJourney
  /** The run id the journey was last persisted under (for previousRun linkage). */
  previousRun?: string
  ageMs?: number
}

/** The engine's mission cap (2h) — a recovered journey older than this is dropped. */
export const DEFAULT_RECOVERY_MAX_AGE_MS = 2 * 60 * 60 * 1000

/**
 * Build the on-disk record for the CURRENT process. `run` is always the new
 * process's run id, so each save re-homes the journey under the live run —
 * that is the run-id continuity chain (a second restart recovers from the most
 * recent run, with previousRun pointing one hop back).
 */
export function buildJourneyState(
  run: string,
  status: 'active' | 'ended',
  journey: PersistedJourney,
  lastTaskN: number,
  tasksStamped: number,
  now: number,
): JourneyStateFile {
  return { schema: 1, run, status, journey, lastTaskN, tasksStamped, updatedAt: now }
}

/**
 * Decide, on boot, whether a persisted journey should be adopted by the new
 * process. Recover only an ACTIVE journey that is still within the age cap;
 * an already-ended or stale record is ignored (a fresh start proceeds normally).
 */
export function decideRecovery(
  persisted: JourneyStateFile | null | undefined,
  opts: RecoveryOptions,
): RecoveryDecision {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_RECOVERY_MAX_AGE_MS
  if (!persisted || persisted.schema !== 1 || !persisted.journey) {
    return { recover: false, reason: 'no persisted journey' }
  }
  if (persisted.status !== 'active') {
    return { recover: false, reason: 'journey already ended' }
  }
  const ageMs = opts.now - persisted.updatedAt
  if (!(ageMs >= 0)) {
    // Clock skew / corrupt timestamp — treat as fresh (age 0) rather than drop.
    return { recover: true, reason: 'active journey (clock skew — adopting)', journey: persisted.journey, previousRun: persisted.run, ageMs: 0 }
  }
  if (ageMs > maxAgeMs) {
    return { recover: false, reason: `stale — ${Math.round(ageMs / 60000)}min old, past the ${Math.round(maxAgeMs / 60000)}min cap`, ageMs }
  }
  return { recover: true, reason: 'active journey within cap — adopting across restart', journey: persisted.journey, previousRun: persisted.run, ageMs }
}

/**
 * RETRY DISCRIMINATOR for the Say step (#120). Distinguish a TRANSIENT gateway
 * failure (the engine process dropped the connection mid-request — Fly returns
 * an empty-body 502/503/504, or the socket resets with no HTTP status) from an
 * APPLICATION failure that the engine itself reported with a structured body
 * (e.g. { ok:false, code:'speak_failed' } or 'no_mic'). Only the former is
 * worth retrying / re-attaching; retrying a structured app error just repeats a
 * settled failure (the engine already retries the in-page speak internally).
 *
 * @param status HTTP status (0/NaN/undefined = no response / connection reset)
 * @param body   parsed JSON body if any, else the raw string, else null
 */
export function isTransientSayFailure(status: number | undefined | null, body: unknown): boolean {
  // No HTTP status at all → socket reset / connection refused → transient.
  if (status == null || Number.isNaN(status) || status === 0) return true
  if (status !== 502 && status !== 503 && status !== 504) return false
  // A gateway status WITH the engine's structured error is still an app failure
  // the engine chose to surface (speak_failed / no_mic) — do not retry.
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (b.ok === false && typeof b.code === 'string') return false
    // Any other non-empty JSON object from the engine → treat as app response.
    if (Object.keys(b).length > 0) return false
  }
  if (typeof body === 'string' && body.trim().length > 0) {
    // A non-JSON gateway page ("502 Bad Gateway") is the restart signature.
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      if (parsed && parsed.ok === false && typeof parsed.code === 'string') return false
      if (parsed && Object.keys(parsed).length > 0) return false
    } catch {
      // Not JSON → gateway/empty-ish body → transient.
    }
  }
  return true
}

/**
 * Bounded exponential backoff for the in-process Say retry: base * 2^(n-1),
 * capped. (The caller-side re-attach after a full restart polls /status for the
 * engine to wake; this delay is for transient in-process speak glitches.)
 */
export function retryDelayMs(attempt: number, baseMs = 1000, capMs = 8000): number {
  if (attempt <= 1) return baseMs
  return Math.min(capMs, baseMs * Math.pow(2, attempt - 1))
}
