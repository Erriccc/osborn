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
