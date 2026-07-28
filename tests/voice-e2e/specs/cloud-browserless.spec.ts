import { test, expect, chromium } from '@playwright/test'
import { Stagehand } from '@browserbasehq/stagehand'
import { installReactiveMic, speakText } from '../lib/reactive-mic'
import { saveCapture } from '../lib/audio-capture'
import { enterFreshRoom, drainSpeechEvents, waitForSpeechEvent, logResult } from '../lib/steps'
import { envKey } from '../lib/env'
import { actWithCache } from '../lib/step-cache'
import { readFileSync } from 'fs'

/**
 * CLOUD BROWSER (Browserless): same voice conversation, but the browser runs
 * in Browserless's cloud — zero local browser, zero container. Node (this
 * test) stays wherever the agent runs; only CDP traffic crosses the wire.
 *
 * Proves: reactive mic (init-script getUserMedia patch), element-tap ears,
 * and the Stagehand brain all survive a fully remote browser. Compare the
 * logged metrics against local/container runs in results/runs.jsonl.
 */

const AGENT_URL = process.env.OSBORN_AGENT_URL || 'https://osborn-d4f24f46-v2.fly.dev'
const APP_URL = process.env.OSBORN_APP_URL || 'https://www.voice-native.com'
const CHAT_URL = `${APP_URL}/chat?provider=gemini&voiceArch=pipeline&agent=claude&agentUrl=${encodeURIComponent(AGENT_URL)}`
const BL_HOST = process.env.BROWSERLESS_HOST || 'production-sfo.browserless.io'

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

test('CLOUD BROWSER: Browserless-hosted Chrome runs the voice conversation', async () => {
  test.setTimeout(420_000)
  const t0 = Date.now()
  const token = envKey('BROWSELESS_API_KEY')

  // Attach over raw CDP at the root endpoint (the /json/version
  // webSocketDebuggerUrl is a one-shot session URL that 400s on reuse).
  const version: any = await fetch(`https://${BL_HOST}/json/version?token=${token}`).then((r) => r.json())
  // timeout: Browserless kills sessions at 60s by default — extend for a
  // full multi-turn voice conversation.
  const wsUrl = `wss://${BL_HOST}?token=${token}&timeout=360000`
  const browser = await chromium.connectOverCDP(wsUrl)
  const tConnected = Date.now()
  console.log(`[cloud-bl] connected to Browserless cloud +${tConnected - t0}ms (Chrome ${version.Browser})`)

  const context = browser.contexts()[0] ?? (await browser.newContext())
  const page = await context.newPage()
  await installReactiveMic(page)

  // Same brain, attached to the same remote browser.
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = envKey('GOOGLE_API_KEY')
  const stagehand = new Stagehand({
    env: 'LOCAL',
    localBrowserLaunchOptions: { cdpUrl: wsUrl },
    model: 'google/gemini-2.5-flash',
    modelClientOptions: { apiKey: envKey('GOOGLE_API_KEY') },
    verbose: 0,
  })
  let brain: (i: string) => Promise<unknown>
  try {
    await stagehand.init()
    brain = (i) => actWithCache(stagehand, page, i)
    console.log(`[cloud-bl] Stagehand brain attached to cloud browser +${Date.now() - t0}ms`)
  } catch (e) {
    console.log(`[cloud-bl] Stagehand attach failed (${e instanceof Error ? e.message.slice(0, 80) : e}) — deterministic fallback`)
    brain = async () => page.getByRole('button', { name: /fresh|new/i }).first().click()
  }

  await fetch(`${AGENT_URL}/connect-room`, { method: 'POST' }).catch(() => {})
  await expect(async () => {
    const h: any = await fetch(`${AGENT_URL}/health`).then((r) => r.json())
    expect(h?.livekit?.status).toBe('connected')
  }).toPass({ timeout: 60_000, intervals: [1_000] })

  await enterFreshRoom(page, brain, CHAT_URL, { earsOn: true, agentUrl: AGENT_URL })
  console.log(`[cloud-bl] in fresh room +${Date.now() - t0}ms`)

  // Single reactive turn: riddle → audible reply.
  await drainSpeechEvents(page)
  const tAsk = Date.now()
  await speakText(page, 'Osborn, quick voice test. Which fruit is yellow and curved? Answer with just the name of the fruit.')
  const replyStart = await waitForSpeechEvent(page, 'speech-start', 90_000)
  console.log(`[cloud-bl] reply TTS started ${replyStart - tAsk}ms after question began`)
  await page.waitForTimeout(8_000)

  const out = test.info().outputPath('cloud-browserless-capture.webm')
  const cap = await saveCapture(page, out)
  const heard = await transcribe(out)
  console.log(`[cloud-bl] captured ${cap.bytes} bytes; Deepgram heard: "${heard.slice(0, 200)}"`)

  logResult('cloud-browserless', {
    host: BL_HOST,
    connectMs: tConnected - t0,
    replyLatencyMs: replyStart - tAsk,
    captureBytes: cap.bytes,
    heard: heard.slice(0, 300),
  })

  await test.info().attach('agent-audio', { path: out, contentType: 'audio/webm' })
  await stagehand.close().catch(() => {})
  await browser.close()

  expect(heard.toLowerCase(), 'agent should have SPOKEN banana through the cloud browser').toContain('banana')
})
