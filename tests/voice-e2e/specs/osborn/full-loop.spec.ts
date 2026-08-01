import { envKey } from '../../lib/env'
import { test, expect } from '@playwright/test'
import { startCapture, saveCapture } from '../../lib/audio-capture'
import { readFileSync } from 'fs'

/**
 * THE full loop: real app, real machine, real audio, both directions.
 *
 *   fake mic speaks fixture ("...reply with the single word pineapple")
 *     → voice-native.com/chat → LiveKit Cloud → osborn-d4f24f46-v2
 *     → Deepgram STT → Claude → OpenAI TTS → browser speaker
 *     → our tab capture records it → Deepgram transcribes the CAPTURE
 *     → assert "pineapple" was audibly SPOKEN (not just displayed)
 *
 * Guest mode needs no auth: /chat accepts agentUrl as a query param.
 */

const AGENT_URL = process.env.OSBORN_AGENT_URL || 'https://osborn-1b9d70e5-v2.fly.dev'
const CHAT_URL = `/chat?provider=gemini&voiceArch=pipeline&agent=claude&agentUrl=${encodeURIComponent(AGENT_URL)}`

// Room hygiene: always leave the LiveKit room on exit so the machine idles
// from a clean state (prevents the empty-room wedge/alone-timer races).
test.afterEach(async () => { await fetch(`${AGENT_URL}/leave-room`, { method: 'POST' }).catch(() => {}) })


function deepgramKey(): string {
  return envKey('DEEPGRAM_API_KEY')
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

test('FULL LOOP: spoken question → agent speaks pineapple → we hear it', async ({ page }) => {
  test.setTimeout(300_000)
  const t0 = Date.now()

  await page.goto(CHAT_URL, { timeout: 45_000 })

  // The session gate ("Previous Sessions — Continue or start fresh") appears
  // BEFORE the voice room on machines with history. Handle it first.
  const gateHeading = page.getByText(/previous sessions/i).first()
  const roomReady = page.locator('text=/listening|speaking|thinking|connected/i').first()
    .or(page.locator('[class*="chat"], [class*="voice"], [class*="visualiz"]').first())
  await expect(gateHeading.or(roomReady)).toBeVisible({ timeout: 120_000 })
  if (await gateHeading.isVisible().catch(() => false)) {
    // start a clean conversation so history can't contaminate assertions
    await page.getByRole('button', { name: /fresh|new/i }).first().click()
  }
  await expect(roomReady).toBeVisible({ timeout: 60_000 })
  const tConnected = Date.now()
  console.log(`[full-loop] connected in ${tConnected - t0}ms (gate handled)`)

  // Ears on — record everything the page plays from here.
  await startCapture(page)

  // The fake mic speaks the fixture as soon as the app opens the mic.
  // STT proof: our words appear as user transcript.
  await expect(page.getByText(/purple elephant/i).first()).toBeVisible({ timeout: 90_000 })
  const tStt = Date.now()
  console.log(`[full-loop] STT transcript visible +${tStt - tConnected}ms`)

  // Reply proof in TEXT (chat mirrors TTS content).
  await expect(page.getByText(/pineapple/i).first()).toBeVisible({ timeout: 90_000 })
  const tReply = Date.now()
  console.log(`[full-loop] text reply +${tReply - tStt}ms`)

  // Let the TTS finish speaking, then pull the recording.
  await page.waitForTimeout(12_000)
  const out = test.info().outputPath('full-loop-capture.webm')
  const cap = await saveCapture(page, out)
  console.log(`[full-loop] captured ${cap.bytes} bytes over ${cap.durationMs}ms`)
  expect(cap.bytes, 'captured agent speech should be non-trivial').toBeGreaterThan(20_000)

  // THE money assertion: transcribe what we HEARD. If "pineapple" is in the
  // audio transcript, the agent audibly spoke the requested word — complete
  // ears+mouth+hands validation of the production voice path.
  const heard = await transcribe(out)
  console.log(`[full-loop] Deepgram heard: "${heard.slice(0, 200)}"`)
  expect(heard.toLowerCase(), 'agent should have SPOKEN the word pineapple').toContain('pineapple')
})
