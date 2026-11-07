/**
 * resume-chip.ts — the transient "Resuming session…" status (bug 0e5479b6).
 *
 * It used to be a system line in the transcript that never went away (and a
 * re-resume stacked another). Now it is one chip held OUTSIDE the message list
 * (so it is never copied, persisted or replayed), cleared by the first
 * assistant message or after 30s, and a re-resume updates the same chip.
 * Pure: the caller owns the clock and the state.
 */

export const RESUME_CHIP_TIMEOUT_MS = 30_000

export interface ResumeChip {
  label: string
  startedAt: number
}

export type ResumeChipEvent =
  | { type: 'start'; label: string; now: number }
  | { type: 'assistant' }
  | { type: 'tick'; now: number }
  | { type: 'clear' }

export function resumeChipReducer(state: ResumeChip | null, ev: ResumeChipEvent): ResumeChip | null {
  switch (ev.type) {
    case 'start':
      return { label: ev.label, startedAt: ev.now }
    case 'assistant':
    case 'clear':
      return null
    case 'tick':
      return state && ev.now - state.startedAt >= RESUME_CHIP_TIMEOUT_MS ? null : state
    default:
      return state
  }
}

export function resumeChipLabel(sessionId?: string | null, kind: 'resume' | 'continue' = 'resume'): string {
  if (kind === 'continue') return 'Continuing previous session…'
  return sessionId ? `Resuming session ${sessionId.slice(0, 8)}…` : 'Resuming session…'
}

/** A transcript line that is only the old resume/continue notice. */
export function isResumeNoticeText(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false
  return /^\s*(?:🔄\s*)?(?:Resuming session(?:\s+[0-9a-f]{4,})?|Continuing previous session)\s*(?:\.\.\.|…)\s*$/i.test(text)
}
