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
 *     mcp_toggle, set_agents, skill_add, skill_remove, noise_cancel,
 *     gate_send_anyway, stop_dispatch, join_meeting, leave_meeting,
 *     mute_participant, start_ide, stop_ide, spawn_background_session,
 *     dispatch_background, stop_background_session, list_slots, list_processes,
 *     favorite_changed
 *   Open (read-only, listed in READ_ONLY_MESSAGE_TYPES):
 *     get_current_session, get_session_artifacts, get_plan_file,
 *     get_research_artifact, get_mcp_status, get_skills, get_agents, skill_get
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
  'session_selected',
  'mcp_toggle',
  'set_agents',
  'skill_add',
  'skill_remove',
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
  'get_agents',
  'skill_get',
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
 *   currentUserId to '' (the gateway's token has no metadata).
 * - Any other identity: never the controller; gets a session only in
 *   single-tenant mode (no owner), matching the old behavior there.
 */
export function resolveJoin(
  joinerIdentity: string,
  joinerUserId: string | undefined | null,
  ownerUserId: string | undefined | null,
  currentController: string | null,
): JoinDecision {
  if (joinerIdentity === AGENT_SELF_IDENTITY) {
    return { adoptSession: !currentController, controller: currentController }
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
