/**
 * room-ownership.ts — server-side check that a LiveKit room belongs to the
 * caller's machine. Used by /api/token before it mints a publish-capable token.
 *
 * How rooms are named (agent/src/index.ts buildRoomName):
 *   osborn-${roomCode}-${Date.now().toString(36)}
 * On Fly Machines the prefix `roomCode` is FLY_APP_NAME minus a leading
 * "osborn-", and FLY_APP_NAME is the user's app (= instances.sandbox_id, or
 * the deterministic osborn-<userId slug> for legacy users). So a room belongs
 * to sandbox `osborn-x` iff it is exactly `osborn-x-<base36 suffix>`.
 *
 * The suffix must be a single [a-z0-9] run (no hyphen). That stops prefix
 * collisions between app names such as `osborn-abc-v2` and `osborn-abc-v2-n`.
 */

/** Room-name prefix the agent on this sandbox/app uses (without the trailing "-"). */
export function roomPrefixForSandbox(sandboxId: string): string {
  return sandboxId.startsWith('osborn-') ? sandboxId : `osborn-${sandboxId}`
}

/** True when `roomName` is a room created by the agent running on `sandboxId`. */
export function roomBelongsToSandbox(roomName: string, sandboxId: string | null | undefined): boolean {
  if (!sandboxId) return false
  const prefix = `${roomPrefixForSandbox(sandboxId)}-`
  if (!roomName.startsWith(prefix)) return false
  return /^[a-z0-9]+$/.test(roomName.slice(prefix.length))
}

/**
 * Deterministic Fly app name for a user. MUST match appNameFromUserId in
 * lib/machines.ts. It is derived from the authenticated user id, so unlike
 * instances.sandbox_id it cannot be edited by the user.
 */
export function deterministicAppName(userId: string): string {
  const slug = userId.substring(0, 12).toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '')
  return `osborn-${slug}`
}

/** Room codes the client may send: the agent's room name minus "osborn-". */
export function isValidRoomCode(roomCode: string): boolean {
  return /^[a-z0-9-]{1,128}$/.test(roomCode)
}
