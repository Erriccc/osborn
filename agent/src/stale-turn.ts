/**
 * Stale-turn rule (#456). A barge-in only makes the cut-off turn stale once the
 * pipeline consumes the interruption context (it then interrupts the turn, so
 * its late text blocks must not play over the reply). A barge-in that never
 * becomes a turn (side talk, a phone voice action) leaves the turn live.
 * One id is enough: ids never repeat and a stale turn ends before the next
 * one is marked. Blocks without a messageId always pass.
 */
export function staleIdOnConsume(
  ctx: { spokenText: string; messageId?: string } | null,
  current: string | null,
): string | null {
  return ctx && ctx.spokenText && ctx.messageId ? ctx.messageId : current
}

/** Stale when the turn was consumed as interrupted (#456) or retired by a successful interrupt (#539 D). */
export function isStaleBlock(
  staleId: string | null,
  messageId?: string | null,
  isRetired: (id: string) => boolean = () => false,
): boolean {
  return !!messageId && (messageId === staleId || isRetired(messageId))
}

/**
 * Text heard of a block when only `chars` characters are known to have played:
 * cut at the last space at or before `chars`, or at `chars` when the first word is longer.
 */
export function heardSlice(text: string, chars: number): string {
  const n = Math.max(0, Math.min(Math.round(chars), text.length))
  const i = text.lastIndexOf(' ', n)
  return text.slice(0, i > 0 ? i : n) || text  // nothing measurable played: a cut still counts as an interruption
}

/**
 * Turn ids retired by a successful interrupt (#539 D). The SDK may emit no
 * `result` for an interrupted turn, so its id would otherwise name the next
 * reply and the gate would drop every block of it. Leftover blocks keep the
 * retired id (dropped); the next pushed user message gets a fresh one.
 */
export function currentIdOnPush(retired: Set<string>, current: string | null): string | null {
  return current && retired.has(current) ? null : current
}

/** Buffered reply text and the interruption context both expire after this (#539 A). */
const SUPPRESSED_MAX_AGE_MS = 60_000
export const isExpired = (timestamp: number, now: number): boolean => now - timestamp > SUPPRESSED_MAX_AGE_MS
const MAX_REPLAY_REARMS = 5

type ReplayInput = {
  hasSession: boolean
  userListening: boolean
  sameInterruption: boolean   // lastInterruption is still the object captured when the timer armed
  hasText: boolean
  agentSpeaking: boolean
  gateTriaging: boolean       // the noise gate holds a barge-in utterance: its turn will consume the text
}

/**
 * Suppressed-text replay (#539 A). Speak when the user stayed quiet and no new
 * turn took the text, even while the agent is 'thinking'. Not while the gate
 * triages or the agent speaks: those re-arm (bounded) instead of giving up.
 */
function replayStep(i: ReplayInput & { expired: boolean; attempts: number }):
  { act: 'speak' } | { act: 'expire' } | { act: 'rearm'; reason: string } | { act: 'skip'; reason: string } {
  if (!i.hasSession) return { act: 'skip', reason: 'no session' }
  if (!i.userListening) return { act: 'skip', reason: 'user speaking' }
  if (!i.sameInterruption) return { act: 'skip', reason: 'replaced or consumed by a new turn' }
  if (!i.hasText) return { act: 'skip', reason: 'nothing buffered' }
  if (i.expired) return { act: 'expire' }
  const busy = i.gateTriaging ? 'speech hold or noise gate' : i.agentSpeaking ? 'agent speaking' : ''
  if (busy) return i.attempts < MAX_REPLAY_REARMS ? { act: 'rearm', reason: busy } : { act: 'skip', reason: `${busy}, gave up` }
  return { act: 'speak' }
}

/**
 * One buffered reply block (#549). Each block keeps its own turn id and its
 * first-buffered time: an append never rewrites another block's provenance or
 * age, so retired text is never spoken and old text always ages out.
 */
export type SuppressedBlock = { text: string; turnId?: string; at: number }
type Pending = { suppressedBlocks: SuppressedBlock[]; timestamp: number }
type Buffered = Pending & { spokenText: string; recentMessages: string }
/** A context that holds only buffered reply blocks: nothing was heard, nothing else to fold in. */
const bufferOnly = (suppressedBlocks: SuppressedBlock[], timestamp: number): Buffered =>
  ({ spokenText: '', recentMessages: '', suppressedBlocks, timestamp })
export const joinBlocks = (blocks: SuppressedBlock[]): string => blocks.map((b) => b.text).join('\n')
export const totalChars = (blocks: SuppressedBlock[]): number => joinBlocks(blocks).length
/** Blocks younger than the max age, measured from each block's own first-buffered time. */
export const liveBlocks = (blocks: SuppressedBlock[], now: number): SuppressedBlock[] => blocks.filter((b) => !isExpired(b.at, now))
/** Characters in the blocks past the max age: reply text that will never be spoken. */
export const expiredChars = (blocks: SuppressedBlock[], now: number): number => totalChars(blocks.filter((b) => isExpired(b.at, now)))
const earliest = (blocks: SuppressedBlock[], fallback: number): number => blocks.length ? Math.min(...blocks.map((b) => b.at)) : fallback

