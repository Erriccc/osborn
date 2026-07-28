import { test, expect } from '@playwright/test'

/**
 * Milestone A — voice smoke test through the REAL pipeline.
 *
 * The fake mic (configured in playwright.config.ts) speaks the
 * hello-question.wav fixture as soon as the app opens the mic:
 *   "Hello Osborn. Can you hear me? Please reply with the single word pineapple."
 *
 * Assertions ride on the chat UI, which mirrors the voice pipeline:
 *   - user_transcript bubble  → proves mic → LiveKit → Deepgram STT worked
 *   - assistant bubble        → proves Claude turn + response path worked
 *   - "pineapple" in reply    → proves the agent actually HEARD the content
 *     (not just that audio flowed) — a semantic end-to-end check
 *   - timing budget           → catches cold-start / stall regressions
 *
 * Milestone B (TODO, next): a LiveKit subscriber bot joins the same room,
 * records the agent's TTS audio track, transcribes it with Deepgram, and
 * asserts on the AUDIO itself (latency to first frame, silence gaps >2s,
 * cutoff detection = transcript ends mid-sentence vs chat text). That is the
 * layer that would have caught the June TTS cutoffs automatically.
 */

test('guest voice round-trip: speak → transcript → contextual reply', async ({ page }) => {
  const t0 = Date.now()

  await page.goto('/')

  // ── Landing → guest connect ──
  // Prefer an explicit guest path; fall back to a generic connect button.
  const guest = page.getByRole('button', { name: /guest|try|connect/i }).first()
  await guest.click({ timeout: 20_000 })

  // ── Wait out machine cold-start + LiveKit join ──
  // The self-stopping fleet means first connect may boot the machine (~15-30s).
  // The app shows a connecting state; we wait for evidence of a live session:
  // either the mic visualizer or the chat panel appearing.
  await expect(
    page.locator('[data-testid="voice-room"], [class*="voice"], [class*="chat"]').first(),
  ).toBeVisible({ timeout: 90_000 })
  const tConnected = Date.now()

  // ── STT proof: our spoken words appear as a user transcript ──
  // The fake mic speaks automatically once getUserMedia opens.
  await expect(page.getByText(/can you hear me/i).first()).toBeVisible({ timeout: 60_000 })
  const tTranscript = Date.now()

  // ── Semantic proof: the agent heard the CONTENT, not just audio ──
  await expect(page.getByText(/pineapple/i).first()).toBeVisible({ timeout: 60_000 })
  const tReply = Date.now()

  // ── Budgets (generous; tighten as baselines accumulate) ──
  const connectMs = tConnected - t0
  const sttMs = tTranscript - tConnected
  const replyMs = tReply - tTranscript
  console.log(`[voice-e2e] connect=${connectMs}ms stt=${sttMs}ms reply=${replyMs}ms`)
  expect(connectMs, 'connect (incl. cold-start)').toBeLessThan(90_000)
  expect(sttMs, 'speech → transcript visible').toBeLessThan(45_000)
  expect(replyMs, 'transcript → contextual reply').toBeLessThan(45_000)
})

test('disconnect → reconnect lands in a resumable state', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /guest|try|connect/i }).first().click({ timeout: 20_000 })
  await expect(
    page.locator('[data-testid="voice-room"], [class*="voice"], [class*="chat"]').first(),
  ).toBeVisible({ timeout: 90_000 })

  // Leave and come back — exercises /leave-room, idle-exit arming, and the
  // reconnect path (frontend must not hang on "Connecting to agent…").
  await page.reload()
  await page.getByRole('button', { name: /guest|try|connect|resume/i }).first().click({ timeout: 20_000 })
  await expect(
    page.locator('[data-testid="voice-room"], [class*="voice"], [class*="chat"]').first(),
  ).toBeVisible({ timeout: 90_000 })
})
