// Connect-gate: pure helpers for the chat "Connecting…" watchdog + the
// fresh-account Anthropic sign-in gate (issue #53).
//
// Background: when a brand-new account (never connected an Anthropic account)
// starts a session, the agent runs ensureClaudeAuth() on participant-join and
// BLOCKS before creating the voice session — so `agent_ready` never fires until
// OAuth completes. The frontend handled the auth case (markAuthRequired flips
// `connected` true so the Claude auth modal is uncovered), but there was NO
// bound on the generic "Connecting…" overlay: if neither `agent_ready` NOR an
// auth prompt ever arrived (slow/cold machine, a dropped data message, a
// crashed agent), the spinner ran forever. These helpers decide when to stop
// waiting and what to say — kept pure so they can be unit-tested without React.

export interface ConnectWaitState {
  /** connect() is mid-flight (pre-token). */
  connecting: boolean
  /** agent_ready fired → the session is live. NOTE: this is NOT the provider's
   *  `connected` flag — markAuthRequired also flips `connected` true (to uncover
   *  the sign-in modal) without the agent being ready (issue #78). */
  agentReady: boolean
  /** a LiveKit token has been handed off (VoiceRoom is mounting / mounted). */
  hasToken: boolean
  /** an error is already surfaced. */
  error: boolean
  /** the agent asked for Anthropic sign-in and it has not resolved yet
   *  (cleared on claude_auth_complete / claude_auth_error). Selects the
   *  auth-specific timeout message; it does NOT by itself disarm the watchdog. */
  authRequired: boolean
  /** the Claude sign-in modal is open on an active OAuth step (the user is
   *  mid-sign-in). Only this disarms the watchdog for the auth case. */
  authInProgress: boolean
}

/** Claude sign-in modal status, as tracked by VoiceRoom. */
export type ClaudeAuthStatus =
  | 'none' | 'required' | 'waiting' | 'waiting_code' | 'submitting' | 'complete' | 'error'

/**
 * Is the user mid-OAuth (modal open on an active step)? `none` = dismissed or
 * never shown; `complete` / `error` are terminal — the user is not signing in.
 */
export function isOAuthInProgress(status: ClaudeAuthStatus): boolean {
  return status === 'required' || status === 'waiting' || status === 'waiting_code' || status === 'submitting'
}

/**
 * Pending-auth flag transition for an agent data message type. Set when the
 * agent asks for sign-in, cleared when sign-in resolves either way.
 */
export function nextAuthRequired(prev: boolean, messageType: string): boolean {
  if (messageType === 'claude_auth_required' || messageType === 'claude_auth_url') return true
  if (messageType === 'claude_auth_complete' || messageType === 'claude_auth_error') return false
  return prev
}

/**
 * How long the "Connecting…" screen may sit with no resolution before the
 * watchdog surfaces an actionable error. Generous enough to clear a cold Fly
 * machine boot + agent room-join, bounded so it can never spin forever.
 * The watchdog timer is reset on every progress tick (status message change),
 * so a slow-but-progressing connect never trips it.
 */
export const CONNECT_WATCHDOG_MS = 90_000

/**
 * Is the UI actively waiting on the agent (and therefore should the watchdog
 * be armed)? It disarms the moment agent_ready fires, an error is shown, or the
 * user is mid-OAuth in the sign-in modal (never cut them off). A transport-level
 * connection without agent_ready still counts as waiting — so a user who
 * DISMISSES the sign-in modal (agent still blocked on ensureClaudeAuth) gets
 * the bounded timeout + Retry/Back instead of "Connecting…" forever (#78).
 */
export function isAwaitingAgent(s: ConnectWaitState): boolean {
  if (s.agentReady || s.error) return false
  if (s.authInProgress) return false
  return s.connecting || s.hasToken
}

/**
 * The actionable message shown when the watchdog fires. Auth-aware: if the
 * agent had asked for sign-in at any point we point the user at that, otherwise
 * we describe the slow-start / retry path.
 */
export function connectTimeoutMessage(authRequired: boolean): string {
  return authRequired
    ? 'Anthropic sign-in is required to start your agent. Reopen the session to finish signing in, or connect your Claude account first.'
    : 'Still connecting to your agent. It may be starting up, or your account needs to finish Anthropic sign-in. Retry, or go back and open the session again.'
}

/**
 * Once the agent has asked for Anthropic sign-in at least once this session, the
 * auth gate — not a spinner — is the terminal state. When the sign-in modal is
 * closed (status 'none'), the UI must rest on the actionable "Anthropic sign-in
 * required" banner, NEVER an infinite "Connecting…". This is the #53/#78
 * contract: dismissing the modal lands here, not back on a spinner. The watchdog
 * disarms on `authRequired` precisely because this banner is the resolution — so
 * the banner has to be reachable in every auth path for that disarm to be safe.
 */
export function isAuthGateTerminal(authEverRequired: boolean, authStatus: string): boolean {
  return authEverRequired && authStatus === 'none'
}
