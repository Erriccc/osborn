/**
 * data-sender-auth.ts — who may send data-channel commands, and who may become
 * the controller.
 *
 * Every message on topic 'user-input' is handled by handleDataReceived in
 * index.ts. All of them EXCEPT the read-only queries in READ_ONLY_MESSAGE_TYPES
 * must come from the controlling user participant: the `user-*` identity
 * minted by the frontend /api/token (auth-gated, checks room ownership) that
 * the agent adopted as its voice user. Canvas, bots and other identities are
 * dropped. The gate FAILS CLOSED: a type that is not on the read-only list
 * (including any new type added to index.ts later) requires the controller.
 *
 * Full set of types handleDataReceived handles (2026-11-07):
 *   Gated (state-changing or leaks session/process ids):
 *     user_text, claude_auth_code, permission_response, list_sessions,
 *     resume_session, continue_session, switch_session, session_selected,
 *     cancel_session_switch,
 *     mcp_toggle, set_agents, skill_add, skill_fork, skill_remove,
 *     get_agent_prompt, noise_cancel,
 *     gate_send_anyway, stop_dispatch, join_meeting, leave_meeting,
 *     mute_participant, start_ide, stop_ide, spawn_background_session,
 *     dispatch_background, stop_background_session, list_slots, list_processes,
 *     favorite_changed
 *   Open (read-only, listed in READ_ONLY_MESSAGE_TYPES):
 *     get_current_session, get_session_artifacts, get_plan_file,
 *     get_research_artifact, get_mcp_status, get_skills, skill_get, get_busy
 * list_sessions / list_slots / list_processes are read-only but return session
 * and process ids that the gated commands (dispatch_background etc.) take as
 * targets, so they are gated too.
 *
 * Controller binding (canBecomeController): when the machine has an owner
 * (OSBORN_OWNER_USER_ID, baked into machine env by the frontend provisioning),
 * only a participant whose SIGNED token metadata userId equals the owner can
 * become the controller. With no owner configured (single-tenant / local
 * mode) the newest joiner becomes the controller, as before.
 */
import type { PermissionAnswer } from './approval-policy.js'

/**
 * Known gated types. Informational and for tests: the gate itself is "not
 * read-only", so types missing from this list are still gated.
 */
export const CONTROL_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'user_text',
  'claude_auth_code',
  'claude_auth_start',
  'permission_response',
  'list_sessions',
  'resume_session',
  'continue_session',
  'switch_session',
  // Cancels a deferred switch (#74) — state-changing, controller-only.
  'cancel_session_switch',
  // Keeps the agent working after the hang-up — state-changing, controller-only.
  'keep_working',
  'session_selected',
  'mcp_toggle',
  'set_agents',
  'skill_add',
  'skill_fork',
  'skill_remove',
  // The built-in agents' prompts, for Fork (the same data GET /agents keeps behind the token).
  'get_agent_prompt',
  'noise_cancel',
  'gate_send_anyway',
  'stop_dispatch',
  'join_meeting',
  'leave_meeting',
  'mute_participant',
  'start_ide',
  'stop_ide',
  'spawn_background_session',
  'dispatch_background',
  'stop_background_session',
  'list_slots',
  'list_processes',
  // Feeds hidden context into the next turn (UI#21), so controller-only.
  'favorite_changed',
])

/** Read-only queries any participant may send. Everything else is gated. */
export const READ_ONLY_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'get_current_session',
  'get_session_artifacts',
  'get_plan_file',
  'get_research_artifact',
  'get_mcp_status',
  'get_skills',
  'skill_get',
  // End asks whether the agent is mid-task before offering keep-working.
  'get_busy',
])

/** Identity prefix /api/token gives every user participant. */
export const USER_IDENTITY_PREFIX = 'user-'

/**
 * Identity the agent itself mints (mintAgentToken). The watch gateway joins
 * with it and relays watch Approve/Deny as `permission_response`. Only the
 * agent's own API secret can mint it, so it is trusted for approvals but not
 * for anything else.
 */
export const AGENT_SELF_IDENTITY = 'osborn-agent'

export interface SenderCheck {
  ok: boolean
  reason?: string
}

