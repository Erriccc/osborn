/**
 * #468: a page whose __mic says ready but has no audio context must give the named
 * no_mic error, never a raw "Cannot read properties of undefined (reading 'resume')".
 *   npx tsx --test lib/reactive-mic.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { isNoMic, speakWav } from './reactive-mic'

const wav = (() => {
  const n = 480, b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(48000, 24); b.writeUInt32LE(96000, 28)
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  const f = join(mkdtempSync(join(tmpdir(), 'mic-')), 'u.wav'); writeFileSync(f, b); return f
})()

test('ready without an audio context is no_mic, not a TypeError', async () => {
  const browser = await chromium.launch({ executablePath: process.env.OSBORN_TEST_CHROMIUM || undefined })
  try {
    const page = await browser.newPage()
    await page.goto('about:blank')
    await page.evaluate(() => { (window as any).__mic = { ready: true } })
    await assert.rejects(speakWav(page, wav), (e) => isNoMic(e))
  } finally { await browser.close() }
})
