import { test, expect, chromium } from '@playwright/test'
import { Stagehand } from '@browserbasehq/stagehand'
import { installReactiveMic, waitForMicOpen, speakText } from '../../lib/reactive-mic'
import { installActionVisualizer } from '../../lib/action-visualizer'
import { saveCapture } from '../../lib/audio-capture'
import { enterFreshRoom, drainSpeechEvents, waitForSpeechEvent } from '../../lib/steps'
import { envKey } from '../../lib/env'
import { actWithCache } from '../../lib/step-cache'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * BRAIN + EARS + MOUTH: the full agent-attachable stack.
 *
 *  - We launch Chrome ourselves (audio flags intact) with a CDP port.
 *  - Stagehand (google/gemini-2.5-flash) attaches over CDP as the BRAIN:
 *    it looks at the page and decides how to get into a fresh voice room —
 *    no hand-written gate selectors. If the UI changes tomorrow, this
 *    still works.
 *  - The reactive mic is the MOUTH: multi-turn utterances synthesized at
 *    runtime.
 *  - Tab capture + Deepgram are the EARS: we assert what was audibly said.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENT_URL = process.env.OSBORN_AGENT_URL || 'https://osborn-1b9d70e5-v2.fly.dev'
const APP_URL = process.env.OSBORN_APP_URL || 'https://www.voice-native.com'
const CHAT_URL = `${APP_URL}/chat?provider=gemini&voiceArch=pipeline&agent=claude&agentUrl=${encodeURIComponent(AGENT_URL)}`
const CDP_PORT = 9224

// Room hygiene: always leave the LiveKit room on exit so the machine idles
// from a clean state (prevents the empty-room wedge/alone-timer races).
test.afterEach(async () => { await fetch(`${AGENT_URL}/leave-room`, { method: 'POST' }).catch(() => {}) })



async function transcribe(webmPath: string): Promise<string> {
  const audio = readFileSync(webmPath)
  const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true', {
    method: 'POST',
    headers: { Authorization: `Token ${envKey('DEEPGRAM_API_KEY')}`, 'Content-Type': 'audio/webm' },
    body: audio,
  })
  if (!res.ok) throw new Error(`deepgram ${res.status}: ${await res.text()}`)
  const j: any = await res.json()
  return j?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
}

