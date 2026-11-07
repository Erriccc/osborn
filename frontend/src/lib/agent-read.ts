/**
 * Where to send a browser read of the agent's HTTP API.
 *
 * Cloud: go through the authenticated Next proxy (/api/agent/<path>), which
 * resolves the signed-in user's own machine + token server-side. The browser
 * never holds the agent token, and the agent fail-closes these routes so a
 * direct hit to the public fly.dev address is rejected.
 *
 * Local dev: the agent is on localhost with no auth, so hit it directly.
 *
 * Only used for the proxied read paths (see PROXYABLE_GET in
 * app/api/agent/[...path]/route.ts): 'sessions', 'session-messages'.
 */
export function agentReadUrl(agentUrl: string | null | undefined, path: string): string {
  const p = path.replace(/^\//, '')
  if (!agentUrl || agentUrl.startsWith('http://localhost') || agentUrl.startsWith('http://127.')) {
    return `${(agentUrl ?? '').replace(/\/$/, '')}/${p}`
  }
  return `/api/agent/${p}`
}
