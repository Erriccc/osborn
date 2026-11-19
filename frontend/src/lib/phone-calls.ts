/**
 * phone-calls.ts — route one inbound phone call (#361) to the caller's agent.
 * Server-only; called from the LiveKit webhook (/api/phone/livekit).
 */
import { IngressClient, IngressInput, RoomServiceClient } from 'livekit-server-sdk'
import { checkSandboxClaim, serviceClient } from '@/lib/sandbox-claims'
import { connectUserAgent } from '@/lib/connect-agent'
import { sleep } from '@/lib/sleep'
import {
  CALL_CODE_TTL_MS, CODE_DAILY_LIMIT_LINE, CODE_EXPIRED_LINE, CODE_LOCKED_LINE, CODE_PROMPT_LINE, CODE_RETRY_LINE, CODE_SEND_FAILED_LINE,
  callCodeNext, readCallCode, startCallCode,
} from '@/lib/phone-code'

const BUSY_LINE = 'Your Osborn is in a session in the browser right now. End that session, then call again. Goodbye.'
const BUSY_HANGUP_MS = 12_000
// Static lines served from the frontend (public/phone/), for when the agent's
// own /tts is not up: the hold line repeats every ~15s for ~2 min.
export const HOLD_AUDIO_PATH = '/phone/hold.mp3'
export const FAILED_AUDIO_PATH = '/phone/call-failed.mp3'
const FAILED_HANGUP_MS = 7_000

// The server SDK clients take the wss:// URL as is (TwirpRpc maps ws→http).
const livekitHost = () => process.env.LIVEKIT_URL || process.env.NEXT_PUBLIC_LIVEKIT_URL

const roomService = (host: string) => new RoomServiceClient(host, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET)
// A line spoken by the agent's own /tts.
const agentLine = (agentUrl: string, text: string) => `${agentUrl}/tts?text=${encodeURIComponent(text)}`

async function hangUp(roomName: string): Promise<void> {
  const host = livekitHost()
  if (!host) return
  try {
    await roomService(host).deleteRoom(roomName)
  } catch (e) {
    console.warn(`[phone] hang-up failed for ${roomName}: ${(e as Error).message}`)
  }
}

/**
 * Plays an audio URL into the caller's room as a URL ingress. Resolves to a
 * function that stops it, or null when nothing plays (no LiveKit, no URL, or
 * the ingress could not be created).
 */
async function playInto(roomName: string, name: string, url: string | undefined): Promise<(() => Promise<void>) | null> {
  const host = livekitHost()
  if (!host || !url) return null
  const ingress = new IngressClient(host, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET)
  try {
    const { ingressId } = await ingress.createIngress(IngressInput.URL_INPUT, {
      name: `${name}-${roomName}`,
      roomName,
      participantIdentity: `osborn-${name}`,
      participantName: 'Osborn',
      url,
    })
    return async () => { if (ingressId) await ingress.deleteIngress(ingressId).catch(() => {}) }
  } catch (e) {
    console.warn(`[phone] ${name} line failed for ${roomName}: ${(e as Error).message}`)
    return null
  }
}


/** Plays a line into the caller's room and lets it finish; `end` then hangs up. */
async function say(roomName: string, name: string, url: string | undefined, ms: number, end = false): Promise<void> {
  const stop = await playInto(roomName, name, url)
  if (stop) await sleep(ms)
  if (end) await hangUp(roomName)
  await stop?.()
}

const sayThenHangUp = (roomName: string, name: string, url: string | undefined, ms: number) => say(roomName, name, url, ms, true)

async function roomExists(roomName: string): Promise<boolean> {
  const host = livekitHost()
  if (!host) return false
  try {
    const rooms = await roomService(host).listRooms([roomName])
    return rooms.length > 0
  } catch {
    return true
  }
}

// How long each code line gets to play (ingress start-up included), and how often the call checks the code.
const CODE_LINE_MS = 7_000
const CODE_POLL_MS = 1_500

