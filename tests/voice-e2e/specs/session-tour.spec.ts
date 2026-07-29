import { test, expect, chromium } from '@playwright/test'
import { Stagehand } from '@browserbasehq/stagehand'
import { installReactiveMic } from '../lib/reactive-mic'
import { installActionVisualizer } from '../lib/action-visualizer'
import { startElementCapture } from '../lib/audio-capture'
import { enterFreshRoom, ensureSessionLive } from '../lib/steps'
import { attachDevtools } from '../lib/devtools'
import { flight } from '../lib/flightlog'
import { envKey } from '../lib/env'
import { actWithCache } from '../lib/step-cache'
import { startLiveStream } from '../lib/live-stream'
import { writeFileSync } from 'fs'

/**
 * ONE continuous session, never leaving the room between activities (leaving
 * re-poisons the reused Room — the 0.9.83 bug). Uses the single healthy
 * connection a fresh restart gives us to do BOTH the skills-explorer tour and
 * the meeting join. Emits section timestamps to sections.json so each part of
 * the single video can be clipped afterward. Meeting needs OSBORN_MEETING_URL.
 */

const AGENT_URL = process.env.OSBORN_AGENT_URL || 'https://osborn-d4f24f46-v2.fly.dev'
const APP_URL = process.env.OSBORN_APP_URL || 'https://www.voice-native.com'
const CHAT_URL = `${APP_URL}/chat?provider=gemini&voiceArch=pipeline&agent=claude&agentUrl=${encodeURIComponent(AGENT_URL)}`
const MEETING_URL = process.env.OSBORN_MEETING_URL || ''
const CDP_PORT = 9250

// Always leave the room properly — NEVER just close the tab. Abruptly closing
// leaves a ghost participant until the alone-timer, compounding room poisoning
// (user-diagnosed 2026-07-29: "spamming rooms and closing the tab").
test.afterEach(async () => { await fetch(`${AGENT_URL}/leave-room`, { method: 'POST' }).catch(() => {}) })

test('SESSION TOUR: skills explorer then meeting join, one continuous room session', async () => {
  test.setTimeout(420_000)
  const t0 = Date.now()
  const marks: Record<string, number> = {}
  const mark = (name: string) => { marks[name] = Date.now() - tVideoStart; console.log(`[tour] MARK ${name} @ ${marks[name]}ms`); flight({ type: 'tour-mark', mark: name }) }

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
  const tVideoStart = Date.now()
  const dt = attachDevtools(page)
  page.on('dialog', (d) => d.accept(MEETING_URL).catch(() => {}))
  await installReactiveMic(page)
  await installActionVisualizer(page)
  const live = await startLiveStream(page).catch(() => null)
  if (live) console.log(`[tour] LIVE: ${live.url}`)

  const version: any = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json())
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = envKey('GOOGLE_API_KEY')
  const stagehand = new Stagehand({
    env: 'LOCAL', localBrowserLaunchOptions: { cdpUrl: version.webSocketDebuggerUrl },
    model: 'google/gemini-2.5-flash', modelClientOptions: { apiKey: envKey('GOOGLE_API_KEY') }, verbose: 0,
  })
  await stagehand.init()
  const brain = (i: string) => actWithCache(stagehand, page, i)

  await enterFreshRoom(page, brain, CHAT_URL, { earsOn: true, agentUrl: AGENT_URL })
  await ensureSessionLive(page, brain, CHAT_URL, { agentUrl: AGENT_URL, diagnostics: () => dt.summary() })
  mark('in-room')
  console.log(`[tour] in room +${Date.now() - t0}ms`)

  // ===== SECTION 1: SKILLS EXPLORER =====
  mark('skills-explorer-start')
  await brain('Click the button labeled Research at the top of the voice interface — despite its label it opens the settings dropdown')
  await page.waitForTimeout(2_500)
  await brain('Click the Tools tab inside the dropdown that opened')
  await page.waitForTimeout(2_500)
  await brain('Click the View button next to the first skill in the Skills list')
  await page.waitForTimeout(5_000) // let the skill viewer modal render
  await page.screenshot({ path: test.info().outputPath('skills-viewer.png') }).catch(() => {})
  await brain('If a skill content viewer or modal is open, close it')
  await page.waitForTimeout(2_000)
  mark('skills-explorer-end')

  // ===== SECTION 2: MEETING JOIN (never left the room) =====
  if (MEETING_URL) {
    mark('meeting-start')
    // New labeled UI: click the join button (data-testid), type URL, submit.
    await page.click('[data-testid="join-meeting"]').catch(async () => {
      await brain('Click the "Join a meeting" button (video camera icon in the top-right controls)')
    })
    await page.waitForTimeout(1_500)
    await page.fill('[data-testid="join-meeting"] ~ div input, input[placeholder*="Meet"]', MEETING_URL).catch(() => {})
    await page.click('[data-testid="join-meeting-submit"]').catch(async () => {
      await brain('Type the meeting URL into the input and click "Send bot to meeting"')
    })
    await page.waitForTimeout(4_000)
    flight({ type: 'meeting-join-clicked', url: MEETING_URL })
    console.log(`[tour] meeting join clicked for ${MEETING_URL}`)
    // Hold ~75s: bot join + a transcript poll cycle; user speaks in the Meet.
    await page.waitForTimeout(75_000)
    mark('meeting-end')
  }

  writeFileSync(test.info().outputPath('sections.json'), JSON.stringify(marks, null, 2))
  await test.info().attach('sections', { path: test.info().outputPath('sections.json'), contentType: 'application/json' })

  // GRACEFUL END: leave the room like a user would, settle, THEN close.
  await brain('Click the Disconnect or Leave button to end the voice session').catch(() => {})
  await page.waitForTimeout(2_000)
  await fetch(`${AGENT_URL}/leave-room`, { method: 'POST' }).catch(() => {})
  await page.waitForTimeout(2_000)
  const video = page.video()
  await stagehand.close().catch(() => {})
  await context.close().catch(() => {})
  if (video) {
    const vp = test.info().outputPath('tour-video.webm')
    await video.saveAs(vp).catch(() => {})
    await test.info().attach('tour-video', { path: vp, contentType: 'video/webm' }).catch(() => {})
  }
  await live?.stop().catch(() => {})
  await browser.close()
  expect(marks['in-room']).toBeGreaterThan(0)
})
