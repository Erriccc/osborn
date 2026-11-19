import assert from 'node:assert/strict'
import type { Page } from '@playwright/test'
import { startLiveStream } from './live-stream'

// A fake tab whose CDP session lets the test push screencast frames by hand.
const fakeTab = () => {
  const handlers: Record<string, (f: unknown) => void> = {}
  const session = { on: (e: string, cb: (f: unknown) => void) => { handlers[e] = cb }, send: async () => ({}), detach: async () => {} }
  const page = { context: () => ({ newCDPSession: async () => session }), isClosed: () => false, once: () => {} } as unknown as Page
  return { page, frame: (text: string) => handlers['Page.screencastFrame']?.({ sessionId: 1, data: Buffer.from(text).toString('base64') }) }
}

const a = fakeTab(), b = fakeTab()
const live = await startLiveStream(a.page, { port: 0 })
let code = 0
try {
  a.frame('tab-a')
  await new Promise((r) => setTimeout(r, 20))
  const decode = (b64: string | null) => (b64 ? Buffer.from(b64, 'base64').toString() : null)
  // The stream is on tab A: A's own shot may fall back to the stream frame.
  assert.equal(decode(live.latestFrame(a.page)), 'tab-a')
  // Tab B has no frames of its own: never hand it tab A's frame (#256).
  assert.equal(live.latestFrame(b.page), null)
  // No page asked for: the stream's newest frame, as before.
  assert.equal(decode(live.latestFrame()), 'tab-a')
  console.log('live-stream latestFrame: all assertions passed')
} catch (e) {
  console.error(e); code = 1
} finally {
  await live.stop()
  process.exit(code)  // the stream's timers would otherwise keep the process alive
}
