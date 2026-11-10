// Server-only config + helpers for proxying the browser-screen-recorder engine
// (issue #51). The engine is a Fly app (default `osborn-voice-e2e`) exposing:
//   - a public MJPEG live view at  https://<app>.fly.dev/stream   (port 443)
//   - a token-protected control API at https://<app>.fly.dev:8781 (/status, /act, …)
//
// The frontend proxies both so the panel never touches the raw Fly URL and the
// engine/stream tokens stay server-side. NEVER import this from a client component.

const DEFAULT_APP = 'osborn-voice-e2e'

export function engineApp(): string {
  return (process.env.FLY_HARNESS_APP || DEFAULT_APP).trim()
}

function engineHost(): string {
  // Explicit override wins; otherwise derive the Fly hostname from the app name.
  const override = (process.env.BROWSER_ENGINE_HOST || '').trim()
  return override || `${engineApp()}.fly.dev`
}

// The MJPEG viewer + /stream live on the app's 443 http_service (internal 8080).
export function streamBase(): string {
  return (process.env.BROWSER_ENGINE_STREAM_URL || `https://${engineHost()}`).replace(/\/+$/, '')
}

// The control API is a separate Fly service on :8781 (tls+http).
export function controlBase(): string {
  return (process.env.BROWSER_ENGINE_CONTROL_URL || `https://${engineHost()}:8781`).replace(/\/+$/, '')
}

export function engineToken(): string {
  return (process.env.OSBORN_ENGINE_TOKEN || '').trim()
}

export function streamToken(): string {
  return (process.env.OSBORN_STREAM_TOKEN || '').trim()
}

// Only these engine endpoints may be reached through the proxy. `eval`, `brain`,
// and `journey` are intentionally omitted — `eval` runs arbitrary JS in the page,
// and the others are advanced/destructive beyond the panel's remit.
export const GET_ALLOW = new Set(['status', 'tasks', 'logs', 'clip', 'artifact', 'audio', 'events'])
export const POST_ALLOW = new Set(['act', 'say', 'hear', 'tab', 'end', 'recover'])

// Pure: the full control-API URL for an allowlisted action + querystring. The
// auth token is sent as a header, never in the URL. Returns null if not allowed.
// Exported for tests.
export function buildControlTarget(
  method: 'GET' | 'POST',
  action: string,
  search = '',
): string | null {
  const allow = method === 'GET' ? GET_ALLOW : POST_ALLOW
  if (!allow.has(action)) return null
  const qs = search && search !== '?' ? (search.startsWith('?') ? search : `?${search}`) : ''
  return `${controlBase()}/${action}${qs}`
}

// Pure: the MJPEG stream URL, with the stream key appended when configured.
// Exported for tests. (This URL is used server-side only; the token is not sent
// to the browser — the client fetches our /api/browser/stream proxy instead.)
export function buildStreamTarget(search = ''): string {
  const base = `${streamBase()}/stream`
  const params = new URLSearchParams(search.replace(/^\?/, ''))
  const key = streamToken()
  if (key) params.set('key', key)
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

export type EngineMachineState = {
  configured: boolean
  state: string | null // 'started' | 'stopped' | 'starting' | … | null when unknown
  machineId: string | null
}

// Report awake/asleep WITHOUT waking the engine, by asking the Fly Machines API
// for the app's machine state (any request to the app itself would auto-start it,
// defeating the purpose). Best-effort — returns {configured:false} if no token.
export async function engineMachineState(): Promise<EngineMachineState> {
  const flyToken = (process.env.FLY_API_TOKEN || '').trim()
  if (!flyToken) return { configured: false, state: null, machineId: null }
  try {
    const res = await fetch(`https://api.machines.dev/v1/apps/${engineApp()}/machines`, {
      headers: { Authorization: `Bearer ${flyToken}`, 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { configured: true, state: null, machineId: null }
    const machines = (await res.json()) as Array<{ id: string; state: string }>
    const m = Array.isArray(machines) && machines.length ? machines[0] : null
    return { configured: true, state: m?.state ?? 'destroyed', machineId: m?.id ?? null }
  } catch {
    return { configured: true, state: null, machineId: null }
  }
}
