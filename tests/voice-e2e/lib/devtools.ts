import type { Page } from '@playwright/test'
import { redactSecrets } from './redactSecrets'

/**
 * Frontend-only diagnostics — the tester's DevTools sense. App-agnostic by
 * design: console messages, page errors, failed/erroring network requests,
 * and websocket lifecycle, collected passively from page events. No backend
 * access assumed — this works on ANY website, exactly like a human opening
 * DevTools to see "is something broken."
 *
 * The orchestrating agent (Claude holding the skills) separately brings
 * privileged backend watchers (fly logs, railway) when testing OUR app and
 * correlates the two views — but that lives outside this generic layer.
 */

export type DevtoolsBuffer = {
  console: string[]
  network: string[]
  // The lines recorded at or after `ms` (epoch), e.g. since a person took control.
  since: (ms: number) => { console: string[]; network: string[] }
  summary: () => string
}

/**
 * Diagnostics land in public evidence logs, so secrets are blanked before they
 * are stored (and the public task log is passed through again when served):
 * credential-like URL parameters (a LiveKit room URL carries its
 * access_token) and any JWT.
 */
// URL parameters named like credentials, compound names included (session_token,
// x-auth-token); every other shape (JWTs, auth headers, key prefixes, NAME=value
// settings) is the product's one redactor, copied in by the harness build.
const SECRET_PARAM = /([?&#](?:[\w-]*(?:token|secret|password|signature)|apikey|api_key|key|auth|code|sig)=)[^&#\s]+/gi
export const redactDiagnostics = (line: string): string =>
  redactSecrets(line.replace(SECRET_PARAM, '$1••••'))

export function attachDevtools(page: Page, cap = 250): DevtoolsBuffer {
  const consoleBuf: string[] = []
  const networkBuf: string[] = []
  const times = new Map<string[], number[]>([[consoleBuf, []], [networkBuf, []]])
  const push = (buf: string[], line: string) => {
    buf.push(`${new Date().toISOString().slice(11, 19)} ${redactDiagnostics(line.slice(0, 4000)).slice(0, 300)}`)
    times.get(buf)!.push(Date.now())
    if (buf.length > cap) { buf.shift(); times.get(buf)!.shift() }
  }
  const after = (buf: string[], ms: number) => buf.filter((_, k) => times.get(buf)![k] >= ms)
  page.on('console', (m) => push(consoleBuf, `[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => push(consoleBuf, `[pageerror] ${e.message}`))
  page.on('requestfailed', (r) => push(networkBuf, `[FAILED] ${r.method()} ${r.url()} — ${r.failure()?.errorText}`))
  page.on('response', (r) => { if (r.status() >= 400) push(networkBuf, `[${r.status()}] ${r.request().method()} ${r.url()}`) })
  page.on('websocket', (ws) => {
    push(networkBuf, `[ws open] ${ws.url()}`)
    ws.on('close', () => push(networkBuf, `[ws close] ${ws.url()}`))
    ws.on('socketerror', (e) => push(networkBuf, `[ws error] ${ws.url()} — ${e}`))
  })
  return {
    console: consoleBuf,
    network: networkBuf,
    since: (ms: number) => ({ console: after(consoleBuf, ms), network: after(networkBuf, ms) }),
    // What the brain reads when deciding "is something broken": recent
    // errors/warnings + network failures, compact.
    summary() {
      const errors = consoleBuf.filter((l) => /\[(error|warning|pageerror)\]/.test(l)).slice(-15)
      const net = networkBuf.slice(-15)
      return `RECENT CONSOLE ERRORS/WARNINGS:\n${errors.join('\n') || '(none)'}\n\nRECENT NETWORK ISSUES/WS EVENTS:\n${net.join('\n') || '(none)'}`
    },
  }
}
