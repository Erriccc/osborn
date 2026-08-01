import { test, expect, chromium } from '@playwright/test'
import { Stagehand } from '@browserbasehq/stagehand'
import { installReactiveMic, speakText } from '../../lib/reactive-mic'
import { installActionVisualizer } from '../../lib/action-visualizer'
import { startElementCapture, saveCapture } from '../../lib/audio-capture'
import { ensureAgentInRoom, enterFreshRoom, drainSpeechEvents, waitForSpeechEvent, logResult } from '../../lib/steps'
import { envKey } from '../../lib/env'
import { actWithCache } from '../../lib/step-cache'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

/**
 * INTERRUPTION (barge-in): the test your cutoff bugs have been waiting for.
 *
 *  1. Ask for a LONG story → wait for TTS speech-start (energy event)
 *  2. Let it speak ~4s, then INTERRUPT mid-sentence with a new question
 *  3. Measure: how long until the TTS audio actually stops (speech-stop)
 *  4. Assert the agent pivots: answers the new question ("four")
 *
 * Agent-side interruption config (v0.9.72): minDuration 1500ms, minWords 2,
 * falseInterruptionTimeout 3500ms — so a legit stop should land roughly
 * 1.5-4s after we start speaking. We assert < 8s (generous) and LOG the
 * precise latency to results/runs.jsonl for trend tracking.
 */

const AGENT_URL = process.env.OSBORN_AGENT_URL || 'https://osborn-1b9d70e5-v2.fly.dev'
const APP_URL = process.env.OSBORN_APP_URL || 'https://www.voice-native.com'
const CHAT_URL = `${APP_URL}/chat?provider=gemini&voiceArch=pipeline&agent=claude&agentUrl=${encodeURIComponent(AGENT_URL)}`
const CDP_PORT = 9226

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

test('BARGE-IN: interrupt mid-story, TTS stops fast, agent pivots to new question', async () => {
  test.setTimeout(420_000)
  const t0 = Date.now()

  const browser = await chromium.launch({
    // Container/CI: bundled Chromium headless. Local: installed Chrome, headed.
    ...(process.env.OSBORN_TEST_CONTAINER ? { headless: true } : { channel: 'chrome' as const, headless: false }),
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      `--remote-debugging-port=${CDP_PORT}`,
    ],
  })
  const context = await browser.newContext({
    permissions: ['microphone'],
    recordVideo: { dir: test.info().outputDir, size: { width: 1280, height: 720 } },
  })
  const page = await context.newPage()
  const tVideoStart = Date.now()
  await installReactiveMic(page)
  await installActionVisualizer(page)

  await ensureAgentInRoom(AGENT_URL)

  const version: any = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json())
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = envKey('GOOGLE_API_KEY')
  const stagehand = new Stagehand({
    env: 'LOCAL',
    localBrowserLaunchOptions: { cdpUrl: version.webSocketDebuggerUrl },
    model: 'google/gemini-2.5-flash',
    modelClientOptions: { apiKey: envKey('GOOGLE_API_KEY') },
    verbose: 0,
  })
  await stagehand.init()

  const { captureStartedAt } = await enterFreshRoom(page, (i) => actWithCache(stagehand, page, i), CHAT_URL, { earsOn: true, agentUrl: AGENT_URL })
  const tCaptureStart = captureStartedAt ?? Date.now()
  console.log(`[barge-in] in room, ears on since page load +${Date.now() - t0}ms`)

  // ---- 1. Request a long story ----
  await drainSpeechEvents(page) // clear greeting energy
  await speakText(page, 'Osborn, tell me a very long story about the history of computers, with as much detail as possible. Keep talking for a long time.')
  const storyStart = await waitForSpeechEvent(page, 'speech-start', 90_000)
  console.log(`[barge-in] story TTS started +${Date.now() - t0}ms`)

  // ---- 2. Let it roll, then interrupt mid-sentence ----
  await page.waitForTimeout(4_000)
  const tInterrupt = Date.now()
  await speakText(page, 'Stop, stop. Quick question instead: what is two plus two? Answer with just the number.')
  console.log(`[barge-in] interruption spoken (started at +${tInterrupt - t0}ms)`)

  // ---- 3. When does the story audio actually stop? ----
  const stopT = await waitForSpeechEvent(page, 'speech-stop', 30_000)
  const stopLatencyMs = stopT - tInterrupt
  console.log(`[barge-in] TTS stopped ${stopLatencyMs}ms after interruption began`)

  // ---- 4. Agent should answer the NEW question ----
  const answerStart = await waitForSpeechEvent(page, 'speech-start', 60_000)
  console.log(`[barge-in] pivot reply TTS started ${answerStart - tInterrupt}ms after interruption`)
  await page.waitForTimeout(8_000) // let the answer finish

  const out = test.info().outputPath('barge-in-capture.webm')
  const cap = await saveCapture(page, out)
  const heard = await transcribe(out)
  console.log(`[barge-in] Deepgram heard: "${heard.slice(0, 400)}"`)

  logResult('barge-in', {
    stopLatencyMs,
    pivotLatencyMs: answerStart - tInterrupt,
    storyLeadInMs: storyStart - t0,
    captureBytes: cap.bytes,
    heard: heard.slice(0, 500),
  })

  await test.info().attach('agent-audio', { path: out, contentType: 'audio/webm' })
  const video = page.video()
  await stagehand.close().catch(() => {})
  await context.close()
  if (video) {
    const vidPath = test.info().outputPath('screen-video.webm')
    await video.saveAs(vidPath)
    try {
      const offsetSec = ((tCaptureStart - tVideoStart) / 1000).toFixed(2)
      const replay = test.info().outputPath('replay-with-audio.webm')
      execSync(`ffmpeg -y -loglevel error -i "${vidPath}" -itsoffset ${offsetSec} -i "${out}" -map 0:v -map 1:a -c copy "${replay}"`)
      await test.info().attach('replay-with-audio', { path: replay, contentType: 'video/webm' })
    } catch { /* mux is best-effort */ }
  }
  await browser.close()

  // Assertions last so ALL metrics + replays exist even on failure.
  expect(stopLatencyMs, 'story TTS should stop within 8s of barge-in').toBeLessThan(8_000)
  expect(heard.toLowerCase(), 'agent should answer the pivot question').toMatch(/four|\b4\b/)
})
