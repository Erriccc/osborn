/**
 * Meeting multi-participant addressing + mute — scaffolding (OFF by default).
 *
 * WHY THIS EXISTS
 * The comm-layer design (docs: Tier-1 router / Tier-2 workers) and the meeting
 * copilot both want a way, in a multi-speaker room, to (a) address a SPECIFIC
 * named agent ("@researcher, dig into X") rather than just "the bot", and
 * (b) mute a noisy participant so their utterances never reach the LLM. The
 * live meeting path today only does fuzzy single-name matching for "Osborn" and
 * a global interactive/observer latch (see index.ts recall.on('transcript')).
 * There is no per-agent routing and no per-participant mute. This module is the
 * smallest, fully-additive first step toward that runtime.
 *
 * SAFETY CONTRACT
 * - OFF BY DEFAULT. The singleton's `enabled` getter reads
 *   OSBORN_MEETING_ADDRESSING lazily; unless it is exactly 'on'/'1'/'true',
 *   processUtterance() is a pure pass-through: it never drops, never rewrites,
 *   never routes. With the flag unset there is ZERO behavior change.
 * - PURE CORE. parseAddressing / parseMuteCommand / resolveAgent / buildRoster
 *   are pure functions with no I/O, so the regression suite can pin them without
 *   a network or a live meeting.
 * - NO SIDE EFFECTS ON IMPORT. Only a class, some functions, and one singleton
 *   with no timers and no env reads at module load.
 *
 * WHAT IS REAL vs SCAFFOLD
 * - REAL: the addressing parser, the mute command parser, the MuteRegistry, the
 *   flag gate, and the combined processUtterance() verdict object.
 * - SCAFFOLD / NOT WIRED: the verdict's `target` does not yet route the turn to
 *   that Tier-2 worker (that needs the SDK-queue feed described in
 *   docs/multiagent-runtime-plan.md). Today the meeting handler only logs the
 *   verdict behind the flag and honours `drop` for muted speakers.
 */

/** A target that can be addressed in a meeting: the orchestrator or a worker. */
export interface MeetingAgentDef {
  /** Canonical id used for routing, e.g. 'researcher' or 'osborn'. */
  id: string
  /** Human label for logs/UI, e.g. 'Researcher'. */
  label: string
  /** Lowercase tokens (without '@') that resolve to this id. */
  aliases: string[]
}

export type MeetingRoster = MeetingAgentDef[]

/**
 * Default addressable names. 'osborn' is the orchestrator (the main agent /
 * the bot itself); the rest mirror the built-in NAMED_AGENTS worker roster in
 * claude-llm.ts. Kept as a plain list (not an import of NAMED_AGENTS) to avoid
 * coupling this leaf module to the LLM module — the runtime can override at
 * startup via setRoster(Object.keys(NAMED_AGENTS)).
 */
export const DEFAULT_AGENT_NAMES = [
  'osborn',
  'researcher',
  'reasoner',
  'writer',
  'planner',
  'reviewer',
  'tester',
  'steward',
] as const

/** The orchestrator's canonical id — the main agent / "the bot" itself. An
 *  utterance addressed to it is NOT routed to a Tier-2 worker (the orchestrator
 *  already IS the turn's handler); only a NON-orchestrator target is routable. */
export const ORCHESTRATOR_ID = 'osborn'

/**
 * Whether an addressing target should be routed to a specific Tier-2 worker.
 * True only for a concrete, non-orchestrator target. Pure — the single source
 * of the Phase-C routing decision, shared by the meeting handler and the tests
 * so the "@researcher routes, @osborn does not" rule is pinned without a live
 * meeting. Fail-safe: null / undefined / the orchestrator id all return false.
 */
export function isRoutableTarget(target: string | null | undefined): boolean {
  const t = String(target || '').trim().toLowerCase()
  return !!t && t !== ORCHESTRATOR_ID
}

/** Build a roster from a list of agent ids. Aliases default to the id plus a
 * couple of forgiving variants (hyphen/space collapsed). Extra aliases let the
 * caller add room-specific nicknames. Pure. */
export function buildRoster(
  names: readonly string[] = DEFAULT_AGENT_NAMES,
  extraAliases: Record<string, string[]> = {},
): MeetingRoster {
  const seen = new Set<string>()
  const roster: MeetingRoster = []
  for (const raw of names) {
    const id = String(raw || '').trim().toLowerCase()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const aliases = new Set<string>([id, id.replace(/[-_\s]+/g, '')])
    for (const a of extraAliases[id] || []) {
      const t = String(a || '').trim().toLowerCase()
      if (t) aliases.add(t)
    }
    roster.push({ id, label: id.charAt(0).toUpperCase() + id.slice(1), aliases: [...aliases] })
  }
  return roster
}