/** Add a block after the existing ones; the others are untouched, a missing id stays missing. */
export function appendBlock<T extends Pending>(li: T | null, text: string, turnId: string | undefined, now: number): T | Buffered {
  const block: SuppressedBlock = { text, turnId, at: now }
  return li ? { ...li, suppressedBlocks: [...li.suppressedBlocks, block] } : bufferOnly([block], now)
}

/**
 * Split buffered blocks for a replay: speak the live ones of turns that are not
 * stale or retired (a block with no id counts as live), keep the stale or retired
 * ones buffered (the next prompt still tells the agent they went unheard, never spoken),
 * drop the expired ones.
 */
export function partitionForReplay(
  blocks: SuppressedBlock[], now: number, isStale: (turnId?: string) => boolean,
): { speak: SuppressedBlock[]; keep: SuppressedBlock[]; expired: number } {
  const speak: SuppressedBlock[] = [], keep: SuppressedBlock[] = []
  let expired = 0
  for (const b of blocks) {
    if (isExpired(b.at, now)) expired++
    else if (isStale(b.turnId)) keep.push(b)
    else speak.push(b)
  }
  return { speak, keep, expired }
}

type ReplayDeps<C extends Pending> = {
  current(): C | null
  userListening(): boolean
  inputs(captured: C): Omit<ReplayInput, 'userListening'>
  speak(): void
  expire(): void
  log(msg: string): void
  now?: () => number
  delayMs?: number
}

/**
 * The replay timer (#539 A): arm on each transition to 'listening', cancel on
 * 'speaking' (a flap resets the window), re-arm while the gate or the agent is busy.
 */
export class ReplayScheduler<C extends Pending> {
  #timer: ReturnType<typeof setTimeout> | null = null
  #attempts = 0
  constructor(private d: ReplayDeps<C>) {}
  cancel() { if (this.#timer) { clearTimeout(this.#timer); this.#timer = null } }
  arm(fresh = true) {
    this.cancel()
    if (fresh) this.#attempts = 0
    const captured = this.d.current()
    if (!captured?.suppressedBlocks.length || !this.d.userListening()) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      const step = replayStep({
        ...this.d.inputs(captured),
        userListening: this.d.userListening(),
        expired: liveBlocks(captured.suppressedBlocks, (this.d.now ?? Date.now)()).length === 0,
        attempts: this.#attempts,
      })
      if (step.act === 'speak') this.d.speak()
      else if (step.act === 'expire') this.d.expire()
      else if (step.act === 'rearm') { this.#attempts++; this.d.log(`REPLAY WAITING ${totalChars(captured.suppressedBlocks)} chars (${step.reason}, retry ${this.#attempts})`); this.arm(false) }
      else this.d.log(`REPLAY SKIPPED ${totalChars(captured.suppressedBlocks)} chars (${step.reason})`)
    }, this.d.delayMs ?? 1200)
  }
}

/**
 * The replay timer found every buffered block expired (#549): drop only the blocks
 * while a heard context under 60s old waits for the turn that consumes it, else clear.
 */
export function expireDecision(li: Buffered | null, now: number): 'clear' | 'drop-blocks' | 'keep' {
  if (!li || liveBlocks(li.suppressedBlocks, now).length) return 'keep'
  return li.spokenText && !isExpired(li.timestamp, now) ? 'drop-blocks' : 'clear'
}

/** Pending blocks to speak ahead of a newer block (#539 B), and the context left once they are taken. */
export function takePending<T extends Pending>(li: T | null): { blocks: SuppressedBlock[]; rest: T | null } {
  return li?.suppressedBlocks.length ? { blocks: li.suppressedBlocks, rest: { ...li, suppressedBlocks: [] } } : { blocks: [], rest: li }
}

/**
 * An uninterrupted say finished (#539 C): the old interruption context is done,
 * but blocks buffered after the say started were not covered by it and stay pending.
 */
export function settleAfterSay(li: Buffered | null): Buffered | null {
  return li?.suppressedBlocks.length ? bufferOnly(li.suppressedBlocks, earliest(li.suppressedBlocks, li.timestamp)) : null
}

/**
 * A replayed say was cut off before it was heard (#539 B): its blocks go back in
 * front of anything buffered since, each with its original age and turn id, so the
 * next chat() folds them into the prompt. Expired blocks are not put back.
 */
export function putBack<T extends Buffered>(li: T | null, blocks: SuppressedBlock[], now: number): T | Buffered | null {
  const live = liveBlocks(blocks, now)
  if (!live.length) return li
  if (!li) return bufferOnly(live, earliest(live, now))
  const merged = [...live, ...li.suppressedBlocks].sort((a, b) => a.at - b.at)  // stable: equal times keep put-back first
  return { ...li, suppressedBlocks: merged }  // timestamp is the heard context's own age: blocks never shift it
}
