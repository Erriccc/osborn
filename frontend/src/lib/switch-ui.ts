// ============================================================
// SESSION SWITCH UI STATE (#74) — pure, client-safe
// ============================================================
// Finish-then-switch: when the live session is busy, the agent defers a
// switch until the current step finishes and replies session_switch_pending.
// The UI holds that as one pending-switch state (outside the transcript, and
// NOT the resume chip: the old session's own assistant messages keep arriving
// while it finishes, and the chip clears on the first assistant message).

export interface SwitchPending {
  sessionId: string
  cwd?: string
  runningTasks: number
  startedAt: number
}

export type SwitchPendingEvent =
  | { type: 'pending'; sessionId: string; cwd?: string; runningTasks?: number; now: number }
  | { type: 'cancelled'; sessionId?: string | null }
  | { type: 'switched' }

export function switchPendingReducer(state: SwitchPending | null, ev: SwitchPendingEvent): SwitchPending | null {
  switch (ev.type) {
    case 'pending':
      // A newer request replaces the older one (the agent keeps one pending switch).
      return { sessionId: ev.sessionId, cwd: ev.cwd, runningTasks: ev.runningTasks ?? 0, startedAt: ev.now }
    case 'cancelled':
      if (!state) return null
      // Ignore a cancel for a request that was already replaced.
      return ev.sessionId && ev.sessionId !== state.sessionId ? state : null
    case 'switched':
      return null
    default:
      return state
  }
}

export function pendingSwitchLabel(title: string, runningTasks = 0): string {
  const base = `Switching to “${title}” when the current step finishes`
  return runningTasks > 0 ? `${base} (${runningTasks} sub-agent${runningTasks === 1 ? '' : 's'} still running)` : base
}

const FAILURE_COPY: Record<string, string> = {
  meeting_active: 'Can’t switch during a meeting — leave the meeting first.',
  target_busy_in_background: 'That session is busy in the background. Wait for it to finish or stop it first.',
  needs_you: 'This session is waiting on a permission prompt. Answer it, or choose Switch now.',
  not_found: 'Session not found.',
}

/** User-facing reason a switch did not happen (agent reason code → copy). */
export function switchFailureText(data: { reason?: string | null; error?: string | null }): string {
  if (data.reason && FAILURE_COPY[data.reason]) return FAILURE_COPY[data.reason]
  if (data.error) return data.error
  return 'Couldn’t switch sessions.'
}
