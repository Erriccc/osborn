/**
 * phone.ts — pure helpers for phone calls in (#361): number format, the
 * LiveKit SIP join event, the Supabase Send SMS hook payload and the WhatsApp
 * authentication-template message. Client-safe (Settings uses toUsE164).
 */
/** A US number in E.164 (+1 and 10 digits), or null. Accepts common formatting. */
export function toUsE164(input: string | null | undefined): string | null {
  const digits = String(input ?? '').replace(/[^0-9]/g, '')
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  // NANP: area code and exchange start with 2-9.
  if (!/^[2-9][0-9]{2}[2-9][0-9]{6}$/.test(national)) return null
  return `+1${national}`
}

// Structural slice of livekit-server-sdk's WebhookEvent that we read.
interface JoinEventLike {
  event?: string
  room?: { name?: string } | null
  participant?: { identity?: string; kind?: unknown; attributes?: Record<string, string> } | null
}

// ParticipantInfo_Kind.SIP in @livekit/protocol (WebhookReceiver.receive parses the JSON name to it).
const SIP_KIND = 3
// Room prefix of the shared number's `individual` dispatch rule.
export const PHONE_ROOM_PREFIX = 'call-'
// Warn once about an unreadable shared number, not on every call.
let warnedBadSharedNumber = false

/**
 * The phone call in a LiveKit `participant_joined` webhook, or null when the
 * event is anything else (another event, a non-SIP participant, no caller ID,
 * a room the inbound dispatch rule did not make, or a call to another number).
 * `sharedNumber` (default NEXT_PUBLIC_OSBORN_PHONE_NUMBER), when set, must be
 * the number that was dialled; set but not a US number refuses every call.
 */
export function phoneCallFromEvent(
  ev: JoinEventLike,
  sharedNumber: string | undefined = process.env.NEXT_PUBLIC_OSBORN_PHONE_NUMBER,
): { roomName: string; identity: string; callerE164: string } | null {
  if (ev.event !== 'participant_joined') return null
  const p = ev.participant
  if (p?.kind !== SIP_KIND) return null
  const roomName = ev.room?.name
  const identity = p?.identity
  // Only the inbound dispatch rule's rooms (roomPrefix "call-").
  if (!roomName?.startsWith(PHONE_ROOM_PREFIX)) return null
  // LiveKit Cloud sends camelCase attribute keys (sipPhoneNumber, seen on a
  // live call); the docs show the dotted form. Read both, camelCase first.
  const attrs = p?.attributes ?? {}
  const callerE164 = toUsE164(attrs.sipPhoneNumber || attrs['sip.phoneNumber'])
  if (!identity || !callerE164) return null
  const shared = toUsE164(sharedNumber)
  // Set but unreadable: fail closed rather than accept calls to any number.
  if (!shared && String(sharedNumber ?? '').trim()) {
    if (!warnedBadSharedNumber) {
      warnedBadSharedNumber = true
      console.warn('[phone] NEXT_PUBLIC_OSBORN_PHONE_NUMBER is set but is not a US number; refusing calls until it is fixed')
    }
    return null
  }
  if (shared && toUsE164(attrs.sipTrunkPhoneNumber || attrs['sip.trunkPhoneNumber']) !== shared) return null
  return { roomName, identity, callerE164 }
}

/** The Send SMS hook payload fields we read. */
export interface SendSmsHookPayload {
  user?: { phone?: string; phone_change?: string; new_phone?: string } | null
  sms?: { otp?: string; phone?: string } | null
}

/**
 * Where the code goes and what it is. A phone change sends the code to the NEW
 * number, so it wins over the current one when present.
 */
export function smsDelivery(payload: SendSmsHookPayload): { to: string; otp: string } | null {
  const otp = payload?.sms?.otp
  const raw = payload?.sms?.phone || payload?.user?.phone_change || payload?.user?.new_phone || payload?.user?.phone
  const to = String(raw ?? '').replace(/[^0-9]/g, '')
  if (!otp || !/^[0-9]{4,10}$/.test(otp) || to.length < 8) return null
  return { to, otp }
}

/** WhatsApp Cloud API message for an authentication template with a copy-code button. */
export function whatsappAuthMessage(to: string, otp: string, template: string, language = 'en_US') {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: template,
      language: { code: language },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: otp }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: otp }] },
      ],
    },
  }
}

/** Graph API version for the WhatsApp Cloud API (META_WA_GRAPH_VERSION, default v23.0). */
export function graphVersion(raw: string | undefined = process.env.META_WA_GRAPH_VERSION): string {
  const v = String(raw ?? '').trim()
  return /^v[0-9]+\.[0-9]+$/.test(v) ? v : 'v23.0'
}

/** The message id Meta returns for an accepted send (`messages[0].id`), or null. */
export function whatsappMessageId(body: unknown): string | null {
  const id = (body as { messages?: { id?: unknown }[] } | null)?.messages?.[0]?.id
  return typeof id === 'string' && id ? id : null
}

const META_BUSY = 'WhatsApp is busy right now. Try again in a minute.'
// Meta Cloud API error codes, in plain words.
// https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
const META_ERRORS: Record<number, string> = {
  131026: "This number isn't on WhatsApp. Check the number, or use one that has WhatsApp.",
  131030: "This number isn't allowed to receive codes from our WhatsApp sender yet.",
  131009: "That doesn't look like a valid phone number. Check it and try again.",
  131021: "This number can't receive a code from itself.",
  131056: 'Too many codes sent to this number. Wait a few minutes and try again.',
  131048: 'WhatsApp is limiting messages to this number. Try again later.',
  130429: META_BUSY,
  80007: META_BUSY,
  4: META_BUSY,
  132001: 'Code delivery on WhatsApp is not set up correctly (template missing).',
  132015: 'Code delivery on WhatsApp is paused (template paused).',
  132016: 'Code delivery on WhatsApp is turned off (template disabled).',
  190: 'Code delivery on WhatsApp is not set up correctly (access token expired).',
  133010: 'Code delivery on WhatsApp is not set up correctly (sender not registered).',
}
export const META_SEND_FAILED = 'Could not send the code on WhatsApp. Try again in a minute.'

/**
 * A plain message for a refused Meta send, from its error body
 * (`{ error: { code, message } }`). Unknown codes and unreadable bodies get a
 * generic message, never Meta's raw text.
 */
export function metaSendError(body: unknown): { code: number | null; message: string } {
  const raw = (body as { error?: { code?: unknown } } | null)?.error?.code
  const code = typeof raw === 'number' ? raw : null
  return { code, message: (code !== null && META_ERRORS[code]) || META_SEND_FAILED }
}