/** Resolve a single token (with or without a leading '@') to a canonical agent
 * id, or null if nothing in the roster matches. Case-insensitive. Pure. */
export function resolveAgent(token: string, roster: MeetingRoster): string | null {
  const t = String(token || '').trim().toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9_-]/g, '')
  if (!t) return null
  for (const a of roster) if (a.id === t || a.aliases.includes(t)) return a.id
  return null
}

export interface AddressingResult {
  /** Canonical agent id addressed, or null if the turn addresses no one specific. */
  target: string | null
  /** The utterance with the matched addressing token removed (whitespace tidied).
   *  Equals the input when there was no match. NEVER a paraphrase — only the
   *  single addressing token is stripped. */
  cleanedText: string
  /** The raw token that matched (for logging), e.g. '@researcher'. */
  token?: string
}

// '@name' mention anywhere in the utterance. The capture excludes the '@'.
const MENTION_RE = /@([a-z0-9][a-z0-9_-]*)/i
// Leading direct address: "researcher, ..." or "researcher: ..." at the start.
const LEADING_RE = /^\s*([a-z][a-z0-9_-]*)\s*[,:]\s+/i

/**
 * Parse @-addressing out of an utterance. Resolution order:
 *   1. The first '@mention' whose token resolves in the roster.
 *   2. Otherwise a leading "<alias>," / "<alias>:" address, only if the alias
 *      resolves in the roster (so plain sentences like "So, let's..." are NOT
 *      treated as addressing).
 * Returns the resolved target (or null) and the utterance with just that one
 * addressing token removed. Pure — no state, no I/O.
 */
export function parseAddressing(text: string, roster: MeetingRoster): AddressingResult {
  const input = String(text ?? '')
  if (!input.trim()) return { target: null, cleanedText: input }

  const m = input.match(MENTION_RE)
  if (m) {
    const target = resolveAgent(m[1], roster)
    if (target) {
      const token = m[0]
      const cleanedText = input.replace(token, ' ').replace(/\s{2,}/g, ' ').trim()
      return { target, cleanedText, token }
    }
    // An '@token' that is NOT a known agent is left untouched (could be a handle,
    // an email fragment, etc.) — fall through to the leading-address check.
  }

  const lead = input.match(LEADING_RE)
  if (lead) {
    const target = resolveAgent(lead[1], roster)
    if (target) {
      const token = lead[0]
      const cleanedText = input.slice(token.length).trim()
      return { target, cleanedText, token: lead[1] }
    }
  }

  return { target: null, cleanedText: input }
}

export interface MuteCommand {
  action: 'mute' | 'unmute' | null
  /** Lowercased participant name, '*' for everyone, or null when none parsed. */
  who: string | null
}

// "mute <name>" / "unmute <name>" / "mute everyone|all|me", optionally with a
// short polite lead ("please mute Daniel"). The <name> is 1-2 words.
const MUTE_RE = /^(?:(?:can|could|would) you\s+|please\s+)?(mute|unmute)\s+(everyone|everybody|all|me|[a-z][a-z0-9'._-]*(?:\s+[a-z][a-z0-9'._-]*)?)\s*$/i

/**
 * Parse an explicit mute/unmute command from an utterance. Conservative: the
 * command must LEAD the utterance (after an optional "please"/"can you" lead)
 * and name a target, so ordinary sentences that merely contain the word "mute"
 * mid-speech don't trigger it. Pure. Returns { action: null, who: null } when
 * nothing matches.
 */
export function parseMuteCommand(text: string): MuteCommand {
  const t = String(text ?? '').trim().replace(/\s+(please|now|thanks)\.?\s*$/i, '')
  const m = t.match(MUTE_RE)
  if (!m) return { action: null, who: null }
  const action = m[1].toLowerCase() as 'mute' | 'unmute'
  const rawWho = m[2].trim().toLowerCase()
  const who = /^(everyone|everybody|all)$/.test(rawWho) ? '*' : rawWho.replace(/[.,!?]+$/, '')
  return { action, who: who || null }
}

/** Case-insensitive set of muted participant names, plus a global mute-all flag. */
export class MuteRegistry {
  #muted = new Set<string>()
  #all = false

