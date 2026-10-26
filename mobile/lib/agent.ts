import { CONNECT_DEFAULTS, FRONTEND_URL } from './config'
import { supabase } from './supabase'

/**
 * Agent data layer. The user's agent runs on a per-user machine whose URL lives
 * in the RLS-scoped `instances` table (same row /api/instance reads on the web).
 * Native fetch isn't bound by CORS, so once we have server_url we hit the
 * agent's open HTTP endpoints directly — no Next API hop.
 */

export type AgentSession = {
  sessionId: string
  projectSlug: string | null
  projectPath: string | null
  cwd: string
  timestamp: string
  lastMessage: string | null
  messageCount: number
}

/** The signed-in user's agent base URL (null if no machine provisioned yet). */
export async function getServerUrl(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase
    .from('instances')
    .select('server_url')
    .eq('user_id', user.id)
    .single()
  const url = (data as { server_url?: string } | null)?.server_url
  return url ? url.replace(/\/+$/, '') : null
}

/** List the user's sessions straight from the agent. */
export async function listSessions(serverUrl: string): Promise<AgentSession[]> {
  const res = await fetch(`${serverUrl}/sessions?limit=200`, {
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) throw new Error(`sessions ${res.status}`)
  const data = (await res.json()) as { sessions?: AgentSession[] }
  return data.sessions ?? []
}

/**
 * Start (or resume) a voice session and return everything needed to join the
 * LiveKit room. POSTs the agent's open /connect-room (wakes + joins the room,
 * returns the authoritative roomName), then mints a token from the frontend's
 * no-auth /api/token. Native fetch is CORS-exempt so both calls go direct.
 */
export async function connectVoice(serverUrl: string, sessionId?: string): Promise<{ token: string; url: string }> {
  // 1) connect-room → authoritative roomName (osborn-<code>-<ts>)
  const cr = await fetch(`${serverUrl}/connect-room`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(60_000),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  const roomName: string | undefined = cr?.roomName
  const roomCode = roomName ? roomName.replace(/^osborn-/, '') : undefined

  // 2) mint a LiveKit token for that room
  const q = new URLSearchParams({
    provider: CONNECT_DEFAULTS.provider,
    voiceArch: CONNECT_DEFAULTS.voiceArch,
    codingAgent: CONNECT_DEFAULTS.codingAgent,
    clickTs: String(Date.now()),
  })
  if (roomCode) q.set('roomCode', roomCode)
  if (sessionId) q.set('sessionId', sessionId)
  const res = await fetch(`${FRONTEND_URL}/api/token?${q.toString()}`, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`token ${res.status}`)
  const data = (await res.json()) as { token?: string }
  if (!data.token) throw new Error('no token')
  return { token: data.token, url: '' } // url filled by caller from config
}

/** Compact relative time for a session row. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const diff = Date.now() - then
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}
