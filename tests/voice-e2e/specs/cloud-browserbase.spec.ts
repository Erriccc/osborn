import { test, expect, chromium } from '@playwright/test'
import { Stagehand } from '@browserbasehq/stagehand'
import { installReactiveMic, speakText } from '../lib/reactive-mic'
import { saveCapture } from '../lib/audio-capture'
import { enterFreshRoom, drainSpeechEvents, waitForSpeechEvent, logResult } from '../lib/steps'
import { envKey } from '../lib/env'
import { actWithCache } from '../lib/step-cache'
import { readFileSync } from 'fs'

/**
 * CLOUD BROWSER (Browserbase): same voice conversation through a
 * Browserbase-hosted Chrome. Sessions default to 300s (vs Browserless free's
 * 60s cap) and every session gets a replay in their dashboard:
 * https://browserbase.com/sessions/<id>
 */

const AGENT_URL = process.env.OSBORN_AGENT_URL || 'https://osborn-d4f24f46-v2.fly.dev'
const APP_URL = process.env.OSBORN_APP_URL || 'https://www.voice-native.com'
const CHAT_URL = `${APP_URL}/chat?provider=gemini&voiceArch=pipeline&agent=claude&agentUrl=${encodeURIComponent(AGENT_URL)}`

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

test('CLOUD BROWSER: Browserbase-hosted Chrome runs the voice conversation', async () => {
  test.setTimeout(420_000)
  const t0 = Date.now()
  const apiKey = envKey('BROWSERBASE_API_KEY')

  // Create a session (projectId resolved from the account's project list).
  const projects: any[] = await fetch('https://api.browserbase.com/v1/projects', {
    headers: { 'X-BB-API-Key': apiKey },
  }).then((r) => r.json())
  const projectId = process.env.BROWSERBASE_PROJECT_ID || projects[0]?.id
  const session: any = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'X-BB-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  }).then((r) => r.json())
  if (!session.connectUrl) throw new Error(`session create failed: ${JSON.stringify(session).slice(0, 200)}`)
  console.log(`[cloud-bb] session ${session.id} — replay: https://browserbase.com/sessions/${session.id}`)

  const browser = await chromium.connectOverCDP(session.connectUrl)
  const tConnected = Date.now()
  console.log(`[cloud-bb] connected +${tConnected - t0}ms`)

  const context = browser.contexts()[0] ?? (await browser.newContext())
  const page = context.pages()[0] ?? (await context.newPage())
  await installReactiveMic(page)

  process.env.GOOGLE_GENERATIVE_AI_API_KEY = envKey('GOOGLE_API_KEY')
  const stagehand = new Stagehand({
    env: 'LOCAL',
    localBrowserLaunchOptions: { cdpUrl: session.connectUrl },
    model: 'google/gemini-2.5-flash',
    modelClientOptions: { apiKey: envKey('GOOGLE_API_KEY') },
    verbose: 0,
  })
  let brain: (i: string) => Promise<unknown>
  try {
    await stagehand.init()
    brain = (i) => actWithCache(stagehand, page, i)
    console.log(`[cloud-bb] Stagehand brain attached +${Date.now() - t0}ms`)
  } catch (e) {
    console.log(`[cloud-bb] Stagehand attach failed (${e instanceof Error ? e.message.slice(0, 80) : e}) — deterministic fallback`)
    brain = async () => page.getByRole('button', { name: /fresh|new/i }).first().click()
  }

  await fetch(`${AGENT_URL}/connect-room`, { method: 'POST' }).catch(() => {})
  await expect(async () => {
    const h: any = await fetch(`${AGENT_URL}/health`).then((r) => r.json())
    expect(h?.livekit?.status).toBe('connected')
  }).toPass({ timeout: 60_000, intervals: [1_000] })

  await enterFreshRoom(page, brain, CHAT_URL, { earsOn: true, agentUrl: AGENT_URL })
  console.log(`[cloud-bb] in fresh room +${Date.now() - t0}ms`)

  await drainSpeechEvents(page)
  const tAsk = Date.now()
  await speakText(page, 'Osborn, quick voice test. Which fruit is yellow and curved? Answer with just the name of the fruit.')
  const replyStart = await waitForSpeechEvent(page, 'speech-start', 90_000)
  console.log(`[cloud-bb] reply TTS started ${replyStart - tAsk}ms after question began`)
  await page.waitForTimeout(8_000)

  const out = test.info().outputPath('cloud-browserbase-capture.webm')
  const cap = await saveCapture(page, out)
  const heard = await transcribe(out)
  console.log(`[cloud-bb] captured ${cap.bytes} bytes; Deepgram heard: "${heard.slice(0, 200)}"`)

  logResult('cloud-browserbase', {
    sessionId: session.id,
    replayUrl: `https://browserbase.com/sessions/${session.id}`,
    connectMs: tConnected - t0,
    replyLatencyMs: replyStart - tAsk,
    captureBytes: cap.bytes,
    heard: heard.slice(0, 300),
  })

  await test.info().attach('agent-audio', { path: out, contentType: 'audio/webm' })
  await stagehand.close().catch(() => {})
  await browser.close()

  expect(heard.toLowerCase(), 'agent should have SPOKEN banana through the Browserbase browser').toContain('banana')
})
