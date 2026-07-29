import { test, expect } from '@playwright/test'
import { installReactiveMic, waitForMicOpen, speakText } from '../lib/reactive-mic'
import { installActionVisualizer } from '../lib/action-visualizer'
import { readFileSync, writeFileSync } from 'fs'

/**
 * Proof the reactive mic works WITHOUT LiveKit/production in the loop:
 * a local page opens the mic exactly like a voice app (getUserMedia +
 * MediaRecorder), then the TEST speaks two on-demand utterances mid-session
 * — synthesized at runtime, not pre-recorded — and we transcribe what the
 * "app" heard. If both sentinel phrases come through, any web app consuming
 * getUserMedia will hear us the same way.
 */

function deepgramKey(): string {
  const env = readFileSync('/Users/newupgrade/Desktop/Developer/osborn/agent/.env', 'utf8')
  const m = env.match(/^DEEPGRAM_API_KEY=(\S+)/m)
  if (!m) throw new Error('DEEPGRAM_API_KEY not found in agent/.env')
  return m[1]
}

async function transcribe(webmPath: string): Promise<string> {
  const audio = readFileSync(webmPath)
  const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true', {
    method: 'POST',
    headers: { Authorization: `Token ${deepgramKey()}`, 'Content-Type': 'audio/webm' },
    body: audio,
  })
  if (!res.ok) throw new Error(`deepgram ${res.status}: ${await res.text()}`)
  const j: any = await res.json()
  return j?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
}

test('REACTIVE MIC: two on-demand utterances heard by a mic-consuming page', async ({ page }) => {
  test.setTimeout(120_000)

  await installReactiveMic(page)
  await installActionVisualizer(page)

  // Secure-context page (data: URLs have no mediaDevices).
  await page.route('http://localhost:4799/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body>mic consumer</body></html>' }),
  )
  await page.goto('http://localhost:4799/')

  // The "app": open the mic and record everything it hears.
  await page.evaluate(async () => {
    const w = window as any
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
    w.__chunks = []
    rec.ondataavailable = (e: BlobEvent) => e.data.size && w.__chunks.push(e.data)
    rec.start(250)
    w.__rec = rec
  })
  await waitForMicOpen(page)

  // Turn 1 — synthesized NOW, spoken mid-session.
  await speakText(page, 'First utterance, code silver falcon.')
  // A reactive pause (this is where a real test would read the app's reply).
  await page.waitForTimeout(1_500)
  // Turn 2 — a different phrase, proving repeat on-demand injection.
  await speakText(page, 'Second utterance, code golden tiger.')
  await page.waitForTimeout(1_000)

  const b64 = await page.evaluate(async () => {
    const w = window as any
    await new Promise<void>((res) => {
      w.__rec.onstop = () => res()
      w.__rec.stop()
    })
    const blob = new Blob(w.__chunks, { type: 'audio/webm' })
    const buf = await blob.arrayBuffer()
    let s = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(s)
  })
  const out = test.info().outputPath('reactive-mic-heard.webm')
  writeFileSync(out, Buffer.from(b64, 'base64'))

  const heard = await transcribe(out)
  console.log(`[reactive-mic] page heard: "${heard}"`)
  expect(heard.toLowerCase()).toContain('silver falcon')
  expect(heard.toLowerCase()).toContain('golden tiger')
})
