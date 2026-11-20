import assert from 'node:assert/strict'
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { chromium } from '@playwright/test'
import { installReactiveMic, speakWav, waitForMicOpen } from './reactive-mic'
import { startElementCapture } from './audio-capture'

// #214: a page with only the synthetic mic (no <audio>) never taps a source, and
// ears.audioClock stayed null on every turn, so a starved audio clock went unseen.
const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] }).catch(() => null)
if (!browser) { console.log('ears clock: skipped (no Chromium)'); process.exit(0) }
try {
  const ctx = await browser.newContext()
  await ctx.addInitScript(() => { (globalThis as any).__name = (globalThis as any).__name || ((f: any) => f) })
  const page = await ctx.newPage()
  await installReactiveMic(page)
  await page.route('http://localhost:9/', (r) => r.fulfill({ contentType: 'text/html', body: '<script>navigator.mediaDevices.getUserMedia({audio:true})</script>' }))
  await page.goto('http://localhost:9/')
  await waitForMicOpen(page)
  await startElementCapture(page)
  const wav = join(tmpdir(), `ears-clock-${process.pid}.wav`)
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=300:d=2', '-ar', '24000', wav])
  const t = Date.now()
  const audioMs = await speakWav(page, wav)
  assert.equal(audioMs, 2000, 'speakWav reports the length of the audio it played')
  assert.ok(Date.now() - t >= 1900, 'playing takes as long as the audio')
  const st = await page.evaluate(() => ({ tapped: !!(globalThis as any).__osbornAudioAnchor, rate: (globalThis as any).__osbornClock.rate() }))
  assert.equal(st.tapped, false, 'no page audio source was tapped')
  assert.ok(st.rate != null && st.rate > 0.8 && st.rate < 1.2, `audioClock reports with no tapped source (got ${st.rate})`)
  console.log('ears clock: all assertions passed')
} finally { await browser.close() }
