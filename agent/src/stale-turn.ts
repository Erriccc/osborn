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

export function isStaleBlock(staleId: string | null, messageId?: string | null): boolean {
  return !!messageId && messageId === staleId
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

/** Stale when the turn was consumed as interrupted (#456) or retired by a successful interrupt. */
export function isStaleOrRetired(
  staleId: string | null,
  isRetired: (id: string) => boolean,
  messageId?: string | null,
): boolean {
  return isStaleBlock(staleId, messageId) || (!!messageId && isRetired(messageId))
}

/** Buffered reply text and the interruption context both expire after this (#539 A). */
const SUPPRESSED_MAX_AGE_MS = 60_000
export const isExpired = (timestamp: number, now: number): boolean => now - timestamp > SUPPRESSED_MAX_AGE_MS
export const MAX_REPLAY_REARMS = 5

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
export function replayStep(i: ReplayInput & { expired: boolean; attempts: number }):
  { act: 'speak' } | { act: 'expire' } | { act: 'rearm'; reason: string } | { act: 'skip'; reason: string } {
  if (!i.hasSession) return { act: 'skip', reason: 'no session' }
  if (!i.userListening) return { act: 'skip', reason: 'user speaking' }
  if (!i.sameInterruption) return { act: 'skip', reason: 'replaced or consumed by a new turn' }
  if (!i.hasText) return { act: 'skip', reason: 'nothing buffered' }
  if (i.expired) return { act: 'expire' }
  const busy = i.gateTriaging ? 'noise gate triaging' : i.agentSpeaking ? 'agent speaking' : ''
  if (busy) return i.attempts < MAX_REPLAY_REARMS ? { act: 'rearm', reason: busy } : { act: 'skip', reason: `${busy}, gave up` }
  return { act: 'speak' }
}

type Pending = { suppressedText: string; timestamp: number; suppressedTurnId?: string }
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
    if (!captured?.suppressedText || !this.d.userListening()) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      const step = replayStep({
        ...this.d.inputs(captured),
        userListening: this.d.userListening(),
        expired: isExpired(captured.timestamp, (this.d.now ?? Date.now)()),
        attempts: this.#attempts,
      })
      if (step.act === 'speak') this.d.speak()
      else if (step.act === 'expire') this.d.expire()
      else if (step.act === 'rearm') { this.#attempts++; this.d.log(`REPLAY WAITING (${step.reason}, retry ${this.#attempts})`); this.arm(false) }
      else this.d.log(`REPLAY SKIPPED (${step.reason})`)
    }, this.d.delayMs ?? 1200)
  }
}

/** Pending text to speak ahead of a newer block (#539 B), and the context left once it is spoken. */
export function takePending<T extends Pending>(li: T | null): { text: string; rest: T | null } {
  return li?.suppressedText ? { text: li.suppressedText, rest: { ...li, suppressedText: '' } } : { text: '', rest: li }
}

/**
 * An uninterrupted say finished (#539 C): the old interruption context is done,
 * but text buffered after the say started was not covered by it and stays pending.
 */
export function settleAfterSay(li: (Pending & { spokenText: string; recentMessages: string }) | null) {
  return li?.suppressedText
    ? { spokenText: '', recentMessages: '', suppressedText: li.suppressedText, suppressedTurnId: li.suppressedTurnId, timestamp: li.timestamp }
    : null
}
