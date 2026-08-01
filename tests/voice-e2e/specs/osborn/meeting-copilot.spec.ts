import { test, expect, chromium } from '@playwright/test'
import { Stagehand } from '@browserbasehq/stagehand'
import { installReactiveMic, speakText } from '../../lib/reactive-mic'
import { installActionVisualizer } from '../../lib/action-visualizer'
import { startElementCapture, saveCapture } from '../../lib/audio-capture'
import { enterFreshRoom, ensureSessionLive, waitForSpeechEvent, drainSpeechEvents } from '../../lib/steps'
import { attachDevtools } from '../../lib/devtools'
import { flight } from '../../lib/flightlog'
import { envKey } from '../../lib/env'
import { actWithCache } from '../../lib/step-cache'

/**
 * MEETING COPILOT loop: tester joins a voice-native room, sends the agent
 * into a live Google Meet, then acts as the private earpiece user — asks the
 * agent (via the voice room) what was said in the meeting. Backend log
 * correlation (bot joined + [MEETING] transcript turns) is done by the
 * supervising agent out of band. Needs a live meeting: OSBORN_MEETING_URL.
 */

const AGENT_URL = process.env.OSBORN_AGENT_URL || 'https://osborn-1b9d70e5-v2.fly.dev'
const APP_URL = process.env.OSBORN_APP_URL || 'https://www.voice-native.com'
const CHAT_URL = `${APP_URL}/chat?provider=gemini&voiceArch=pipeline&agent=claude&agentUrl=${encodeURIComponent(AGENT_URL)}`
const MEETING_URL = process.env.OSBORN_MEETING_URL || ''
const CDP_PORT = 9240

test.afterEach(async () => { await fetch(`${AGENT_URL}/leave-room`, { method: 'POST' }).catch(() => {}) })

test('MEETING COPILOT: agent joins a live meeting, tester summons it privately', async () => {
  test.skip(!MEETING_URL, 'OSBORN_MEETING_URL not set')
  test.setTimeout(360_000)
  const t0 = Date.now()

  const browser = await chromium.launch({
    channel: 'chrome', headless: false,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${CDP_PORT}`],
  })
  const context = await browser.newContext({
    permissions: ['microphone'],
    recordVideo: { dir: test.info().outputDir, size: { width: 1280, height: 720 } },
  })
  const page = await context.newPage()
  const dt = attachDevtools(page)
  // The join-meeting button opens a native prompt(); pre-answer it.
  page.on('dialog', (d) => d.accept(MEETING_URL).catch(() => {}))
  await installReactiveMic(page)
  await installActionVisualizer(page)

  const version: any = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json())
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = envKey('GOOGLE_API_KEY')
  const stagehand = new Stagehand({
    env: 'LOCAL', localBrowserLaunchOptions: { cdpUrl: version.webSocketDebuggerUrl },
    model: 'google/gemini-2.5-flash', modelClientOptions: { apiKey: envKey('GOOGLE_API_KEY') }, verbose: 0,
  })
  await stagehand.init()
  const brain = (i: string) => actWithCache(stagehand, page, i)

  const { captureStartedAt } = await enterFreshRoom(page, brain, CHAT_URL, { earsOn: true, agentUrl: AGENT_URL })
  const tCaptureStart = captureStartedAt ?? Date.now()
  await ensureSessionLive(page, brain, CHAT_URL, { agentUrl: AGENT_URL, diagnostics: () => dt.summary() })
  flight({ type: 'in-room', scenario: 'meeting-copilot', ms: Date.now() - t0 })
  console.log(`[meeting] in room +${Date.now() - t0}ms`)

  // Send the agent into the meeting.
  await brain('Click the "Join a meeting" button (a small icon in the controls, tooltip "Join a meeting").')
  await page.waitForTimeout(4_000)
  flight({ type: 'join-clicked', scenario: 'meeting-copilot', meeting: MEETING_URL })
  console.log(`[meeting] join sent for ${MEETING_URL}`)

  // Give the bot time to appear + a first transcript poll cycle (~30s).
  await page.waitForTimeout(45_000)

  // Summon the agent privately — ask what's happening in the meeting.
  await drainSpeechEvents(page)
  await speakText(page, 'Osborn, are you in the meeting? What have you heard so far?')
  try {
    await waitForSpeechEvent(page, 'speech-start', 60_000)
    await waitForSpeechEvent(page, 'speech-stop', 90_000).catch(() => {})
    flight({ type: 'agent-replied', scenario: 'meeting-copilot' })
  } catch { flight({ type: 'no-reply', scenario: 'meeting-copilot' }) }
  await page.waitForTimeout(4_000)

  // Graceful end before capture/close — leave via UI, don't just kill the tab.
  await brain('Click the Disconnect or Leave button to end the voice session').catch(() => {})
  await page.waitForTimeout(2_000)
  const out = test.info().outputPath('meeting-copilot-capture.webm')
  const cap = await saveCapture(page, out).catch(() => ({ bytes: 0 } as any))
  await test.info().attach('agent-audio', { path: out, contentType: 'audio/webm' }).catch(() => {})
  const video = page.video()
  await stagehand.close().catch(() => {})
  await context.close().catch(() => {})
  if (video) {
    const vp = test.info().outputPath('screen-video.webm')
    await video.saveAs(vp).catch(() => {})
    await test.info().attach('screen-video', { path: vp, contentType: 'video/webm' }).catch(() => {})
  }
  await browser.close()
  console.log(`[meeting] done — captured ${cap.bytes} bytes`)
  expect(cap.bytes).toBeGreaterThan(0)
})