  mute(who: string): void {
    const w = String(who || '').trim().toLowerCase()
    if (!w) return
    if (w === '*') { this.#all = true; return }
    this.#muted.add(w)
  }

  unmute(who: string): void {
    const w = String(who || '').trim().toLowerCase()
    if (!w) return
    if (w === '*') { this.#all = false; this.#muted.clear(); return }
    this.#muted.delete(w)
  }

  isMuted(name: string): boolean {
    const n = String(name || '').trim().toLowerCase()
    if (!n) return false
    if (this.#muted.has(n)) return true
    // mute-all applies to everyone EXCEPT names explicitly carved out is not a
    // feature yet; '*' simply mutes all participants.
    return this.#all
  }

  list(): string[] {
    return this.#all ? ['*', ...[...this.#muted].sort()] : [...this.#muted].sort()
  }

  clear(): void {
    this.#muted.clear()
    this.#all = false
  }
}

export interface UtteranceVerdict {
  /** Whether the addressing/mute layer was active (flag on) for this utterance. */
  gated: boolean
  /** True when the speaker is muted and the utterance should NOT reach the LLM. */
  drop: boolean
  /** Canonical agent id the utterance addresses, or null. */
  target: string | null
  /** Utterance with any addressing token stripped (verbatim otherwise). */
  cleanedText: string
  /** Set when this utterance was itself a mute/unmute command that was applied. */
  muteChanged?: { action: 'mute' | 'unmute'; who: string }
}

/**
 * Singleton meeting-addressing layer. One per agent process (one meeting at a
 * time per machine), mirroring the noiseGate singleton pattern. Stateful only
 * in the MuteRegistry and the (overridable) roster.
 */
class MeetingAddressing {
  #roster: MeetingRoster = buildRoster()
  readonly mutes = new MuteRegistry()

  /** OFF unless OSBORN_MEETING_ADDRESSING is on/1/true. Read lazily so ops can
   *  flip it at runtime without a republish (same discipline as noiseGate). */
  get enabled(): boolean {
    const v = String(process.env.OSBORN_MEETING_ADDRESSING || '').trim().toLowerCase()
    return v === 'on' || v === '1' || v === 'true'
  }

  get roster(): MeetingRoster {
    return this.#roster
  }

  /** Canonical ids of the addressable roster (for emitting to the frontend). */
  get rosterIds(): string[] {
    return this.#roster.map((a) => a.id)
  }

  /**
   * Apply an out-of-band mute/unmute control (e.g. a `mute_participant` message
   * from the frontend) to the registry. Normalizes the name the same way voice
   * commands do (lowercase/trim; everyone|everybody|all → '*') and returns the
   * applied change for emission, or null when nothing valid was given. Pure of
   * I/O — only mutates the registry — so the control path is testable without a
   * live room or the data channel.
   */
  applyMuteControl(action: 'mute' | 'unmute', who: string): { action: 'mute' | 'unmute'; who: string } | null {
    const raw = String(who || '').trim().toLowerCase()
    if (!raw) return null
    const target = /^(everyone|everybody|all)$/.test(raw) ? '*' : raw
    if (action === 'mute') this.mutes.mute(target)
    else this.mutes.unmute(target)
    return { action, who: target }
  }

  /** Snapshot of the addressing/mute layer for the frontend meeting_state msg. */
  state(): { enabled: boolean; roster: string[]; muted: string[] } {
    return { enabled: this.enabled, roster: this.rosterIds, muted: this.mutes.list() }
  }

  /** Override the addressable roster, e.g. from Object.keys(NAMED_AGENTS) at
   *  startup, or from per-user named agents. */
  setRoster(names: readonly string[], extraAliases?: Record<string, string[]>): void {
    this.#roster = buildRoster(names, extraAliases)
  }

  /** Reset per-meeting state (call on leave_meeting / session switch). */
  reset(): void {
    this.mutes.clear()
  }

  /**
   * The combined per-utterance verdict. PURE PASS-THROUGH when disabled:
   * returns the input verbatim with drop=false, target=null. When enabled it
   * (1) applies any mute/unmute command FIRST (so a muted speaker can still
   * unmute themselves), (2) decides drop from the mute registry, and
   * (3) parses @-addressing. It NEVER paraphrases — cleanedText only ever has a
   * single addressing token removed.
   */
  processUtterance(speaker: string, text: string): UtteranceVerdict {
    if (!this.enabled) {
      return { gated: false, drop: false, target: null, cleanedText: String(text ?? '') }
    }

    let muteChanged: UtteranceVerdict['muteChanged']
    const cmd = parseMuteCommand(text)
    if (cmd.action && cmd.who) {
      // "mute me" / "unmute me" resolve to the current speaker.
      const who = cmd.who === 'me' ? String(speaker || '').trim().toLowerCase() : cmd.who
      if (who) {
        if (cmd.action === 'mute') this.mutes.mute(who)
        else this.mutes.unmute(who)
        muteChanged = { action: cmd.action, who }
      }
    }

    const drop = this.mutes.isMuted(speaker)
    const addr = parseAddressing(text, this.#roster)
    return {
      gated: true,
      drop,
      target: addr.target,
      cleanedText: addr.cleanedText,
      ...(muteChanged ? { muteChanged } : {}),
    }
  }
}

/** Process-wide singleton (no side effects on import). */
export const meetingAddressing = new MeetingAddressing()