test('STAGEHAND CONVERSATION: agent brain navigates, reactive mic converses', async () => {
  test.setTimeout(420_000)
  const t0 = Date.now()

  // Our browser, our flags — the brain attaches to it, not the other way round.
  // NO fake-device/fake-file flags: the reactive mic replaces the fake mic, and
  // --use-file-for-fake-audio-capture hijacks getDisplayMedia audio too (the
  // "ears" end up recording the fixture instead of real tab output).
  const browser = await chromium.launch({
    // Container/CI: bundled Chromium headless. Local: installed Chrome, headed.
    ...(process.env.OSBORN_TEST_CONTAINER ? { headless: true } : { channel: 'chrome' as const, headless: false }), // headless can't start the tab-capture video source without fake devices
    args: [
      '--use-fake-ui-for-media-stream',
      // fake DEVICE only — no --use-file-for-fake-audio-capture. The file flag
      // is what hijacked getDisplayMedia audio; the bare fake device provides
      // the capture pipeline (and camera) without replacing tab audio.
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--auto-accept-this-tab-capture',
      `--remote-debugging-port=${CDP_PORT}`,
    ],
  })
  // Manual launch bypasses the config's fixture-level `video: 'on'` — record
  // explicitly on this context so the report gets a replay.
  const context = await browser.newContext({
    permissions: ['microphone'],
    recordVideo: { dir: test.info().outputDir, size: { width: 1280, height: 720 } },
  })
  const page = await context.newPage()
  const tVideoStart = Date.now()
  await installReactiveMic(page)
  await installActionVisualizer(page)

  // Make sure the agent is in its room before the browser joins (join-race fix).
  await fetch(`${AGENT_URL}/connect-room`, { method: 'POST' }).catch(() => {})
  await expect(async () => {
    const h: any = await fetch(`${AGENT_URL}/health`).then((r) => r.json())
    expect(h?.livekit?.status).toBe('connected')
  }).toPass({ timeout: 60_000, intervals: [1_000] })

  // ---- THE BRAIN: attach Stagehand over CDP, let it get us into a room ----
  // Stagehand uses cdpUrl verbatim (no /json/version resolution on attach),
  // so resolve the browser's websocket endpoint ourselves.
  const version: any = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json())
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = envKey('GOOGLE_API_KEY')
  const stagehand = new Stagehand({
    env: 'LOCAL',
    localBrowserLaunchOptions: { cdpUrl: version.webSocketDebuggerUrl },
    model: 'google/gemini-2.5-flash',
    modelClientOptions: { apiKey: envKey('GOOGLE_API_KEY') },
    verbose: 1,
  })
  await stagehand.init()
  console.log(`[sh-conv] Stagehand attached +${Date.now() - t0}ms`)

  // Reusable step: gates handled by the brain, mic unmuted, ears recording
  // from page load (so the greeting TTS is IN the capture).
  const { captureStartedAt } = await enterFreshRoom(page, (i) => actWithCache(stagehand, page, i), CHAT_URL, { earsOn: true, agentUrl: AGENT_URL })
  const tCaptureStart = captureStartedAt ?? Date.now()
  console.log(`[sh-conv] in fresh room, ears on since page load +${Date.now() - t0}ms`)

  // ---- TURN 1: riddle (answer never appears in our audio) ----
  await speakText(page, 'Osborn, quick voice test. Which fruit is yellow and curved? Answer with just the name of the fruit.')
  const banana = page.getByText(/banana/i)
  await expect(banana.first()).toBeVisible({ timeout: 90_000 })
  const countAfterTurn1 = await banana.count()
  console.log(`[sh-conv] turn 1 reply visible (banana x${countAfterTurn1}) +${Date.now() - t0}ms`)
  await page.waitForTimeout(8_000)

  // ---- TURN 2: reactive recall ----
  await drainSpeechEvents(page) // clear turn-1 energy events
  await speakText(page, 'Correct. Now tell me, what was the word you just said? Repeat only that word.')
  console.log(`[sh-conv] turn 2 spoken +${Date.now() - t0}ms`)
  // Don't trust DOM text counts for the second reply — an identical "Banana."
  // can render merged/replaced in the chat UI. The audio capture is the source
  // of truth; wait for the reply TTS to actually PLAY (energy event) so slow
  // environments (containers) don't cut the recording before it lands.
  try {
    await waitForSpeechEvent(page, 'speech-start', 90_000)
    console.log(`[sh-conv] turn 2 reply TTS playing +${Date.now() - t0}ms`)
  } catch { /* fall through — capture whatever we have */ }
  await page.waitForTimeout(8_000)

  // ---- EARS: assert what was audibly SPOKEN ----
  const out = test.info().outputPath('stagehand-conversation-capture.webm')
  const cap = await saveCapture(page, out)
  console.log(`[sh-conv] captured ${cap.bytes} bytes over ${cap.durationMs}ms`)
  const heard = await transcribe(out)
  console.log(`[sh-conv] Deepgram heard: "${heard.slice(0, 300)}"`)
  const spokenBananas = (heard.toLowerCase().match(/banana/g) || []).length
  console.log(`[sh-conv] agent audibly said "banana" ${spokenBananas} time(s)`)
  expect(spokenBananas, 'agent should have SPOKEN banana at least twice').toBeGreaterThanOrEqual(2)

  // ---- REPLAYS: attach video, audio, and a merged video+audio replay ----
  await test.info().attach('agent-audio', { path: out, contentType: 'audio/webm' })
  const video = page.video()
  await stagehand.close().catch(() => {})
  await context.close() // finalizes the video file — browser must still be alive for saveAs
  if (video) {
    const vidPath = test.info().outputPath('screen-video.webm')
    await video.saveAs(vidPath)
    await test.info().attach('screen-video', { path: vidPath, contentType: 'video/webm' })
    // Mux the agent audio onto the screen video, offset to when capture began.
    try {
      const offsetSec = ((tCaptureStart - tVideoStart) / 1000).toFixed(2)
      const replay = test.info().outputPath('replay-with-audio.webm')
      execSync(
        `ffmpeg -y -loglevel error -i "${vidPath}" -itsoffset ${offsetSec} -i "${out}" -map 0:v -map 1:a -c copy "${replay}"`,
      )
      await test.info().attach('replay-with-audio', { path: replay, contentType: 'video/webm' })
      console.log(`[sh-conv] replay with audio: ${replay}`)
    } catch (e) {
      console.log(`[sh-conv] ffmpeg mux skipped: ${e instanceof Error ? e.message.slice(0, 100) : e}`)
    }
  }
  await browser.close()
})
