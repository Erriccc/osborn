import { test, expect, chromium } from '@playwright/test'
import { startCapture, saveCapture } from '../lib/audio-capture'

/**
 * Browserless variant of the ears proof — same tone test, but the browser
 * runs INSIDE the self-hosted Browserless container instead of locally.
 *
 * Two capture paths get evaluated:
 *  A. Our own getDisplayMedia capture, running remotely (works anywhere
 *     Chromium does — this validates BaaS portability of the DIY ears)
 *  B. Browserless's native screencast recording (the research-verified
 *     "WebM with audio automatically" feature) — probed separately since
 *     its availability may be plan-gated on the self-hosted image.
 *
 * Connect string notes: Browserless v2 accepts Playwright over
 * ws://host:3000/chromium/playwright with launch args passed as a JSON
 * `launch` query param — that's how the fake-mic + tab-capture flags reach
 * the remote browser.
 */

const TOKEN = process.env.BROWSERLESS_TOKEN || 'osborn-local-test'
const HOST = process.env.BROWSERLESS_HOST || 'localhost:3000'

const LAUNCH = JSON.stringify({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--auto-accept-this-tab-capture',
  ],
})

test('DIY ears work inside a Browserless container', async () => {
  const browser = await chromium.connect(
    `ws://${HOST}/chromium/playwright?token=${TOKEN}&launch=${encodeURIComponent(LAUNCH)}`,
  )
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.route('http://localhost:4799/tone', (r) =>
    r.fulfill({ contentType: 'text/html', body: '<title>tone</title><h1>remote tone page</h1>' }))
  await page.goto('http://localhost:4799/tone', { timeout: 30000 })

  await startCapture(page)
  await page.evaluate(() => new Promise<void>((res) => {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    osc.frequency.value = 523 // C5, distinguishable from the local proof's 440
    osc.connect(ctx.destination)
    osc.start()
    setTimeout(() => { osc.stop(); res() }, 2000)
  }))
  const out = test.info().outputPath('browserless-capture.webm')
  const cap = await saveCapture(page, out)
  console.log(`[browserless-proof] captured ${cap.bytes} bytes over ${cap.durationMs}ms → ${cap.path}`)
  await browser.close()
  expect(cap.bytes, 'remote-captured audio should be non-empty').toBeGreaterThan(10_000)
})
