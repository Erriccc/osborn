/**
 * phone-calls.ts — route one inbound phone call (#361) to the caller's agent.
 * Server-only; called from the LiveKit webhook (/api/phone/livekit).
 */
import { IngressClient, IngressInput, RoomServiceClient } from 'livekit-server-sdk'
import { checkSandboxClaim, serviceClient } from '@/lib/sandbox-claims'
import { connectUserAgent } from '@/lib/connect-agent'

const BUSY_LINE = 'Your Osborn is in a session in the browser right now. End that session, then call again. Goodbye.'
const BUSY_HANGUP_MS = 12_000

// The server SDK clients take the wss:// URL as is (TwirpRpc maps ws→http).
const livekitHost = () => process.env.LIVEKIT_URL || process.env.NEXT_PUBLIC_LIVEKIT_URL

async function hangUp(roomName: string): Promise<void> {
  const host = livekitHost()
  if (!host) return
  try {
    await new RoomServiceClient(host, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET).deleteRoom(roomName)
  } catch (e) {
    console.warn(`[phone] hang-up failed for ${roomName}: ${(e as Error).message}`)
  }
}

/** Plays the busy line into the caller's room (the agent's own /tts as a URL ingress), then hangs up. */
async function sayBusyThenHangUp(roomName: string, agentUrl: string | undefined): Promise<void> {
  const host = livekitHost()
  const ingress = host && agentUrl ? new IngressClient(host, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET) : null
  let ingressId: string | undefined
  if (ingress) {
    try {
      ingressId = (await ingress.createIngress(IngressInput.URL_INPUT, {
        name: `busy-${roomName}`,
        roomName,
        participantIdentity: 'osborn-busy',
        participantName: 'Osborn',
        url: `${agentUrl}/tts?text=${encodeURIComponent(BUSY_LINE)}`,
      })).ingressId
      await new Promise((r) => setTimeout(r, BUSY_HANGUP_MS))
    } catch (e) {
      console.warn(`[phone] busy line failed for ${roomName}: ${(e as Error).message}`)
    }
  }
  await hangUp(roomName)
  if (ingress && ingressId) await ingress.deleteIngress(ingressId).catch(() => {})
}

/** Caller → verified account → that account's machine → agent joins the caller's room. */
export async function routeCall(call: { roomName: string; callerE164: string }): Promise<'connected' | 'busy' | 'rejected'> {
  const admin = serviceClient()
  if (!admin) {
    console.warn('[phone] SUPABASE_SERVICE_ROLE_KEY not set; cannot route calls')
    await hangUp(call.roomName)
    return 'rejected'
  }
  // Any throw below would leave the caller in a silent room: hang up, then rethrow for the webhook's log.
  try {
    const { data: userId, error } = await admin.rpc('user_id_for_phone', { p_phone: call.callerE164 })
    if (error || typeof userId !== 'string' || !userId) {
      await hangUp(call.roomName)
      return 'rejected'
    }
    const { data: inst } = await admin.from('instances').select('sandbox_id, sync_token').eq('user_id', userId).single()
    const sandboxId = (inst?.sandbox_id as string | null | undefined) ?? undefined
    const syncToken = (inst?.sync_token as string | null | undefined) ?? undefined
    // The phone path joins a caller-supplied room, which the agent only allows
    // with the machine's sync token; and the recorded machine must be this user's alone.
    // (null client: skip the per-user RPC, which needs the user's own session, and use the service-role check.)
    if (!sandboxId || !syncToken || (await checkSandboxClaim(null, sandboxId, userId)) !== 'mine') {
      await hangUp(call.roomName)
      return 'rejected'
    }
    const r = await connectUserAgent(userId, sandboxId, async () => syncToken, call.roomName)
    if (r.ok) return 'connected'
    if (r.reason === 'busy') {
      await sayBusyThenHangUp(call.roomName, r.agentUrl)
      return 'busy'
    }
    console.warn(`[phone] could not bring the agent into ${call.roomName}: ${r.reason}`)
    await hangUp(call.roomName)
    return 'rejected'
  } catch (e) {
    await hangUp(call.roomName)
    throw e
  }
}
