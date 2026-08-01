import { test, expect, chromium } from '@playwright/test'
import { Stagehand } from '@browserbasehq/stagehand'
import { installReactiveMic, speakText } from '../../lib/reactive-mic'
import { installActionVisualizer } from '../../lib/action-visualizer'
import { startElementCapture, saveCapture } from '../../lib/audio-capture'
import { enterFreshRoom, ensureSessionLive, waitForSpeechEvent, drainSpeechEvents } from '../../lib/steps'
import { attachDevtools } from '../../lib/devtools'
import { envKey } from '../../lib/env'
import { actWithCache } from '../../lib/step-cache'

/**
 * REJOIN EXPERIMENT — answers "is temporary-rooms necessary?" empirically.
 *
 * Session A: connect on a FRESH machine, speak, verify the agent replies,
 *   then LEAVE THE ROOM CLEANLY via the UI (the way a real user does).
 * Session B: reconnect (same running process → same reused Room object) and
 *   speak again. If the agent replies → clean leave+rejoin is SAFE, the SDK
 *   bug isn't triggered by clean leaves, and temporary-rooms is insurance.
 *   If the agent is DEAF (no reply / stuck connecting) → the reused Room went
 *   deaf on a CLEAN cycle, and temporary-rooms is NECESSARY.
 *
 * Run against a freshly-restarted machine for a clean baseline.
 */

const AGENT_URL = process.env.OSBORN_AGENT_URL || 'https://osborn-1b9d70e5-v2.fly.dev'
const APP_URL = process.env.OSBORN_APP_URL || 'https://www.voice-native.com'
const CHAT_URL = `${APP_URL}/chat?provider=gemini&voiceArch=pipeline&agent=claude&agentUrl=${encodeURIComponent(AGENT_URL)}`

async function oneSession(label: string, videoDir?: string): Promise<{ replied: boolean; heard: string }> {
  const cdpPort = 9260 + Math.floor(Math.random() * 30)
  const browser = await chromium.launch({
    channel: 'chrome', headless: false,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${cdpPort}`],
  })
  const context = await browser.newContext({ permissions: ['microphone'], ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } } : {}) })
  const page = await context.newPage()
  const dt = attachDevtools(page)
  await installReactiveMic(page)
  await installActionVisualizer(page)
  const version: any = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then((r) => r.json())
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = envKey('GOOGLE_API_KEY')
  const stagehand = new Stagehand({
    env: 'LOCAL', localBrowserLaunchOptions: { cdpUrl: version.webSocketDebuggerUrl },
    model: 'google/gemini-2.5-flash', modelClientOptions: { apiKey: envKey('GOOGLE_API_KEY') }, verbose: 0,
  })
  await stagehand.init()
  const brain = (i: string) => actWithCache(stagehand, page, i)

  let replied = false
  try {
    await enterFreshRoom(page, brain, CHAT_URL, { earsOn: true, agentUrl: AGENT_URL })
    await ensureSessionLive(page, brain, CHAT_URL, { agentUrl: AGENT_URL, diagnostics: () => dt.summary() })
    console.log(`[rejoin:${label}] in room`)
    await drainSpeechEvents(page)
    await speakText(page, 'Osborn, quick check — can you hear me? Say yes.')
    await waitForSpeechEvent(page, 'speech-start', 45_000)
    replied = true
    await waitForSpeechEvent(page, 'speech-stop', 60_000).catch(() => {})
  } catch (e) {
    console.log(`[rejoin:${label}] FAILED to get a reply: ${(e as Error).message?.slice(0, 100)}`)
  }
  // CLEAN LEAVE via the UI, like a real user.
  await brain('Click the Disconnect or Leave button to end the voice session').catch(() => {})
  await page.waitForTimeout(2_000)
  await fetch(`${AGENT_URL}/leave-room`, { method: 'POST' }).catch(() => {})
  const video = page.video()
  await stagehand.close().catch(() => {})
  await context.close().catch(() => {})
  if (video && videoDir) { try { await video.saveAs(`${videoDir}/${label}.webm`) } catch {} }
  await browser.close()
  console.log(`[rejoin:${label}] session done — agent replied: ${replied}`)
  return { replied, heard: '' }
}

test('REJOIN EXPERIMENT: does a clean leave + rejoin deafen the reused Room?', async () => {
  test.setTimeout(360_000)
  const vdir = test.info().outputDir
  const a = await oneSession('A-first', vdir)
  expect(a.replied, 'Session A (fresh machine) should get a reply').toBe(true)
  console.log('[rejoin] --- Session A left cleanly; waiting 8s before rejoin ---')
  await new Promise((r) => setTimeout(r, 8_000))
  const b = await oneSession('B-rejoin', vdir)
  // The verdict: if B fails, the reused Room went deaf on a CLEAN cycle.
  console.log(`[rejoin] VERDICT — A replied: ${a.replied}, B replied: ${b.replied}`)
  console.log(b.replied
    ? '[rejoin] ✅ Clean leave+rejoin is SAFE → temporary-rooms is insurance, not essential.'
    : '[rejoin] ❌ Clean rejoin went DEAF → temporary-rooms is NECESSARY.')
  expect(b.replied, 'Session B (clean rejoin) reply = the answer to whether temporary-rooms is needed').toBe(true)
})
