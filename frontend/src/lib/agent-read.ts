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

/** JSON request to a proxied agent route: resolves { ok, d } (d = parsed body). */
export type AgentRequest = (path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }) => Promise<{ ok: boolean; d: any }>

export const agentRequest = (agentUrl: string | null | undefined): AgentRequest => (path, init = {}) =>
  fetch(agentReadUrl(agentUrl, path), {
    method: init.method || 'GET',
    // Every POST is JSON: the agent refuses store writes that are not (no cross-site form or text/plain POST).
    ...(init.method === 'POST' || init.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body ?? {}) } : {}),
  }).then((r) => r.json().catch(() => ({})).then((d) => ({ ok: r.ok, d })))
