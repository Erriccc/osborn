/**
 * Where to send a browser request to the agent's HTTP API.
 *
 * Cloud: go through the authenticated Next proxy (/api/agent/<path>), which
 * resolves the signed-in user's own machine + token server-side. The browser
 * never holds the agent token, and the agent fail-closes these routes so a
 * direct hit to the public fly.dev address is rejected.
 *
 * Local dev: the agent is on localhost with no auth, so hit it directly.
 *
 * Only used for the proxied paths (see PROXYABLE_GET / PROXYABLE_POST in
 * app/api/agent/[...path]/route.ts).
 */
export function agentReadUrl(agentUrl: string | null | undefined, path: string): string {
  const p = path.replace(/^\//, '')
  if (!agentUrl || agentUrl.startsWith('http://localhost') || agentUrl.startsWith('http://127.')) {
    return `${(agentUrl ?? '').replace(/\/$/, '')}/${p}`
  }
  return `/api/agent/${p}`
}

/** JSON request to a proxied agent route: resolves { ok, status, d } (d = parsed body). */
export type AgentRequest = (path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }) => Promise<{ ok: boolean; status: number; d: any }>

/** How long the /api/agent proxy waits for the machine: the first catalog read lists three GitHub repos. */
export const agentTimeoutMs = (path: string, method: 'GET' | 'POST' = 'GET') =>
  path.replace(/^\//, '').startsWith('store/') ? 90000 : method === 'POST' ? 30000 : 20000

// The browser waits a little longer than the proxy, so the proxy's own 502 arrives first;
// a hung request rejects (callers show UNREACHABLE) instead of loading forever.
export const agentRequest = (agentUrl: string | null | undefined): AgentRequest => (path, init = {}) =>
  fetch(agentReadUrl(agentUrl, path), {
    method: init.method || 'GET',
    signal: AbortSignal.timeout(agentTimeoutMs(path, init.method) + 5000),
    // Every POST is JSON: the agent refuses store writes that are not (no cross-site form or text/plain POST).
    ...(init.method === 'POST' || init.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body ?? {}) } : {}),
  }).then((r) => r.json().catch(() => ({})).then((d) => ({ ok: r.ok, status: r.status, d })))

export const UNREACHABLE = 'Could not reach your machine'

/** What to show for a failed agent request: the machine's catch-all 404 ("Not found", agent/src/index.ts) is an Osborn
 *  older than the route; any other 404 ("skill not found", "not in the catalog", the proxy's own refusal) says why. */
export const OUTDATED = 'Your machine runs an older Osborn. Update Osborn on your machine, then try again.'
export const agentError = (status: number, d: any, fallback: string): string =>
  status === 404 && /^not found$/i.test(d?.error ?? 'not found') ? OUTDATED : (d?.error || fallback)

/** A list load that failed: why, or that a reachable machine sent no `what`. */
export const listError = (ok: boolean, status: number, d: any, what: string): string =>
  agentError(status, d, ok ? `Your machine sent no ${what}` : UNREACHABLE)
