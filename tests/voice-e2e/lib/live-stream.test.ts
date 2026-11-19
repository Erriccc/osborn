import assert from 'node:assert/strict'
import type { Page } from '@playwright/test'
import { startLiveStream } from './live-stream'
import { NOTHING_SHARED_JPEG } from './nothing-shared'

// A fake tab: each CDP session it opens gets the screencast frames the test pushes by hand.
const fakeTab = () => {
  const handlers: Array<(f: unknown) => void> = []
  const newSession = async () => ({ on: (e: string, cb: (f: unknown) => void) => { if (e === 'Page.screencastFrame') handlers.push(cb) }, send: async () => ({}), detach: async () => {} })
  const page = { context: () => ({ newCDPSession: newSession }), isClosed: () => false, once: () => {} } as unknown as Page
  return { page, frame: (text: string) => handlers.forEach((h) => h({ sessionId: 1, data: Buffer.from(text).toString('base64') })) }
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const decode = (b64: string | null) => (b64 ? Buffer.from(b64, 'base64').toString() : null)

// Read an MJPEG response until `want` shows up in it (or give up after 3s).
const watch = async (url: string) => {
  const ctrl = new AbortController()
  const reader = (await fetch(url, { signal: ctrl.signal })).body!.getReader()
  let seen = Buffer.alloc(0)
  const until = async (want: Buffer | string) => {
    const deadline = Date.now() + 3000
    while (!seen.includes(want)) {
      const r = await Promise.race([reader.read(), tick(Math.max(1, deadline - Date.now())).then(() => null)])
      if (!r || r.done) return false
      seen = Buffer.concat([seen, Buffer.from(r.value)])
    }
    return true
  }
  return { until, seenText: () => seen.toString('latin1'), close: () => ctrl.abort() }
}

const a = fakeTab(), b = fakeTab()
const port = 18000 + Math.floor(Math.random() * 2000)
const live = await startLiveStream(a.page, { port })
let code = 0
try {
  a.frame('tab-a')
  await tick()
  // The shared screencast is on tab A: A's own shot may fall back to its frame.
  assert.equal(decode(live.latestFrame(a.page)), 'tab-a')
  // Tab B has no frames of its own: never hand it tab A's frame (#256).
  assert.equal(live.latestFrame(b.page), null)
  assert.equal(decode(live.latestFrame()), 'tab-a')

  // The public stream shows nothing until a tab is cast, even though tab A is fronted.
  const pub = await watch(`http://127.0.0.1:${port}/stream`)
  assert.ok(await pub.until(NOTHING_SHARED_JPEG.subarray(0, 64)), 'public stream starts on the nothing-shared frame')
  a.frame('tab-a-secret'); await tick()
  assert.ok(!pub.seenText().includes('tab-a-secret'), 'the fronted tab never reaches the public stream')
  // Cast tab B: the public stream shows B's frames, and only B's.
  live.setCast(b.page); await tick()
  b.frame('tab-b-shared')
  assert.ok(await pub.until('tab-b-shared'), 'the cast tab is shown')
  a.frame('tab-a-again'); await tick()
  assert.ok(!pub.seenText().includes('tab-a-again'), 'still never the fronted tab')
  assert.equal(live.castTab(), b.page)
  // Uncast: back to nothing shared within the 1s re-check.
  const before = pub.seenText().length
  live.setCast(null)
  b.frame('tab-b-after-uncast'); await tick(1200)
  assert.ok(!pub.seenText().slice(before).includes('tab-b-after-uncast'), 'an uncast tab stops at once')
  pub.close()
  const ready = await (await fetch(`http://127.0.0.1:${port}/ready`)).json()
  assert.equal(ready.shared, false)
  console.log('live-stream: all assertions passed')
} catch (e) {
  console.error(e); code = 1
} finally {
  await live.stop()
  process.exit(code)  // the stream's timers would otherwise keep the process alive
}
