/**
 * agent-health.ts — pure helpers that turn the REAL signals the frontend already
 * receives into an honest "can this session actually answer?" health state
 * (issue #87, gap 3: silent version/key failures).
 *
 * Two silent-failure classes this surfaces, from signals already on the wire:
 *
 *   1. VERSION FLOOR — the demo-model fallback (z.ai GLM house pass) was added in
 *      osborn 0.9.269. A machine on an older agent has the z.ai key set but
 *      silently ignores it (observed on the chizitere@muse.ai test account, which
 *      ran 0.9.268). The running version already rides GET /health → { version }
 *      and is polled by VoiceRoom for the model badge — so the frontend can
 *      compare it against the floor and say "this machine needs an update to use
 *      the demo model" instead of showing a dead session.
 *
 *   2. KEY HEALTH — the active fallback's self-test result (ok / failed / expired),
 *      from the one tiny real request the agent fires after the session starts and
 *      serves on GET /health alongside `provider`. This helper never fabricates a
 *      status: an absent or inconclusive `keyHealth` simply yields no key notice.
 *
 * Everything here is pure (no React, no fetch) so the state machine is unit-tested
 * in agent-health.test.ts.
 */

/**
 * First osborn release whose agent applies the demo-model fallback
 * (agent/src/claude-auth.ts applyAuthFallback → z.ai house pass / OpenRouter).
 * A machine older than this cannot run on the house tier no matter what key is
 * configured, so a no-Claude account there is a dead end until it updates.
 */
export const FALLBACK_VERSION_FLOOR = '0.9.269'

/**
 * Compare two dotted numeric version strings (e.g. '0.9.268' vs '0.9.269').
 * Returns <0 if a<b, 0 if equal, >0 if a>b. Missing trailing parts count as 0,
 * and any non-numeric/blank input is treated as "unknown" → returns 0 (callers
 * must gate on a known version separately; an unknown version never trips a
 * floor warning on its own). A leading 'v' is tolerated.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] | null => {
    if (typeof v !== 'string') return null
    const s = v.trim().replace(/^v/i, '')
    if (!s) return null
    const parts = s.split('.').map((p) => Number.parseInt(p, 10))
    // Any non-numeric segment → not a comparable version.
    if (parts.some((n) => Number.isNaN(n))) return null
    return parts
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return 0
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/**
 * True when a KNOWN running version is strictly below the fallback floor.
 * An unknown/blank version returns false — we never warn on a version we
 * couldn't read (older agents that omit it from /health are handled by the
 * caller, which only treats this as actionable alongside a no-Claude session).
 */
export function isBelowFallbackFloor(version: unknown, floor: string = FALLBACK_VERSION_FLOOR): boolean {
  if (typeof version !== 'string' || !version.trim()) return false
  return compareSemver(version, floor) < 0
}

/** A single fallback key's self-test result (agent-emitted; see module header). */
export interface KeyHealthEntry {
  /** Provider key, e.g. 'zai' | 'openrouter' | 'anthropic'. */
  provider: string
  /** Outcome of the tiny real request the agent made at start. */
  status: 'ok' | 'failed' | 'expired'
}

export type AgentHealthLevel = 'ok' | 'version-floor' | 'keys-failed'

export interface AgentHealthView {
  /** 'ok' → nothing to surface; anything else → show the notice. */
  level: AgentHealthLevel
  /** Short pill label, e.g. "Update needed". Null when level === 'ok'. */
  label: string | null
  /** Full tooltip / inline explanation + next action. */
  title: string
  /** Convenience: whether the caller should render a notice at all. */
  show: boolean
}

export interface AgentHealthInput {
  /** GET /health → version (the running osborn release). */
  version?: unknown
  /**
   * The session is relying on a configured fallback rather than a real Claude
   * login — i.e. the agent asked for Claude sign-in at least once this session
   * (VoiceRoom's `claudeAuthEverRequired`). It is sticky — a mid-session sign-in
   * never clears it — so `mainProvider` below has the last word.
   */
  relyingOnFallback?: boolean
  /**
   * The tier the agent says it is actually answering on (GET /health → provider,
   * seeded by agent_ready.provider). The house demo tiers ('zai' / 'openrouter')
   * imply the fallback path even when the auth modal never opened; 'claude' or
   * the user's own 'anthropic' key means the demo tier's health is irrelevant,
   * whatever the modal did earlier in the session.
   */
  mainProvider?: string | null
  /** The active tier's self-test result(s) from GET /health (absent = no verdict). */
  keyHealth?: KeyHealthEntry[]
  /** The fallback version floor (overridable for tests). */
  floor?: string
}

const OK: AgentHealthView = { level: 'ok', label: null, title: '', show: false }

/**
 * Resolve the agent-health notice from the real signals. Ordered by severity:
 * a version floor breach (the fallback literally can't run) outranks a failed
 * key test. Returns the neutral OK view when there is nothing honest to say —
 * never invents a problem.
 */
export function resolveAgentHealth(input: AgentHealthInput): AgentHealthView {
  const floor = input.floor || FALLBACK_VERSION_FLOOR
  const provider = String(input.mainProvider || '').trim().toLowerCase()

  // Only surface fallback-health problems to a user who is actually on the
  // fallback path. A Claude-connected session is not blocked by the demo tier —
  // including one that signed in mid-session, which is why a declared
  // claude/anthropic provider overrules the sticky "sign-in was asked" flag.
  if (provider === 'claude' || provider === 'anthropic') return OK
  const onHouseTier = provider === 'zai' || provider === 'openrouter'
  if (input.relyingOnFallback !== true && !onHouseTier) return OK

  // 1. Version floor — the most fundamental: no fallback can run at all.
  if (isBelowFallbackFloor(input.version, floor)) {
    const v = typeof input.version === 'string' ? input.version.trim().replace(/^v/i, '') : ''
    return {
      level: 'version-floor',
      label: 'Update needed',
      title:
        `This machine's agent (${v || 'pre-' + floor}) predates the demo model (added in ${floor}), ` +
        `so a configured key is being ignored. Update the machine to start on the demo model, ` +
        `or connect your Claude account.`,
      show: true,
    }
  }

  // 2. Key health — every configured fallback failed its self-test (agent-emitted).
  const keys = Array.isArray(input.keyHealth) ? input.keyHealth : []
  if (keys.length > 0 && keys.every((k) => k && (k.status === 'failed' || k.status === 'expired'))) {
    const names = keys.map((k) => `${k.provider} (${k.status})`).join(', ')
    return {
      level: 'keys-failed',
      label: 'No working model',
      title:
        `No configured model passed its health check: ${names}. The session can't answer until a ` +
        `working key is added or you connect your Claude account.`,
      show: true,
    }
  }

  return OK
}
