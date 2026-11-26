// Server-only config + helpers for proxying the browser-screen-recorder engine
// (issue #51). The engine is a Fly app (default `osborn-voice-e2e-k`) exposing a
// token-protected control API at https://<app>.fly.dev:8781 (/status, /act, …,
// and /stream: the MJPEG of the caller's own tab). Its public live view shows only
// a tab a driver has cast, so the panel never uses it.
//
// The frontend proxies the control API so the panel never touches the raw Fly URL
// and the engine token stays server-side. NEVER import this from a client component.

export const DEFAULT_ENGINE_APP = 'osborn-voice-e2e-k'

export function engineApp(): string {
  return (process.env.FLY_HARNESS_APP || DEFAULT_ENGINE_APP).trim()
}

function engineHost(): string {
  // Explicit override wins; otherwise derive the Fly hostname from the app name.
  const override = (process.env.BROWSER_ENGINE_HOST || '').trim()
  return override || `${engineApp()}.fly.dev`
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

// Only these engine endpoints may be reached through the proxy. `eval`, `brain`,
// and `journey` are intentionally omitted — `eval` runs arbitrary JS in the page,
// and the others are advanced/destructive beyond the panel's remit.
export const GET_ALLOW = new Set(['health', 'status', 'tasks', 'logs', 'clip', 'artifact', 'audio', 'events'])
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

// Pure: the engine's per-tab MJPEG URL. The engine shows the caller (sent as
// `x-driver-id` with the engine token) only a tab it owns: `tab` picks one of
// them, and without it the stream follows the caller's current tab. Every other
// query parameter is dropped. Exported for tests.
export function buildStreamTarget(search = ''): string {
  const tab = new URLSearchParams(search.replace(/^\?/, '')).get('tab')
  const base = `${controlBase()}/stream`
  return tab != null && /^\d+$/.test(tab) ? `${base}?tab=${tab}` : base
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