export function checkControlSender(
  type: string,
  senderIdentity: string | undefined | null,
  controllingIdentity: string | null,
): SenderCheck {
  if (READ_ONLY_MESSAGE_TYPES.has(type)) return { ok: true }
  if (!senderIdentity) return { ok: false, reason: 'no sender participant' }
  if (type === 'permission_response' && senderIdentity === AGENT_SELF_IDENTITY) return { ok: true }
  if (!senderIdentity.startsWith(USER_IDENTITY_PREFIX)) {
    return { ok: false, reason: `sender ${senderIdentity} is not a user participant` }
  }
  if (!controllingIdentity) return { ok: false, reason: 'no controlling participant' }
  if (senderIdentity !== controllingIdentity) {
    return { ok: false, reason: `sender ${senderIdentity} is not the controlling participant (${controllingIdentity})` }
  }
  return { ok: true }
}

/**
 * May a joining participant become the controller?
 * - Owner configured: only when the participant's token userId matches it.
 * - No owner configured (single-tenant / local): yes (newest joiner wins).
 */
export function canBecomeController(
  participantUserId: string | undefined | null,
  ownerUserId: string | undefined | null,
): boolean {
  if (!ownerUserId) return true
  return !!participantUserId && participantUserId === ownerUserId
}

/**
 * Room-name prefix of the inbound phone dispatch rule (LiveKit `individual`
 * rule, roomPrefix "call-"). POST /connect-room only joins a caller-supplied
 * room with this prefix, and only behind the sync-token check.
 */
const PHONE_ROOM_PREFIX = 'call-'

/** A room name POST /connect-room may join for a phone call. */
export function isPhoneRoomName(name: unknown): name is string {
  return typeof name === 'string'
    && name.length <= 128
    && name.startsWith(PHONE_ROOM_PREFIX)
    && /^[A-Za-z0-9_+\-]+$/.test(name)
}

/**
 * Keypad answer to a pending approval on a phone call (#363): 1 allows, 2
 * denies, 3 always allows (the browser's "Always"); anything else is ignored.
 */
export function keypadAnswer(digit: string | undefined | null): PermissionAnswer | null {
  if (digit === '1') return 'allow'
  if (digit === '2') return 'deny'
  if (digit === '3') return 'always_allow'
  return null
}

/**
 * Keypad approvals on a phone call. Off: caller ID alone is not proof enough
 * to approve a tool, so every permission raised while a phone caller holds the
 * session is denied and keypad 1 approves nothing. Turned on once a second
 * factor confirms the caller.
 */
export const PHONE_KEYPAD_APPROVALS_ENABLED = false

/**
 * Tools on a phone call. Off: a call is talk-only, so the PreToolUse hook
 * (claude-llm.ts) denies every tool while a phone caller holds the session,
 * including the ones allowedTools auto-approves (Bash, Read, WebFetch …),
 * sub-agent dispatch and MCP tools. Turned on once a second factor confirms
 * the caller.
 */
export const PHONE_TOOLS_ENABLED = false

/** What happens to a permission raised during a phone call: denied unless keypad approvals are on. */
export function phonePermissionPolicy(inPhoneCall: boolean, approvalsEnabled = PHONE_KEYPAD_APPROVALS_ENABLED): 'deny' | 'ask' {
  return inPhoneCall && !approvalsEnabled ? 'deny' : 'ask'
}

/** What happens to any tool call during a phone call: denied unless phone tools are on. */
export function phoneToolPolicy(inPhoneCall: boolean, toolsEnabled = PHONE_TOOLS_ENABLED): 'deny' | 'allow' {
  return inPhoneCall && !toolsEnabled ? 'deny' : 'allow'
}

/**
 * A phone call is live: the agent is in the room an authorised phone connect
 * asked for AND a SIP participant is in it. False as soon as the caller leaves.
 */
export function isPhoneCallLive(activeRoomName: string | null, phoneRoomName: string | null, sipPresent: boolean): boolean {
  return !!activeRoomName && activeRoomName === phoneRoomName && sipPresent
}

/**
 * What POST /connect-room does with the room the agent is in.
 * - 'fresh': no room, or an empty one: (tear it down and) make a new room
 *   (the requested phone room, else a new name).
 * - 'reuse': return the occupied room: a browser connect while no phone call is
 *   live, or a phone connect for the room the agent is already in.
 * - 'busy' (409): the room is someone else's: a phone connect while a user is in
 *   another room, or a browser connect during a live phone call (the caller's
 *   room is never handed to a browser).
 */
export function planConnectRoom(s: {
  activeRoomName: string | null
  occupied: boolean
  phoneCallLive: boolean
  phoneRoom?: string
}): 'fresh' | 'reuse' | 'busy' {
  if (!s.activeRoomName || !s.occupied) return 'fresh'
  if (s.phoneRoom) return s.activeRoomName === s.phoneRoom ? 'reuse' : 'busy'
  return s.phoneCallLive ? 'busy' : 'reuse'
}

