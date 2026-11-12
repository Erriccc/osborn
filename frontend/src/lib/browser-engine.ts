// Server-only config + helpers for proxying the browser-screen-recorder engine
// (issue #51). The engine is a Fly app (default `osborn-voice-e2e-n`) exposing:
//   - a public MJPEG live view at  https://<app>.fly.dev/stream   (port 443)
//   - a token-protected control API at https://<app>.fly.dev:8781 (/status, /act, …)
//
// The frontend proxies both so the panel never touches the raw Fly URL and the
// engine/stream tokens stay server-side. NEVER import this from a client component.

const DEFAULT_APP = 'osborn-voice-e2e-n'

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

// True when the server has an engine token to attach as `x-engine-token`. The
// client is told ONLY this boolean (never the value), so a missing/mismatched
// token is legible in the panel instead of surfacing as a cryptic per-action 401.
export function engineTokenConfigured(): boolean {
  return engineToken().length > 0
}

// NOT dead code: consumed transitively by buildStreamTarget() (appended as the
// `?key=` on the MJPEG stream URL). The stream path authenticates via this stream
// key, not the x-engine-token header — which is why the live view keeps working
// even when the engine (control-API) token is missing or mismatched.
export function streamToken(): string {
  return (process.env.OSBORN_STREAM_TOKEN || '').trim()
}

// Only these engine endpoints may be reached through the proxy. `eval`, `brain`,
// and `journey` are intentionally omitted — `eval` runs arbitrary JS in the page,
// and the others are advanced/destructive beyond the panel's remit.
export const GET_ALLOW = new Set(['status', 'tasks', 'logs', 'clip', 'artifact', 'audio', 'events'])
export const POST_ALLOW = new Set(['act', 'say', 'hear', 'tab', 'end', 'recover', 'input'])

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
  // The host the proxy targets (e.g. <app>.fly.dev — a hostname, not a Fly app
  // name), carried in the engine-state payload so a failure can name it (#62/#49).
  host: string
  // True when the Fly token IS configured but the Machines API read FAILED: `state`
  // is null because we couldn't READ it (wrong app name, mis-scoped FLY_API_TOKEN,
  // Fly outage), NOT because the engine is down — amber, never red (#81/#115).
  unreachable: boolean
}

// Report awake/asleep WITHOUT waking the engine, by asking the Fly Machines API
// for the app's machine state: any request to the app itself auto-starts it, so a
// failed read is NEVER confirmed against the engine — that probe bills compute.
// Best-effort — returns {configured:false} if no token.
export async function engineMachineState(): Promise<EngineMachineState> {
  const host = engineHost()
  const flyToken = (process.env.FLY_API_TOKEN || '').trim()
  if (!flyToken) return { configured: false, state: null, machineId: null, host, unreachable: false }
  try {
    const res = await fetch(`https://api.machines.dev/v1/apps/${engineApp()}/machines`, {
      headers: { Authorization: `Bearer ${flyToken}`, 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { configured: true, state: null, machineId: null, host, unreachable: true }
    const machines = (await res.json()) as Array<{ id: string; state: string }>
    const m = Array.isArray(machines) && machines.length ? machines[0] : null
    return { configured: true, state: m?.state ?? 'destroyed', machineId: m?.id ?? null, host, unreachable: false }
  } catch {
    return { configured: true, state: null, machineId: null, host, unreachable: true }
  }
}

// Best-effort wake: ask the Fly Machines API to START the engine's machine so a
// user's retry lands on a booting engine instead of another connection-refused.
// A control-API request to a stopped machine already triggers Fly's auto-start,
// but issuing the start explicitly covers the case where it didn't. Bounded and
// silent — returns false (never throws) when there's no token or the call fails.
export async function startEngineMachine(machineId: string | null): Promise<boolean> {
  const flyToken = (process.env.FLY_API_TOKEN || '').trim()
  if (!flyToken || !machineId) return false
  try {
    const res = await fetch(
      `https://api.machines.dev/v1/apps/${engineApp()}/machines/${machineId}/start`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${flyToken}`, 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      },
    )
    return res.ok
  } catch {
    return false
  }
}

// Classify a thrown `fetch()` failure against the engine so the proxy can give a
// cold-start-aware reason instead of a bare opaque 502 (#102/#104). undici
// surfaces the socket error on `.cause.code`; an AbortSignal.timeout fires a
// TimeoutError. 'refused' is the mid-boot window (VM up, engine not yet
// listening on :8781) and is the retry-worthy case.
export type EngineErrorKind = 'timeout' | 'refused' | 'dns' | 'network'
export function classifyFetchError(e: unknown): EngineErrorKind {
  const err = e as { name?: string; code?: string; cause?: { code?: string } }
  const name = err?.name ?? ''
  const code = err?.cause?.code ?? err?.code ?? ''
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout'
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'refused'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
  return 'network'
}
