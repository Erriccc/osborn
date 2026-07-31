import { test, expect, chromium } from '@playwright/test'
import { Stagehand } from '@browserbasehq/stagehand'
import { installReactiveMic, speakText } from '../lib/reactive-mic'
import { installActionVisualizer } from '../lib/action-visualizer'
import { startElementCapture, saveCapture } from '../lib/audio-capture'
import { enterFreshRoom, drainSpeechEvents, waitForSpeechEvent, logResult } from '../lib/steps'
import { nextUtterance, screenTail, type Turn } from '../lib/converse'
import { envKey } from '../lib/env'
import { actWithCache } from '../lib/step-cache'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

/**
 * NATURAL CONVERSATION: nothing scripted. An LLM tester improvises each
 * utterance from the goal + what the agent said; TTS synthesizes it on the
 * fly; the ears verify the agent audibly replied each turn. Every run is a
 * different conversation — the fuzzing mode for conversational UX bugs.
 *
 * Goal is injectable: OSBORN_CONVO_GOAL="probe how the agent handles ..."
 */

const AGENT_URL = process.env.OSBORN_AGENT_URL || 'https://osborn-1b9d70e5-v2.fly.dev'
const APP_URL = process.env.OSBORN_APP_URL || 'https://www.voice-native.com'
const CHAT_URL = `${APP_URL}/chat?provider=gemini&voiceArch=pipeline&agent=claude&agentUrl=${encodeURIComponent(AGENT_URL)}`
const CDP_PORT = 9228
const GOAL = process.env.OSBORN_CONVO_GOAL ||
  'Have a natural short conversation: greet the assistant, ask what it can help with, pick ONE capability it mentions and ask a concrete follow-up about it, then thank it and end. Max 3 things said by you.'
const MAX_TURNS = Number(process.env.OSBORN_CONVO_MAX_TURNS || 4)

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

test('NATURAL CONVERSATION: LLM tester improvises a multi-turn voice chat', async () => {
  test.setTimeout(600_000)
  const t0 = Date.now()

  const browser = await chromium.launch({
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

  await fetch(`${AGENT_URL}/connect-room`, { method: 'POST' }).catch(() => {})
  await expect(async () => {
    const h: any = await fetch(`${AGENT_URL}/health`).then((r) => r.json())
    expect(h?.livekit?.status).toBe('connected')
  }).toPass({ timeout: 60_000, intervals: [1_000] })

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

  const { captureStartedAt } = await enterFreshRoom(page, (i) => actWithCache(stagehand, page, i), CHAT_URL, {
    earsOn: true,
    agentUrl: AGENT_URL,
  })
  const tCaptureStart = captureStartedAt ?? Date.now()
  console.log(`[nat-conv] in fresh room +${Date.now() - t0}ms — goal: "${GOAL.slice(0, 80)}..."`)

  const history: Turn[] = []
  let agentReplies = 0
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const tail = await screenTail(page)
    const { say, reason } = await nextUtterance(GOAL, history, tail)
    if (!say) {
      console.log(`[nat-conv] tester ended the conversation: ${reason}`)
      break
    }
    console.log(`[nat-conv] tester says: "${say}" (${reason})`)
    history.push({ speaker: 'tester', text: say })
    await drainSpeechEvents(page)
    await speakText(page, say)

    try {
      await waitForSpeechEvent(page, 'speech-start', 90_000)
      agentReplies++
      // wait for the agent to finish talking before composing our reaction
      await waitForSpeechEvent(page, 'speech-stop', 120_000).catch(() => {})
      await page.waitForTimeout(1_500)
    } catch {
      console.log(`[nat-conv] no audible reply to turn ${turn + 1} within 90s`)
    }
    const after = await screenTail(page)
    history.push({ speaker: 'agent', text: after.slice(-500) })
  }

  await page.waitForTimeout(4_000)
  const out = test.info().outputPath('natural-conversation-capture.webm')
  const cap = await saveCapture(page, out)
  const heard = await transcribe(out)
  console.log(`[nat-conv] captured ${cap.bytes} bytes; heard: "${heard.slice(0, 400)}"`)
  console.log(`[nat-conv] audible agent replies: ${agentReplies}/${history.filter((h) => h.speaker === 'tester').length} tester turns`)

  logResult('natural-conversation', {
    goal: GOAL,
    testerTurns: history.filter((h) => h.speaker === 'tester').map((h) => h.text),
    agentReplies,
    captureBytes: cap.bytes,
    heard: heard.slice(0, 600),
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
    } catch { /* best-effort */ }
  }
  await browser.close()

  expect(agentReplies, 'agent should audibly reply to at least 2 improvised turns').toBeGreaterThanOrEqual(2)
})
