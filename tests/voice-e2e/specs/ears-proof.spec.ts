import { test, expect } from '@playwright/test'
import { startCapture, saveCapture } from '../lib/audio-capture'

/**
 * Self-contained proof of the "ears" — no app, no network, no vendor.
 * A data-URL page plays a synthesized tone via WebAudio; we capture the tab's
 * audio with getDisplayMedia + MediaRecorder and assert real bytes came out.
 * If this passes, the same capture works pointed at Osborn's TTS audio.
 */
test('tab audio capture produces non-trivial WebM (the ears work)', async ({ page }) => {
  // data: URLs are non-secure contexts (no navigator.mediaDevices) — serve
  // from a localhost origin via route interception instead (secure context).
  await page.route('http://localhost:4799/tone', (r) =>
    r.fulfill({ contentType: 'text/html', body: '<title>tone</title><h1>tone page</h1>' }))
  await page.goto('http://localhost:4799/tone')
  await startCapture(page)
  // play 2s of 440Hz through the tab
  await page.evaluate(() => new Promise<void>((res) => {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    osc.frequency.value = 440
    osc.connect(ctx.destination)
    osc.start()
    setTimeout(() => { osc.stop(); res() }, 2000)
  }))
  const out = test.info().outputPath('tone-capture.webm')
  const cap = await saveCapture(page, out)
  console.log(`[ears-proof] captured ${cap.bytes} bytes over ${cap.durationMs}ms → ${cap.path}`)
  expect(cap.durationMs).toBeGreaterThan(1500)
  expect(cap.bytes, 'captured audio should be substantially non-empty').toBeGreaterThan(10_000)
})
