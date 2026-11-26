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
    ? 'Anthropic sign-in is required to start your agent. Retry to open the sign-in again, or go back.'
    : 'Still connecting to your agent. It may be starting up, or your account needs to finish Anthropic sign-in. Retry, or go back and open the session again.'
}

/**
 * Prompt discipline (issue #87 §6, model 3 "Linear/Slack"): the Connect-Claude
 * prompt is a dismissible, remembered affordance — NOT a wall that re-pops. The
 * agent's auth flow can emit `claude_auth_required` / `claude_auth_url` more than
 * once per session (observed: "the modal reappears on its own, more than once").
 * Once the user has dismissed it, a later prompt must update the quiet terminal
 * banner (via onAuthRequired) but must NOT re-open the blocking modal.
 */

/** Agent data-message types that would OPEN the Claude sign-in modal. */
export function isAuthPromptMessage(messageType: string): boolean {
  return (
    messageType === 'claude_auth_required' ||
    messageType === 'claude_auth_url' ||
    messageType === 'claude_auth_waiting_code'
  )
}

/**
 * Should an incoming auth-prompt message AUTO-OPEN the modal? Only when the user
 * has not already dismissed the prompt this session. A dismissed prompt still
 * flips the pending-auth / terminal-banner state (that path is unconditional in
 * the caller) — this gate is strictly about not resurfacing the blocking modal.
 * The explicit "Sign in" button bypasses this (it is direct user intent).
 */
export function shouldAutoOpenAuthModal(messageType: string, dismissed: boolean): boolean {
  if (dismissed) return false
  return isAuthPromptMessage(messageType)
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

/**
 * Plain progress text for the "Connecting…" screens (issue #144): a new cloud
 * account sat ~80s on a bare orb while its machine booted. Built only from what
 * the connect flow already knows — which step it is on and the agent's
 * GET /health (reachable at all, and its `livekit.status`).
 */
export type ConnectStage = 'starting' | 'resuming' | 'agent' | 'joining'

export interface AgentHealthProbe {
  /** GET /health answered. */
  reachable: boolean
  /** /health `livekit.status` ('connecting' | 'connected' | 'failed' | 'retrying' | 'idle'), when reported. */
  livekitStatus?: string | null
  /** /health `livekit.errorCode` ('quota_exceeded' | 'auth' | 'network' | …), when reported. Never the raw error text. */
  livekitErrorCode?: string | null
}

/** After this long on a machine/agent step, say that a first start is slow. */
export const SLOW_START_HINT_MS = 20_000

const LIVEKIT_REASON_TEXT: Record<string, string> = {
  quota_exceeded: 'The voice service has hit its connection limit. Check the LiveKit plan, then try again.',
  auth: 'The voice service keys on your agent look wrong. The agent needs fresh keys.',
  network: 'Your agent cannot reach the voice service right now. It keeps retrying.',
}

export function connectProgressText(stage: ConnectStage, health: AgentHealthProbe | null, elapsedMs: number): string {
  let text: string
  if (stage === 'joining') return 'Joining your agent…'
  if (stage === 'starting') text = 'Starting your machine…'
  else if (stage === 'resuming') text = 'Waking your machine…'
  else if (health && !health.reachable) text = 'Starting your agent…'
  else if (health?.livekitStatus === 'failed' || health?.livekitStatus === 'retrying') text = LIVEKIT_REASON_TEXT[health.livekitErrorCode ?? ''] ?? 'Your agent is still reaching the voice service…'
  else text = 'Connecting to your agent…'
  return elapsedMs >= SLOW_START_HINT_MS ? `${text} The first start can take a minute or two.` : text
}

/** The agent's LiveKit identity (agent/src/index.ts mintAgentToken). Other
 *  remote participants (the meeting canvas, a phone caller) are not the agent. */
export const AGENT_IDENTITY = 'osborn-agent'

export function isAgentIdentity(identity: string | null | undefined): boolean {
  return identity === AGENT_IDENTITY
}

/**
 * Is the page in a room the agent is in? `roomState` is the mounted LiveKit
 * Room's ConnectionState ('connected', 'reconnecting', …). A Room that
 * reconnects after the tab was suspended can report 'connected' in a room the
 * agent has left.
 */
export function roomHasAgent(roomState: string | null, agentInRoom: boolean): boolean {
  return roomState === 'connected' && agentInRoom
}

export interface RoomLivenessState {
  /** this tab controls the session (tab guard 'active'). */
  tabActive: boolean
  /** the session has been live at least once on this page. */
  everConnected: boolean
  idleStopped: boolean
  /** a connect() is already in flight. */
  connecting: boolean
  /** agent_ready fired for the current join. */
  agentReady: boolean
  /** ConnectionState of the mounted LiveKit Room; null when none is mounted. */
  roomState: string | null
  /** a participant with the agent's identity is in the room. */
  agentInRoom: boolean
  attempts: number
  maxAttempts: number
}

/**
 * What to do when the tab comes back to the foreground or the room reports a
 * change: 'live' = the agent is there; 'wait' = nothing yet; 'rejoin' = connect
 * again (connect-room brings the agent back); 'lost' = the rejoin budget is
 * spent, so stop showing a live call. While LiveKit is still reconnecting (a
 * full reconnect first drops every remote participant, then flips the state),
 * or a join is under way (token handed off, agent_ready not yet in: the connect
 * watchdog bounds that), it waits; the next Reconnected / Disconnected asks again.
 */
export function roomVerdict(s: RoomLivenessState): 'live' | 'wait' | 'rejoin' | 'lost' {
  if (!s.tabActive || !s.everConnected || s.idleStopped || s.connecting) return 'wait'
  if (s.roomState !== null) {
    if (!s.agentReady) return 'wait'
    if (s.roomState === 'connecting' || s.roomState === 'reconnecting' || s.roomState === 'signalReconnecting') return 'wait'
    if (roomHasAgent(s.roomState, s.agentInRoom)) return 'live'
  }
  return s.attempts < s.maxAttempts ? 'rejoin' : 'lost'
}

/**
 * How to rejoin. A disconnected Room takes a fresh token in place (the chat
 * stays mounted). A Room still 'connected' (to a room the agent left) ignores a
 * new token, and /connect-room hands out a NEW room, so it must be remounted.
 */
export function rejoinMode(roomState: string | null): 'in-place' | 'remount' {
  return roomState === null || roomState === 'disconnected' ? 'in-place' : 'remount'
}

/**
 * Typed messages waiting for the agent. The queue belongs to the provider, so it
 * outlives a remount of the room and the chat; it is sent in order once the
 * agent is back, and a new message never jumps ahead of queued ones.
 */
export interface QueuedText<T = Uint8Array> { text: string; payload: T }

export function sendOrQueue<T>(queue: readonly QueuedText<T>[], item: QueuedText<T>, live: boolean): { send: QueuedText<T>[]; queue: QueuedText<T>[]; queued: boolean } {
  if (live && queue.length === 0) return { send: [item], queue: [], queued: false }
  return { send: [], queue: [...queue, item], queued: true }
}

export function flushQueue<T>(queue: readonly QueuedText<T>[], live: boolean): { send: QueuedText<T>[]; queue: QueuedText<T>[] } {
  return live ? { send: [...queue], queue: [] } : { send: [], queue: [...queue] }
}

/** The system line for messages given up on (left, timed out, budget spent). */
export function unsentNotice(queue: readonly QueuedText<unknown>[]): string | null {
  if (queue.length === 0) return null
  const n = queue.length
  return `${n === 1 ? 'Your message was' : `${n} messages were`} not sent: the agent could not be reached. The text is back in the composer.`
}
