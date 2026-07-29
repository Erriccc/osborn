import { test, expect } from '@playwright/test'
import { startCapture, saveCapture } from '../lib/audio-capture'
import { installReactiveMic, waitForMicOpen, speakText } from '../lib/reactive-mic'
import { installActionVisualizer } from '../lib/action-visualizer'
import { readFileSync } from 'fs'

/**
 * REACTIVE CONVERSATION: multi-turn, back-and-forth, nothing pre-recorded.
 *
 * Turn 1 is a riddle whose answer ("banana") never appears in our audio —
 * so any banana on screen/in audio MUST have come from the agent.
 * Turn 2 is spoken only AFTER we read the agent's reply, and asks it to
 * recall what it just said — proving both directions of reactivity:
 * ours (we chose turn 2 based on turn 1's outcome) and the agent's
 * (it must use conversation context to answer).
 */

const AGENT_URL = process.env.OSBORN_AGENT_URL || 'https://osborn-d4f24f46-v2.fly.dev'
const CHAT_URL = `/chat?provider=gemini&voiceArch=pipeline&agent=claude&agentUrl=${encodeURIComponent(AGENT_URL)}`

// Room hygiene: always leave the LiveKit room on exit so the machine idles
// from a clean state (prevents the empty-room wedge/alone-timer races).
test.afterEach(async () => { await fetch(`${AGENT_URL}/leave-room`, { method: 'POST' }).catch(() => {}) })


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

test('CONVERSATION: two reactive turns — riddle, then recall of own answer', async ({ page }) => {
  test.setTimeout(360_000)
  const t0 = Date.now()

  await installReactiveMic(page)
  await installActionVisualizer(page)

  // Pre-connect the agent to its room BEFORE the browser joins. The deployed
  // frontend loses the join race when the agent has idle-left (fixed in
  // 0.9.76 + ChatSessionProvider Step 2.6, not yet deployed) — the agent
  // never sees a participant that was already in the room.
  await fetch(`${AGENT_URL}/connect-room`, { method: 'POST' }).catch(() => {})
  await expect(async () => {
    const h: any = await fetch(`${AGENT_URL}/health`).then((r) => r.json())
    expect(h?.livekit?.status).toBe('connected')
  }).toPass({ timeout: 60_000, intervals: [1_000] })
  console.log(`[conv] agent pre-connected to room +${Date.now() - t0}ms`)

  await page.goto(CHAT_URL, { timeout: 45_000 })

  // Session gate appears before the room on machines with history.
  const gateHeading = page.getByText(/previous sessions/i).first()
  const roomReady = page.locator('text=/listening|speaking|thinking|connected/i').first()
    .or(page.locator('[class*="chat"], [class*="voice"], [class*="visualiz"]').first())
  await expect(gateHeading.or(roomReady)).toBeVisible({ timeout: 120_000 })
  if (await gateHeading.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: /fresh|new/i }).first().click()
  }
  await expect(roomReady).toBeVisible({ timeout: 60_000 })

  // Wait for the app to actually open the mic, then a beat for LiveKit
  // publish + Deepgram socket to warm up (replaces the old 6s WAV lead-in).
  await waitForMicOpen(page)
  await page.waitForTimeout(5_000)
  await startCapture(page)
  console.log(`[conv] room + mic ready in ${Date.now() - t0}ms`)

  // ---- TURN 1: the riddle. "banana" is never in our audio. ----
  const t1 = Date.now()
  await speakText(page, 'Osborn, quick voice test. Which fruit is yellow and curved? Answer with just the name of the fruit.')
  console.log(`[conv] turn 1 spoken (+${Date.now() - t1}ms utterance)`)

  const banana = page.getByText(/banana/i)
  await expect(banana.first()).toBeVisible({ timeout: 90_000 })
  const countAfterTurn1 = await banana.count()
  console.log(`[conv] turn 1 reply on screen +${Date.now() - t1}ms (banana x${countAfterTurn1})`)

  // Let the TTS finish saying it before we take our turn.
  await page.waitForTimeout(8_000)

  // ---- TURN 2: chosen because turn 1 succeeded — pure reaction. ----
  const t2 = Date.now()
  await speakText(page, 'Correct. Now tell me, what was the word you just said? Repeat only that word.')
  console.log(`[conv] turn 2 spoken`)

  // The agent must produce a NEW banana from conversation context.
  await expect(async () => {
    expect(await banana.count()).toBeGreaterThan(countAfterTurn1)
  }).toPass({ timeout: 90_000 })
  console.log(`[conv] turn 2 recall on screen +${Date.now() - t2}ms (banana x${await banana.count()})`)

  // Let turn 2's TTS land in the recording, then verify what we HEARD.
  await page.waitForTimeout(10_000)
  const out = test.info().outputPath('conversation-capture.webm')
  const cap = await saveCapture(page, out)
  console.log(`[conv] captured ${cap.bytes} bytes over ${cap.durationMs}ms`)
  expect(cap.bytes).toBeGreaterThan(20_000)

  const heard = await transcribe(out)
  console.log(`[conv] Deepgram heard: "${heard.slice(0, 300)}"`)
  const spokenBananas = (heard.toLowerCase().match(/banana/g) || []).length
  console.log(`[conv] agent audibly said "banana" ${spokenBananas} time(s)`)
  expect(spokenBananas, 'agent should have SPOKEN banana at least twice (riddle + recall)').toBeGreaterThanOrEqual(2)
})