/**
 * Handles one keypad press (index.ts DtmfReceived). Only the SIP caller in an
 * authorised phone room counts; with approvals off a 1 or 3 settles nothing
 * (a 2 still denies). The answer goes to the same settle path the browser
 * and watch use; the model never decides it. Returns what was done.
 */
export function handlePhoneKeypad(
  press: { sip: boolean; inPhoneRoom: boolean; digit: string | undefined | null },
  settle: (answer: PermissionAnswer) => boolean,
  approvalsEnabled = PHONE_KEYPAD_APPROVALS_ENABLED,
): 'ignored' | 'approved' | 'always allowed' | 'denied' | 'no pending permission' {
  if (!press.sip || !press.inPhoneRoom) return 'ignored'
  const answer = keypadAnswer(press.digit)
  if (answer === null || (answer !== 'deny' && !approvalsEnabled)) return 'ignored'
  if (!settle(answer)) return 'no pending permission'
  return answer === 'allow' ? 'approved' : answer === 'always_allow' ? 'always allowed' : 'denied'
}

/** Most bytes POST /connect-room reads; its body is only `{ roomName }`. */
export const CONNECT_ROOM_MAX_BODY = 4096

/**
 * Reads a request body up to `max` bytes. Returns null as soon as it is
 * longer (the caller answers 413) and stops reading.
 */
export async function readBodyCapped(body: AsyncIterable<Buffer | string>, max: number): Promise<string | null> {
  const parts: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += b.length
    if (size > max) return null
    parts.push(b)
  }
  return Buffer.concat(parts).toString('utf8')
}

export interface JoinOptions {
  /** The joiner is a SIP (phone) participant. */
  sip?: boolean
  /** The agent joined this room through an authorised phone connect (POST /connect-room with a roomName). */
  phoneRoom?: boolean
}

export interface JoinDecision {
  /** Build the voice session for this joiner (index.ts participantConnectedHandler). */
  adoptSession: boolean
  /** Controlling identity after this join. */
  controller: string | null
}

/**
 * What a non-canvas participant joining the room changes. Pure, so the
 * controller rules are testable without LiveKit.
 * - `user-*` joiner allowed by canBecomeController: gets the session and
 *   becomes the controller (newest eligible joiner wins).
 * - `user-*` joiner that is not the owner: ignored entirely.
 * - The agent's own identity (watch gateway): NEVER becomes the controller,
 *   so the owner's commands keep working; it can still send
 *   permission_response (checkControlSender). It gets the voice session only
 *   when it joins with no controller (the opt-in watch voice path that hears
 *   the watch mic). When a controller already exists it is NOT adopted: the
 *   full session rebuild would tear down the owner's live session and reset
 *   currentUserId to '' (the gateway's token has no metadata). Nor in a
 *   phone room, where the rebuild would take the caller's session.
 * - A SIP (phone) joiner: never the controller, whatever its identity. It
 *   gets the voice session only in a room the agent joined through an
 *   authorised phone connect, and only while no controller holds the session.
 *   Anywhere else it is ignored, in single-tenant mode too.
 * - Any other identity: never the controller; gets a session only in
 *   single-tenant mode (no owner), matching the old behavior there.
 */
export function resolveJoin(
  joinerIdentity: string,
  joinerUserId: string | undefined | null,
  ownerUserId: string | undefined | null,
  currentController: string | null,
  opts: JoinOptions = {},
): JoinDecision {
  if (opts.sip) {
    return { adoptSession: !!opts.phoneRoom && !currentController, controller: currentController }
  }
  if (joinerIdentity === AGENT_SELF_IDENTITY) {
    // In a phone room the caller holds the session without being the controller.
    return { adoptSession: !currentController && !opts.phoneRoom, controller: currentController }
  }
  if (joinerIdentity.startsWith(USER_IDENTITY_PREFIX)) {
    return canBecomeController(joinerUserId, ownerUserId)
      ? { adoptSession: true, controller: joinerIdentity }
      : { adoptSession: false, controller: currentController }
  }
  return { adoptSession: !ownerUserId, controller: currentController }
}

/**
 * userId from a participant's token metadata (JSON set by /api/token and signed
 * into the JWT). Participants cannot change their own metadata unless the token
 * grants canUpdateOwnMetadata, which /api/token sets to false.
 */
export function userIdFromMetadata(metadata: string | undefined | null): string | undefined {
  if (!metadata) return undefined
  try {
    const parsed = JSON.parse(metadata) as { userId?: unknown }
    return typeof parsed?.userId === 'string' && parsed.userId ? parsed.userId : undefined
  } catch {
    return undefined
  }
}
