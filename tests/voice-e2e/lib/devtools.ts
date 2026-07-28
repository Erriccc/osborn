import type { Page } from '@playwright/test'

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
  summary: () => string
}

export function attachDevtools(page: Page, cap = 250): DevtoolsBuffer {
  const consoleBuf: string[] = []
  const networkBuf: string[] = []
  const push = (buf: string[], line: string) => {
    buf.push(`${new Date().toISOString().slice(11, 19)} ${line.slice(0, 300)}`)
    if (buf.length > cap) buf.shift()
  }
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
    // What the brain reads when deciding "is something broken": recent
    // errors/warnings + network failures, compact.
    summary() {
      const errors = consoleBuf.filter((l) => /\[(error|warning|pageerror)\]/.test(l)).slice(-15)
      const net = networkBuf.slice(-15)
      return `RECENT CONSOLE ERRORS/WARNINGS:\n${errors.join('\n') || '(none)'}\n\nRECENT NETWORK ISSUES/WS EVENTS:\n${net.join('\n') || '(none)'}`
    },
  }
}
