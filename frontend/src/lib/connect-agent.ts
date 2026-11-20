/**
 * connect-agent.ts — bring a user's agent into a LiveKit room.
 *
 * One sequence for the browser connect (/api/sandbox `connect-room`) and the
 * phone webhook (/api/phone/livekit): find the machine, wake it when it is not
 * running, restart the service when it does not answer /health, then POST the
 * agent's /connect-room. With `roomName` (a phone call) the agent joins that
 * room; the request then carries the machine's sync token, which the agent
 * requires for a caller-supplied room.
 */
import { findUserSandbox, startSandbox, checkOsbornHealth, restartService, waitForHealth } from '@/lib/cloud'

export type ConnectAgentResult =
  /** `callCode`: the agent waits for the emailed code before it takes the call (#362). */
  | { ok: true; roomName: string | null; agentUrl: string; callCode?: boolean }
  /** `busy`: a user is in another room with the agent (phone calls only). */
  | { ok: false; reason: 'no-sandbox' | 'wake-failed' | 'busy' | 'unreachable'; agentUrl?: string }

/** The user's sandbox; null is a confirmed 404, undefined a lookup that failed
 *  (findUserSandbox threw), which is never "no sandbox". */
export const lookupSandbox = (userId: string, id?: string) => findUserSandbox(userId, id).catch(() => undefined)

export async function connectUserAgent(
  userId: string,
  sandboxId: string | undefined,
  getSyncToken: () => Promise<string | undefined>,
  roomName?: string,
  /** Called once when the agent is not already up (machine asleep or service unhealthy). */
  onWaking?: () => void,
): Promise<ConnectAgentResult> {
  const sb = await lookupSandbox(userId, sandboxId)
  if (sb === undefined) return { ok: false, reason: 'unreachable' }
  if (!sb?.previewUrl) return { ok: false, reason: 'no-sandbox' }

  // Wake the machine if it isn't running (boot time is inherent — the agent
  // must be up to join the room). Idempotent: a no-op when already running.
  let waking = false
  const wake = () => { if (!waking) { waking = true; onWaking?.() } }
  if (sb.status !== 'running') {
    wake()
    console.log(`[connect-agent] sandbox is ${sb.status}, starting...`)
    const woken = await startSandbox(sb.id, userId, await getSyncToken())
    if (!woken || woken.status !== 'running') return { ok: false, reason: 'wake-failed' }
  }

  // Ensure osborn is actually answering before we ask it to join (a just-woken
  // or frozen agent won't). Restart the service only if it's unhealthy.
  const agentUrl = sb.previewUrl
  if (!(await checkOsbornHealth(agentUrl))) {
    wake()
    console.log(`[connect-agent] osborn health check failed, restarting service...`)
    await restartService(sb.id)
    await waitForHealth(agentUrl, 15)
  }

  const headers: Record<string, string> = {}
  let body: string | undefined
  if (roomName) {
    const token = await getSyncToken()
    if (token) headers.Authorization = `Bearer ${token}`
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify({ roomName })
  }

  // The agent joins the LiveKit room on this call; cold connect (room.connect
  // via rtc-node) takes 7-15s. Timeout must exceed that so we don't abort and
  // force a second connect cycle (which previously doubled the cold-path
  // latency). Retry only for transient network errors, not for "still
  // connecting" races.
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${agentUrl}/connect-room`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(25000),
      })
      if (r.ok) {
        // The roomName the agent returns (0.9.83+ temporary rooms), so the
        // client mints its token for the room the agent actually joined.
        const d = (await r.json().catch(() => ({}))) as { roomName?: string; callCode?: unknown }
        return { ok: true, roomName: d?.roomName ?? null, agentUrl, ...(roomName && d?.callCode === true ? { callCode: true } : {}) }
      }
      if (roomName && r.status === 409) return { ok: false, reason: 'busy', agentUrl }
      // A refusal (bad token, bad room) will not change on a retry; 408/429 are transient.
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
        console.warn(`[connect-agent] /connect-room refused: ${r.status}`)
        return { ok: false, reason: 'unreachable', agentUrl }
      }
    } catch {
      // agent not ready yet — brief backoff then retry
    }
    await new Promise(res => setTimeout(res, 1500))
  }
  return { ok: false, reason: 'unreachable', agentUrl }
}
