import { test, expect, chromium } from '@playwright/test'
import { Stagehand } from '@browserbasehq/stagehand'
import { installReactiveMic, speakText } from '../lib/reactive-mic'
import { saveCapture } from '../lib/audio-capture'
import { enterFreshRoom, ensureSessionLive, drainSpeechEvents, waitForSpeechEvent, logResult } from '../lib/steps'
import { startElementCapture } from '../lib/audio-capture'
import { nextUtterance, screenTail, type Turn } from '../lib/converse'
import { envKey } from '../lib/env'
import { actWithCache } from '../lib/step-cache'
import { attachDevtools } from '../lib/devtools'
import { flight } from '../lib/flightlog'
import { addSiteFinding } from '../lib/knowledge'
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { load as loadYaml } from 'js-yaml'

/**
 * SCENARIO RUNNER — workflows as files. Each scenarios/<name>.yaml describes
 * a goal in natural language plus optional deterministic steps; this one
 * runner executes any of them. This is the "native way to store workflows":
 * readable, agent-writable, shipped as skill accompanying files.
 *
 * Run one:   OSBORN_SCENARIO=file-attachment npx playwright test specs/scenario.spec.ts
 * Run all:   npx playwright test specs/scenario.spec.ts   (one test per yaml)
 *
 * Step types: { act } natural-language UI action (brain + cache) ·
 * { say } speak into the mic · { waitSpeech: start|stop } · { pause: ms } ·
 * { assertScreen: regex } · { upload: path } file into <input type=file>.
 */

// Playwright's own trace.zip truncates when we close the CDP-attached browser
// ourselves, and the reporter then fails the test reading it — AFTER all real
// assertions passed. Our replays (video + audio + flight log) supersede the
// trace for these specs, so disable it.
test.use({ trace: 'off' })

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENT_URL = process.env.OSBORN_AGENT_URL || 'https://osborn-d4f24f46-v2.fly.dev'
const APP_URL = process.env.OSBORN_APP_URL || 'https://www.voice-native.com'
const SCEN_DIR = join(__dirname, '..', 'scenarios')

// Room hygiene: always leave the LiveKit room on exit so the machine idles
// from a clean state (prevents the empty-room wedge/alone-timer races).
test.afterEach(async () => { await fetch(`${AGENT_URL}/leave-room`, { method: 'POST' }).catch(() => {}) })

type Scenario = {
  name: string
  description?: string
  url?: string
  entry?: 'fresh' | 'resume'
  viewport?: { width: number; height: number }
  requiresEnv?: string
  profile?: string // profiles/<name>/state.json — start logged in (saved via scripts/save-profile.ts)
  steps?: Array<Record<string, any>>
  conversation?: {
    goal: string
    maxTurns?: number
    minAudibleReplies?: number
    assertHeard?: string
    hearing?: 'audio' | 'screen' // audio (default): comprehend from live transcription; screen: from page text
    turnGapMs?: number // pause after agent stops talking before our turn (default 2500)
  }
}

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

const wanted = process.env.OSBORN_SCENARIO
const files = readdirSync(SCEN_DIR).filter((f) => f.endsWith('.yaml') && (!wanted || f === `${wanted}.yaml`))

