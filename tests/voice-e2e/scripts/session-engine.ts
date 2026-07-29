/**
 * SESSION ENGINE — a persistent, director-controlled browser session.
 *
 * Unlike a one-shot test, this launches ONE browser and KEEPS IT ALIVE,
 * streaming live, holding its room connection, waiting for commands. The
 * director (a supervising agent or the user via curl) drives it step by step
 * and reads state between actions — no abrupt close, full coverage from the
 * live feed + the recorded clip.
 *
 *   npx tsx scripts/session-engine.ts
 *
 * Then control it over HTTP (default :8781; live viewer on :8080):
 *   GET  /status              → { inRoom, tabs, marks, live }
 *   POST /act    {instruction}→ brain acts (Stagehand, cached)
 *   POST /say    {text}       → speak into the mic (reactive)
 *   POST /hear                → transcript of what the agent said recently
 *   POST /shot                → base64 screenshot of the active tab
 *   POST /tab    {op,url,i}   → open | switch | list tabs
 *   POST /end                 → graceful leave + save video + shut down
 *
 * Auth flow by default (profiles/osbornojure) when present; guest link if not.
 */
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { Stagehand } from '@browserbasehq/stagehand'
import { createServer } from 'http'
import { existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { installReactiveMic, speakText } from '../lib/reactive-mic'
import { installActionVisualizer } from '../lib/action-visualizer'
import { startLiveStream } from '../lib/live-stream'
import { saveCapture } from '../lib/audio-capture'
import { enterFreshRoom, ensureSessionLive } from '../lib/steps'
import { hearSince } from '../lib/converse'
import { actWithCache } from '../lib/step-cache'
import { openTab, switchTab, listTabs } from '../lib/tabs'
import { envKey } from '../lib/env'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENT_URL = process.env.OSBORN_AGENT_URL || 'https://osborn-d4f24f46-v2.fly.dev'
const APP_URL = process.env.OSBORN_APP_URL || 'https://www.voice-native.com'
const CONTROL_PORT = Number(process.env.SESSION_ENGINE_PORT ?? 8781)
const CDP_PORT = 9280
const OUT_DIR = join(__dirname, '..', 'test-results', 'session-engine')
mkdirSync(OUT_DIR, { recursive: true })

const marks: { t: number; mark: string }[] = []
const mark = (m: string) => { marks.push({ t: Date.now(), mark: m }); console.log(`[engine] ${m}`) }

async function main() {
  const profile = join(__dirname, '..', 'profiles', 'osbornojure', 'state.json')
  const useAuth = existsSync(profile)
  const browser: Browser = await chromium.launch({
    channel: 'chrome', headless: false,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${CDP_PORT}`],
  })
  const context: BrowserContext = await browser.newContext({
    permissions: ['microphone'],
    ...(useAuth ? { storageState: profile } : {}),
    recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } },
  })
  let active: Page = await context.newPage()
  await installReactiveMic(active)
  await installActionVisualizer(active)
  // tsx/esbuild injects a __name helper that isn't defined in the browser's
  // page.evaluate context (the Playwright runner bundles differently). Shim it.
  await active.addInitScript(() => { (globalThis as any).__name = (globalThis as any).__name || ((f: any) => f) })
  const live = await startLiveStream(active).catch(() => null)
  mark(`browser up (${useAuth ? 'auth' : 'guest'}) — live: ${live?.url ?? 'n/a'}`)

  const version: any = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json())
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = envKey('GOOGLE_API_KEY')
  const stagehand = new Stagehand({
    env: 'LOCAL', localBrowserLaunchOptions: { cdpUrl: version.webSocketDebuggerUrl },
    model: 'google/gemini-2.5-flash', modelClientOptions: { apiKey: envKey('GOOGLE_API_KEY') }, verbose: 0,
  })
  await stagehand.init()
  const brain = (i: string) => actWithCache(stagehand, active, i)

  const chatUrl = `${APP_URL}/chat?provider=gemini&voiceArch=pipeline&agent=claude&agentUrl=${encodeURIComponent(AGENT_URL)}`
  const url = useAuth ? `${APP_URL}/dashboard` : chatUrl
  const { captureStartedAt } = await enterFreshRoom(active, brain, useAuth ? chatUrl : url, { earsOn: true, agentUrl: AGENT_URL })
  await ensureSessionLive(active, brain, chatUrl, { agentUrl: AGENT_URL })
  let tCapture = captureStartedAt ?? Date.now()
  mark('in room — awaiting direction')

  const json = (res: any, body: any, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  const readBody = (req: any): Promise<any> => new Promise((r) => { let b = ''; req.on('data', (c: any) => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')) } catch { r({}) } }) })

  let ending = false
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url || '').split('?')[0]
      if (req.method === 'GET' && path === '/status') {
        return json(res, { inRoom: true, useAuth, live: live?.url, tabs: listTabs(context).map((t) => ({ i: t.index, url: t.url })), marks: marks.slice(-12) })
      }
      const body = await readBody(req)
      if (path === '/act') { const r = await brain(body.instruction); mark(`act: ${String(body.instruction).slice(0, 60)}`); return json(res, { ok: true, result: r }) }
      if (path === '/say') { await speakText(active, body.text); mark(`say: ${String(body.text).slice(0, 60)}`); return json(res, { ok: true }) }
      if (path === '/hear') { const since = Date.now() - tCapture - (body.lastMs ?? 20000); const heard = await hearSince(active, Math.max(0, since)).catch(() => ''); return json(res, { heard }) }
      if (path === '/shot') { const b = await active.screenshot({ type: 'jpeg', quality: 60 }); return json(res, { jpegB64: b.toString('base64') }) }
      if (path === '/tab') {
        if (body.op === 'open') { active = await openTab(context, body.url); mark(`tab open: ${body.url ?? ''}`) }
        else if (body.op === 'switch') { active = await switchTab(context, body.i); mark(`tab switch: ${body.i}`) }
        return json(res, { ok: true, tabs: listTabs(context).map((t) => ({ i: t.index, url: t.url })) })
      }
      if (path === '/end') {
        ending = true
        mark('end requested — graceful leave')
        json(res, { ok: true, msg: 'shutting down' })
        await brain('Click the Disconnect or Leave button to end the voice session').catch(() => {})
        await active.waitForTimeout(2000)
        await fetch(`${AGENT_URL}/leave-room`, { method: 'POST' }).catch(() => {})
        const out = join(OUT_DIR, 'session-engine-capture.webm')
        await saveCapture(active, out).catch(() => {})
        const video = active.video()
        await stagehand.close().catch(() => {})
        await live?.stop().catch(() => {})
        await context.close().catch(() => {})
        if (video) await video.saveAs(join(OUT_DIR, 'session-engine.webm')).catch(() => {})
        await browser.close()
        server.close()
        console.log(`[engine] done — artifacts in ${OUT_DIR}`)
        process.exit(0)
      }
      json(res, { error: 'unknown', paths: ['/status', '/act', '/say', '/hear', '/shot', '/tab', '/end'] }, 404)
    } catch (e) { json(res, { error: (e as Error).message }, 500) }
  })
  server.listen(CONTROL_PORT, () => console.log(`[engine] control API on http://127.0.0.1:${CONTROL_PORT}  (live: ${live?.url})`))

  // Keep the process alive; safety leave if the director never ends it.
  setInterval(() => { if (!ending) void tCapture }, 30000)
}

main().catch((e) => { console.error('[engine] fatal:', e); process.exit(1) })
