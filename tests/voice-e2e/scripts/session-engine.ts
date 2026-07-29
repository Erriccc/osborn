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
 *   GET  /status              → { inRoom, tabs, marks, live, taskCount, recordingStartedAt }
 *   GET  /tasks               → replay index: every task's window into the recording
 *   POST /act    {instruction}→ brain acts (Stagehand, cached). Returns { window }.
 *   POST /say    {text}       → speak into the mic (reactive). Returns { window }.
 *   POST /hear                → transcript of what the agent said recently
 *   POST /shot                → base64 screenshot of the active tab
 *   POST /tab    {op,url,i}   → open | switch | list tabs
 *   POST /recover             → reload the active tab (unstick a blank page)
 *   POST /end                 → graceful leave + save video + tasks.json + shut down
 *
 * REPLAY MODEL: one continuous recordVideo recording per session; each task is
 * a labeled window (rel0..rel1 ms) into it. No per-request video encoding — the
 * recording already holds every task's footage. Seek to a task's window to
 * replay exactly it. The live viewer streams in parallel off its own screencast.
 *
 * Auth flow by default (profiles/osbornojure) when present; guest link if not.
 */
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { Stagehand } from '@browserbasehq/stagehand'
import { createServer } from 'http'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
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
  // Which voice-native test account the engine drives. Default ozyjunks (a
  // separate test account) so the engine's meeting/session doesn't collide with
  // your own osbornojure usage — one machine restart won't interrupt the other.
  // Override with OSBORN_TEST_PROFILE. If no saved profile exists for it, the
  // engine falls back to the guest link (works, but not the real auth path).
  const profileName = process.env.OSBORN_TEST_PROFILE || 'ozyjunks'
  const profile = join(__dirname, '..', 'profiles', profileName, 'state.json')
  const useAuth = existsSync(profile)
  mark(`test account: ${profileName} (${useAuth ? 'auth profile found' : 'no profile → guest link'})`)
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

  let reqN = 0
  const reqShot = async (label: string) => {
    try { reqN++; const p = join(OUT_DIR, `req-${String(reqN).padStart(3,'0')}-${label}.jpg`)
      await active.screenshot({ path: p, type: 'jpeg', quality: 60 }); mark(`artifact: ${p}`); return p } catch { return null }
  }
  // Per-task VIDEO clip — every /act and /say gets its own reviewable mp4 from
  // the live-stream ring buffer, so we confirm the engine actually did the work
  // (not just trust a screenshot or the text result). Named to the same counter.
  const reqClip = async (label: string, seconds = 20) => {
    if (!live?.clip) return null
    try { const p = join(OUT_DIR, `req-${String(reqN).padStart(3,'0')}-${label}.mp4`)
      const out = await live.clip(p, seconds); if (out) mark(`clip: ${out}`); return out } catch { return null }
  }
  // TASK-WINDOW LEDGER — the replay model.
  // There is ONE continuous Playwright recordVideo recording for the whole
  // session (saved on /end). We do NOT cut a separate video per request; the
  // recording already holds every task's footage. Instead each /act or /say
  // records its window — wall-clock plus offset into the recording (relative to
  // tCapture, when recording began) — so a viewer seeks straight to [rel0,rel1]
  // to see exactly that task. Same footage a one-shot run hands you, just
  // labeled by task. The live stream runs off its own screencast in parallel
  // and never affects this recording.
  const tasks: Array<{ n: number; label: string; text?: string; startMs: number; endMs: number; rel0: number; rel1: number; artifact?: string | null }> = []
  const stampTask = (n: number, label: string, startMs: number, artifact: string | null, text?: string) => {
    const endMs = Date.now()
    const rec = { n, label, text, startMs, endMs, rel0: Math.max(0, startMs - tCapture), rel1: Math.max(0, endMs - tCapture), artifact }
    tasks.push(rec); return rec
  }
  let ending = false
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url || '').split('?')[0]
      if (req.method === 'GET' && path === '/status') {
        return json(res, { inRoom: true, useAuth, live: live?.url, recordingStartedAt: tCapture, taskCount: tasks.length, tabs: listTabs(context).map((t) => ({ i: t.index, url: t.url })), marks: marks.slice(-12) })
      }
      const body = await readBody(req)
      if (path === '/act') { const t0 = Date.now(); const r = await brain(body.instruction); mark(`act: ${String(body.instruction).slice(0, 60)}`); const shot = await reqShot('act'); const clip = await reqClip('act', body.clipSeconds ?? 20); const window = stampTask(reqN, 'act', t0, shot, body.instruction); return json(res, { ok: true, result: r, artifact: shot, clip, window }) }
      if (path === '/say') { const t0 = Date.now(); await speakText(active, body.text); mark(`say: ${String(body.text).slice(0, 60)}`); await active.waitForTimeout(6000); const shot = await reqShot('say'); const clip = await reqClip('say', body.clipSeconds ?? 14); const window = stampTask(reqN, 'say', t0, shot, body.text); return json(res, { ok: true, artifact: shot, clip, window }) }
      if (path === '/hear') { const since = Date.now() - tCapture - (body.lastMs ?? 20000); const heard = await hearSince(active, Math.max(0, since)).catch(() => ''); return json(res, { heard }) }
      if (path === '/shot') { const b = await active.screenshot({ type: 'jpeg', quality: 60 }); return json(res, { jpegB64: b.toString('base64') }) }
      if (req.method === 'GET' && path === '/tasks') {
        // The replay index: every task's window into the single recording.
        return json(res, { recordingStartedAt: tCapture, recording: 'session-engine.webm (saved on /end)', tasks })
      }
      if (path === '/tab') {
        if (body.op === 'open') { active = await openTab(context, body.url); mark(`tab open: ${body.url ?? ''}`) }
        else if (body.op === 'switch') { active = await switchTab(context, body.i); mark(`tab switch: ${body.i}`) }
        return json(res, { ok: true, tabs: listTabs(context).map((t) => ({ i: t.index, url: t.url })) })
      }
      if (path === '/recover') { await active.reload({ timeout: 45000 }).catch(()=>{}); await active.waitForTimeout(4000); const shot = await reqShot('recover'); mark('recovered (page reloaded)'); return json(res, { ok: true, artifact: shot }) }
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
        // Ship the replay index next to the recording: each task's window
        // (rel0..rel1 ms into session-engine.webm) + its screenshot.
        try { writeFileSync(join(OUT_DIR, 'tasks.json'), JSON.stringify({ recording: 'session-engine.webm', recordingStartedAt: tCapture, tasks }, null, 2)) } catch { /* ignore */ }
        await browser.close()
        server.close()
        console.log(`[engine] done — artifacts in ${OUT_DIR}`)
        process.exit(0)
      }
      json(res, { error: 'unknown', paths: ['/status', '/tasks', '/act', '/say', '/hear', '/shot', '/tab', '/recover', '/end'] }, 404)
    } catch (e) { json(res, { error: (e as Error).message }, 500) }
  })
  server.listen(CONTROL_PORT, () => console.log(`[engine] control API on http://127.0.0.1:${CONTROL_PORT}  (live: ${live?.url})`))

  // Keep the process alive; safety leave if the director never ends it.
  setInterval(() => { if (!ending) void tCapture }, 30000)
}

main().catch((e) => { console.error('[engine] fatal:', e); process.exit(1) })