for (const file of files) {
  const scenario = loadYaml(readFileSync(join(SCEN_DIR, file), 'utf8')) as Scenario

  test(`SCENARIO: ${scenario.name} — ${scenario.description?.slice(0, 60) ?? ''}`, async () => {
    test.setTimeout(600_000)
    test.skip(!!scenario.requiresEnv && !process.env[scenario.requiresEnv], `${scenario.requiresEnv} not set`)
    const t0 = Date.now()
    const cdpPort = 9300 + Math.floor(Math.random() * 200)

    const browser = await chromium.launch({
      ...(process.env.OSBORN_TEST_CONTAINER ? { headless: true } : { channel: 'chrome' as const, headless: false }),
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        `--remote-debugging-port=${cdpPort}`,
      ],
    })
    const profilePath = scenario.profile ? join(__dirname, '..', 'profiles', scenario.profile, 'state.json') : null
    test.skip(!!profilePath && !existsSync(profilePath), `profile ${scenario.profile} not saved — run scripts/save-profile.ts`)
    const context = await browser.newContext({
      permissions: ['microphone'],
      ...(scenario.viewport ? { viewport: scenario.viewport } : {}),
      ...(profilePath ? { storageState: profilePath } : {}),
      recordVideo: { dir: test.info().outputDir, size: scenario.viewport ?? { width: 1280, height: 720 } },
    })
    const page = await context.newPage()
    const dt = attachDevtools(page) // the tester's DevTools sense — console + network, app-agnostic
    const tVideoStart = Date.now()
    await installReactiveMic(page)

    await fetch(`${AGENT_URL}/connect-room`, { method: 'POST' }).catch(() => {})
    await expect(async () => {
      const h: any = await fetch(`${AGENT_URL}/health`).then((r) => r.json())
      expect(h?.livekit?.status).toBe('connected')
    }).toPass({ timeout: 60_000, intervals: [1_000] })

    const version: any = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then((r) => r.json())
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = envKey('GOOGLE_API_KEY')
    const stagehand = new Stagehand({
      env: 'LOCAL',
      localBrowserLaunchOptions: { cdpUrl: version.webSocketDebuggerUrl },
      model: 'google/gemini-2.5-flash',
      modelClientOptions: { apiKey: envKey('GOOGLE_API_KEY') },
      verbose: 0,
    })
    await stagehand.init()
    const brain = (i: string) => actWithCache(stagehand, page, i)

    const chatUrl = scenario.url
      ? `${APP_URL}${scenario.url}`
      : `${APP_URL}/chat?provider=gemini&voiceArch=pipeline&agent=claude&agentUrl=${encodeURIComponent(AGENT_URL)}`
    const { captureStartedAt } = await enterFreshRoom(page, brain, chatUrl, {
      earsOn: true,
      agentUrl: AGENT_URL,
      entry: scenario.entry ?? 'fresh',
    })
    let tCaptureStart = captureStartedAt ?? Date.now()
    // Stall watchdog: never sit on a dead "Connecting..." screen — recover
    // or exit with evidence (screenshot + DevTools view). A reload wipes
    // in-page capture state, so re-arm.
    let reloaded = false
    try {
      ;({ reloaded } = await ensureSessionLive(page, brain, chatUrl, { agentUrl: AGENT_URL, diagnostics: () => dt.summary() }))
    } catch (e) {
      const diagPath = test.info().outputPath('devtools-diagnostics.txt')
      writeFileSync(diagPath, `CONSOLE:\n${dt.console.join('\n')}\n\nNETWORK:\n${dt.network.join('\n')}`)
      await test.info().attach('devtools-diagnostics', { path: diagPath, contentType: 'text/plain' })
      addSiteFinding(new URL(APP_URL).hostname, `Stall in ${scenario.name}: ${(e as Error).message.slice(0, 160)}`)
      throw e
    }
    if (reloaded) {
      await startElementCapture(page)
      tCaptureStart = Date.now()
    }
    console.log(`[scenario:${scenario.name}] in room (live) +${Date.now() - t0}ms`)
    flight({ type: 'in-room', scenario: scenario.name, ms: Date.now() - t0 })

    // ---- deterministic steps ----
    for (const step of scenario.steps ?? []) {
      if (step.act) await brain(step.act)
      else if (step.say) { await drainSpeechEvents(page); await speakText(page, step.say) }
      else if (step.waitSpeech) await waitForSpeechEvent(page, step.waitSpeech === 'stop' ? 'speech-stop' : 'speech-start', 90_000)
      else if (step.pause) await page.waitForTimeout(step.pause)
      else if (step.assertScreen) await expect(page.getByText(new RegExp(step.assertScreen, 'i')).first()).toBeVisible({ timeout: 60_000 })
      else if (step.upload) {
        const filePath = join(__dirname, '..', step.upload)
        await page.setInputFiles('input[type="file"]', filePath)
        console.log(`[scenario:${scenario.name}] uploaded ${step.upload}`)
      }
    }

    // ---- improvised conversation phase ----
    let agentReplies = 0
    const history: Turn[] = []
    if (scenario.conversation) {
      const extra = scenario.requiresEnv ? `\nEXTRA CONTEXT: ${scenario.requiresEnv}=${process.env[scenario.requiresEnv]}` : ''
      const maxTurns = scenario.conversation.maxTurns ?? 4
      const hearing = scenario.conversation.hearing ?? 'audio'
      const turnGapMs = scenario.conversation.turnGapMs ?? 2_500
      let lastShot: string | undefined
      for (let turn = 0; turn < maxTurns; turn++) {
        const tail = await screenTail(page)
        const { say, reason } = await nextUtterance(scenario.conversation.goal + extra, history, tail, lastShot)
        if (!say) { console.log(`[scenario:${scenario.name}] tester ended: ${reason}`); break }
        console.log(`[scenario:${scenario.name}] tester: "${say}"`)
        flight({ type: 'tester-says', scenario: scenario.name, say })
        history.push({ speaker: 'tester', text: say })
        await drainSpeechEvents(page)
        await speakText(page, say)
        // PERCEPTION: audio event triggers the clip; when sound stops, the
        // whole bundle (heard words + screenshot + screen text) comes back
        // as one unit — the brain's next decision input. App-agnostic:
        // no selectors, no captions dependency.
        try {
          const { perceiveNextUtterance } = await import('../lib/perception')
          const p = await perceiveNextUtterance(page, tCaptureStart, { settleMs: turnGapMs })
          agentReplies++
          const agentSaid = hearing === 'screen' || !p.heard ? p.screenText.slice(-500) : p.heard
          console.log(`[scenario:${scenario.name}] heard (live): "${agentSaid.slice(0, 150)}"`)
          flight({ type: 'agent-heard', scenario: scenario.name, heard: agentSaid.slice(0, 300) })
          history.push({ speaker: 'agent', text: agentSaid })
          lastShot = p.screenshotB64
        } catch {
          console.log(`[scenario:${scenario.name}] no audible reply to turn ${turn + 1}`)
          history.push({ speaker: 'agent', text: `(no audio reply) screen: ${(await screenTail(page)).slice(-300)}` })
          lastShot = (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64')
        }
      }
    }

    // ---- capture, verify, replay, log ----
    // Don't clip the agent's final words: wait for silence before stopping.
    await waitForSpeechEvent(page, 'speech-stop', 12_000).catch(() => {})
    await page.waitForTimeout(3_000)
    const out = test.info().outputPath(`${scenario.name}-capture.webm`)
    const cap = await saveCapture(page, out)
    const heard = await transcribe(out)
    console.log(`[scenario:${scenario.name}] heard: "${heard.slice(0, 300)}"`)
    flight({ type: 'scenario-complete', scenario: scenario.name, agentReplies })
    logResult(`scenario:${scenario.name}`, {
      agentReplies,
      testerTurns: history.filter((h) => h.speaker === 'tester').map((h) => h.text),
      captureBytes: cap.bytes,
      heard: heard.slice(0, 600),
    })
    await test.info().attach('agent-audio', { path: out, contentType: 'audio/webm' })
    // TEARDOWN MUST NEVER HANG. stagehand.close()/context.close()/saveAs can
    // block indefinitely on a half-dead CDP connection (observed: teardown
    // froze until the 10-min test timeout force-killed the browser). Race
    // every packaging step against a deadline; replays are best-effort,
    // finishing the test is not.
    const within = <T,>(ms: number, p: Promise<T>): Promise<T | null> =>
      Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))])
    const video = page.video()
    await within(10_000, stagehand.close())
    await within(15_000, context.close())
    if (video) {
      const vidPath = test.info().outputPath('screen-video.webm')
      const saved = await within(20_000, video.saveAs(vidPath).then(() => true))
      if (saved) {
        try {
          const offsetSec = ((tCaptureStart - tVideoStart) / 1000).toFixed(2)
          const replay = test.info().outputPath('replay-with-audio.webm')
          execSync(`ffmpeg -y -loglevel error -i "${vidPath}" -itsoffset ${offsetSec} -i "${out}" -map 0:v -map 1:a -c copy "${replay}"`, { timeout: 60_000 })
          await test.info().attach('replay-with-audio', { path: replay, contentType: 'video/webm' })
        } catch { /* best-effort */ }
      }
    }
    await within(10_000, browser.close())

    if (scenario.conversation?.minAudibleReplies)
      expect(agentReplies, 'audible agent replies').toBeGreaterThanOrEqual(scenario.conversation.minAudibleReplies)
    if (scenario.conversation?.assertHeard)
      expect(heard.toLowerCase(), `capture should contain /${scenario.conversation.assertHeard}/`).toMatch(new RegExp(scenario.conversation.assertHeard, 'i'))
  })
}