/**
 * The emailed code (#362): the agent is in the room but has not taken the call.
 * Emails the code, tells the caller to type it, then follows the call's code
 * row (the agent sends the digits to /api/phone/code) until it matches, runs
 * out of tries or expires; the last two end the call with a goodbye line.
 */
async function codeStep(
  admin: NonNullable<ReturnType<typeof serviceClient>>,
  userId: string,
  roomName: string,
  agentUrl: string,
): Promise<'connected' | 'rejected'> {
  const line = (text: string) => agentLine(agentUrl, text)
  const sent = await startCallCode(admin, userId, roomName)
  if (sent === 'already-open') return 'connected'
  if (sent !== 'sent') {
    console.warn(`[phone] no code for ${roomName}: ${sent}`)
    await sayThenHangUp(roomName, 'code-failed', line(sent === 'daily-limit' ? CODE_DAILY_LIMIT_LINE : CODE_SEND_FAILED_LINE), CODE_LINE_MS)
    return 'rejected'
  }
  await say(roomName, 'code-prompt', line(CODE_PROMPT_LINE), CODE_LINE_MS)
  const deadline = Date.now() + CALL_CODE_TTL_MS + 10_000
  let seenMisses = 0
  for (let i = 1; ; i++) {
    // The caller hung up: stop following the code.
    if (i % 10 === 0 && !(await roomExists(roomName))) return 'rejected'
    const row = await readCallCode(admin, roomName).catch(() => null)
    const now = Date.now()
    const next = callCodeNext(seenMisses, row, now)
    if (next === 'verified') return 'connected'
    if (next === 'locked') {
      await sayThenHangUp(roomName, 'code-locked', line(CODE_LOCKED_LINE), CODE_LINE_MS)
      return 'rejected'
    }
    if (next === 'expired' || now > deadline) {
      // A caller who already hung up needs no goodbye (an ingress would recreate the room).
      if (await roomExists(roomName)) await sayThenHangUp(roomName, 'code-expired', line(CODE_EXPIRED_LINE), CODE_LINE_MS)
      else await hangUp(roomName)
      return 'rejected'
    }
    if (next === 'retry') {
      seenMisses = row!.misses
      await say(roomName, 'code-retry', line(CODE_RETRY_LINE), CODE_LINE_MS)
    }
    await sleep(CODE_POLL_MS)
  }
}

/**
 * Caller → verified account → that account's machine → agent joins the caller's room.
 * `publicOrigin` (this frontend's public URL) serves the static hold and
 * could-not-reach lines; without it the caller hears ringing/silence as before.
 */
export async function routeCall(
  call: { roomName: string; callerE164: string },
  publicOrigin?: string,
): Promise<'connected' | 'busy' | 'rejected'> {
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
    // A sleeping machine can take minutes: the caller hears the hold line
    // until the agent has joined (or the wake has failed).
    const lineUrl = (path: string) => (publicOrigin ? `${publicOrigin}${path}` : undefined)
    const hold: { playing?: ReturnType<typeof playInto> } = {}
    let r: Awaited<ReturnType<typeof connectUserAgent>>
    try {
      r = await connectUserAgent(userId, sandboxId, async () => syncToken, call.roomName,
        () => { hold.playing = playInto(call.roomName, 'hold', lineUrl(HOLD_AUDIO_PATH)) })
    } finally {
      await (await hold.playing)?.()
    }
    if (r.ok) return r.callCode ? await codeStep(admin, userId, call.roomName, r.agentUrl) : 'connected'
    if (r.reason === 'busy') {
      await sayThenHangUp(call.roomName, 'busy', r.agentUrl && agentLine(r.agentUrl, BUSY_LINE), BUSY_HANGUP_MS)
      return 'busy'
    }
    console.warn(`[phone] could not bring the agent into ${call.roomName}: ${r.reason}`)
    await sayThenHangUp(call.roomName, 'failed', lineUrl(FAILED_AUDIO_PATH), FAILED_HANGUP_MS)
    return 'rejected'
  } catch (e) {
    await hangUp(call.roomName)
    throw e
  }
}
