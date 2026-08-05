/**
 * SESSION ENGINE — a persistent, director-controlled browser session.
 *
 * The self-hostable core of the Browser Screen Recorder skill: launch ONE
 * browser and KEEP IT ALIVE, streaming live, holding its room connection,
 * waiting for commands. The director (a supervising agent or the user via
 * curl) drives it step by step and reads state between actions. Runs the same
 * on a laptop (headed Chrome) or any container/Fly machine (bundled headless
 * Chromium) — and the brain attaches over CDP, so a cloud browser vendor
 * (Browserbase etc.) can substitute for the local launch.
 *
 *   npx tsx scripts/session-engine.ts
 *
 * Control over HTTP (default :8781; live MJPEG viewer on :8080). When
 * OSBORN_ENGINE_TOKEN is set (ALWAYS set it on public deployments), every
 * request must carry `x-engine-token: <token>`.
 *   GET  /status              → ground truth: pageUrl, pageState, idlePaused,
 *                               brain ready/dead, lastFrameAgeMs, runDir
 *   GET  /tasks               → this run's task index (from the manifest)
 *   GET  /clip?n=N            → download task N's mp4 (video/mp4)
 *   GET  /artifact?n=N        → download task N's screenshot (image/jpeg)
 *   POST /act    {instruction}→ brain acts (Stagehand, cached). Returns clip.
 *   POST /say    {text}       → speak into the mic. Returns clip + heard reply.
 *   POST /hear   {lastMs}     → transcript of what the agent said recently
 *   POST /shot                → base64 screenshot (on-demand look; NOT the
 *                               per-task proof — video is)
 *   POST /tab    {op,url,i}   → open | switch | list tabs
 *   POST /brain               → re-init a detached Stagehand brain in place
 *   POST /recover             → reload the active tab (unstick a blank page)
 *   POST /end                 → graceful leave + save audio + shut down (bounded)
 *
 * RESULTS MODEL (v2): every engine run gets its own folder
 *   <results>/runs/<stamp>/   (results dir: OSBORN_RESULTS_DIR or
 *                              test-results/session-engine — on Fly point it
 *                              at the /data volume)
 * VIDEO IS THE PROOF MEDIUM (user decision 2026-07-31): every /act and /say
 * returns its own mp4 clip from the live-stream ring buffer, delivered PER
 * TASK — never batched to run end. No per-task screenshots. manifest.json is
 * REWRITTEN ON EVERY EVENT — kill the engine at any point and the full task
 * index is already on disk. No continuous recordVideo (the old model grew
 * 1.3GB in 3 days and its index only wrote on a clean /end). Old runs are
 * pruned at startup (keep OSBORN_KEEP_RUNS, default 10).
 *
 * TWO MODES:
 *  - DIRECTED: the user/agent drives via /act & /say, video proof per task.
 *  - SELF-DRIVING (replay): every directed /act and /say also appends to this
 *    run's scenario.yaml (same shape as scenarios/*.yaml). Copy it into
 *    scenarios/ to canonize a workflow; the step-cache + knowledge/<site>/
 *    files are the per-site step memory that makes replays cheap (cache HIT =
 *    0 LLM calls) and self-healing on drift.
 *
 * Auth flow by default (profiles/<OSBORN_TEST_PROFILE>, default osborn-tester)
 * when a saved profile exists; guest link if not.
 */
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { Stagehand } from '@browserbasehq/stagehand'
import { createServer } from 'http'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, createReadStream, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { installReactiveMic, speakText } from '../lib/reactive-mic'
import { installActionVisualizer } from '../lib/action-visualizer'
import { startLiveStream } from '../lib/live-stream'
import { saveCapture } from '../lib/audio-capture'
import { enterFreshRoom, ensureSessionLive } from '../lib/steps'
import { hearSince } from '../lib/converse'
import { actWithCache } from '../lib/step-cache'
import { openTab, switchTab, closeTab, listTabs } from '../lib/tabs'
import { attachDevtools, type DevtoolsBuffer } from '../lib/devtools'
import { saveJourney, listJourneys } from '../lib/knowledge'
import { mintProfileFromEnv } from '../lib/mint-profile'
import { envKey } from '../lib/env'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Default agent = the TEST account's own machine (osborn-tester is routed to
// osborn-1b9d70e5-v2 in the instances table since 2026-07-31), so engine runs
// never collide with the owner's machine (osborn-d4f24f46-v2).
const AGENT_URL = process.env.OSBORN_AGENT_URL || 'https://osborn-1b9d70e5-v2.fly.dev'
const APP_URL = process.env.OSBORN_APP_URL || 'https://www.voice-native.com'
const CONTROL_PORT = Number(process.env.SESSION_ENGINE_PORT ?? 8781)
const CDP_PORT = 9280
const OUT_DIR = process.env.OSBORN_RESULTS_DIR || join(__dirname, '..', 'test-results', 'session-engine')
const RUNS_ROOT = join(OUT_DIR, 'runs')
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const RUN_DIR = join(RUNS_ROOT, RUN_STAMP)
mkdirSync(RUN_DIR, { recursive: true })

// Retention: keep the newest OSBORN_KEEP_RUNS run folders (counting this one),
// prune the rest at startup so the artifact dir can't balloon.
const KEEP_RUNS = Number(process.env.OSBORN_KEEP_RUNS ?? 10)
try {
  const old = readdirSync(RUNS_ROOT).filter((d) => d !== RUN_STAMP).sort()
  for (const d of old.slice(0, Math.max(0, old.length - (KEEP_RUNS - 1))))
    rmSync(join(RUNS_ROOT, d), { recursive: true, force: true })
} catch { /* first run */ }

// INCREMENTAL MANIFEST — the crash-proof task index. Rewritten on every mark
// and every task stamp; there is no end-of-run-only write anywhere.
const marks: { t: number; mark: string }[] = []
const tasks: Array<{ n: number; label: string; text?: string; heard?: string; startMs: number; endMs: number; rel0: number; rel1: number; clip?: string | null }> = []
const manifest: Record<string, unknown> = {
  run: RUN_STAMP, startedAt: Date.now(), model: 'per-task video + incremental manifest (v2)',
  agentUrl: AGENT_URL, appUrl: APP_URL, profile: null, useAuth: false, live: null,
  tasks, endedAt: null, audioCapture: null,
}
const writeManifest = () => {
  try { writeFileSync(join(RUN_DIR, 'manifest.json'), JSON.stringify({ ...manifest, marks: marks.slice(-200) }, null, 2)) } catch { /* ignore */ }
}
const mark = (m: string) => { marks.push({ t: Date.now(), mark: m }); writeManifest(); console.log(`[engine] ${m}`) }

// MODE-2 STEP MEMORY: every directed /act and /say also lands in this run's
// scenario.yaml (same shape as scenarios/*.yaml) — a directed session becomes
// a replayable workflow. Copy into scenarios/ to canonize.
const scenarioSteps: Array<{ kind: string; value: string }> = []
const writeScenario = () => {
  try {
    const y = [
      `name: run-${RUN_STAMP}`,
      `description: Auto-exported from a directed engine session (${RUN_STAMP}).`,
      `profile: ${manifest.profile ?? 'osborn-tester'}`,
      'steps:',
      ...scenarioSteps.map((s) => `  - ${s.kind}: ${JSON.stringify(s.value)}`),
    ].join('\n')
    writeFileSync(join(RUN_DIR, 'scenario.yaml'), y + '\n')
  } catch { /* ignore */ }
}

async function main() {
  // Which voice-native test account the engine drives. Default osborn-tester
  // (osborn-tester@voice-native.com — the email/password account, so its
  // profile is script-mintable via scripts/login-test-user.ts) so the engine's
  // meeting/session doesn't collide with your own osbornojure usage. NOTE:
  // ozyjunks@gmail.com is Google-OAuth and can NEVER be minted headlessly.
  // Override with OSBORN_TEST_PROFILE. If no saved profile exists for it, the
  // engine falls back to the guest link (works, but not the real auth path).
  const profileName = process.env.OSBORN_TEST_PROFILE || 'osborn-tester'
  const profile = join(__dirname, '..', 'profiles', profileName, 'state.json')
  // Cloud auth: no profile on disk (images ship guest-only) but operator
  // provided creds via secrets → mint a fresh session right now. Runs every
  // boot, so the ~1h Supabase session is always fresh after a wake.
  if (!existsSync(profile)) await mintProfileFromEnv(profile, APP_URL)
  const useAuth = existsSync(profile)
  manifest.profile = profileName; manifest.useAuth = useAuth
  mark(`test account: ${profileName} (${useAuth ? 'auth profile found' : 'no profile → guest link'})`)
  // Launch modes:
  //  - Local Mac: real Chrome, headed (you see the real window yourself).
  //  - Container + OSBORN_DISPLAY (Xvfb running, set by fly-run.sh): bundled
  //    Chromium HEADFUL on the virtual display — the x11grab stream then shows
  //    the FULL browser (real tab strip, URL bar, navigation).
  //  - Container without a display: headless fallback (CDP capture + HUD).
  const IN_CONTAINER = !!process.env.OSBORN_TEST_CONTAINER
  const DISPLAY_MODE = !!process.env.OSBORN_DISPLAY
  // Display mode: start the stream server BEFORE the browser — a wake-up
  // visitor gets the viewer page in seconds and watches Chrome itself boot.
  let live: Awaited<ReturnType<typeof startLiveStream>> | null = null
  if (DISPLAY_MODE) live = await startLiveStream(null).catch(() => null)
  const launchArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${CDP_PORT}`]
  if (IN_CONTAINER) launchArgs.push('--no-sandbox') // container runs as root
  if (DISPLAY_MODE) launchArgs.push('--window-position=0,0', `--window-size=${(process.env.OSBORN_DISPLAY_SIZE || '1280x800').replace('x', ',')}`)
  // DevTools ON CAMERA: OSBORN_DEVTOOLS=1 auto-opens the DevTools panel for
  // every tab — console/network visible in the stream and clips.
  if (process.env.OSBORN_DEVTOOLS) launchArgs.push('--auto-open-devtools-for-tabs')
  const browser: Browser = await chromium.launch({
    ...(IN_CONTAINER ? { headless: !DISPLAY_MODE } : { channel: 'chrome', headless: false }),
    args: launchArgs,
  })
  const context: BrowserContext = await browser.newContext({
    permissions: ['microphone'],
    ...(useAuth ? { storageState: profile } : {}),
    // NO recordVideo — per-task clips from the live-stream ring buffer are
    // the video record (the continuous recording grew unbounded).
  })
  // tsx/esbuild injects a __name helper that isn't defined in the browser's
  // evaluate context. CONTEXT-level so EVERY page gets it — page-level missed
  // tabs opened later (caught live by the devtools sense: "__name is not
  // defined" pageerror on tab 1's HUD evaluate).
  await context.addInitScript(() => { (globalThis as any).__name = (globalThis as any).__name || ((f: any) => f) })
  let active: Page = await context.newPage()
  // DEVTOOLS SENSE per tab — console, page errors, failed network, websocket
  // lifecycle. Every task response carries the active tab's summary so the
  // DIRECTOR reviews debug state alongside the media before deciding the next
  // step; GET /logs serves the full buffers; devtools.txt persists per run.
  // Late-bound so watchPage (defined early) can emit webhooks (wired later).
  let notifyRef: (event: string, payload?: Record<string, unknown>) => void = () => {}
  const devtoolsBufs = new Map<Page, DevtoolsBuffer>()
  // Per-tab last-use for the staleness sweep (touched by act/say/eval/tab ops).
  const tabLastUsed = new Map<Page, number>()
  const touchTab = (p: Page) => tabLastUsed.set(p, Date.now())
  const watchPage = (p: Page) => {
    if (devtoolsBufs.has(p)) return
    devtoolsBufs.set(p, attachDevtools(p))
    touchTab(p)
    // Browser events → webhooks: navigations ("the browser got forwarded")
    // and page errors, tagged with the tab they happened on.
    p.on('framenavigated', (f) => { if (f === p.mainFrame()) notifyRef('navigation', { url: f.url(), tab: context.pages().indexOf(p) }) })
    p.on('pageerror', (e) => notifyRef('page_error', { message: e.message.slice(0, 300), tab: context.pages().indexOf(p) }))
    // Meeting/agent activity → first-class events: the frontend logs its data
    // messages to console; promote transcripts and agent output so directors
    // detect activity on ONE stream instead of tailing three log sources.
    p.on('console', (m) => {
      const t = m.text()
      if (/Meeting transcript|user_transcript/i.test(t)) notifyRef('transcript', { text: t.slice(0, 250), tab: context.pages().indexOf(p) })
      else if (t.includes('claude_output')) notifyRef('agent_output', { text: t.slice(0, 200), tab: context.pages().indexOf(p) })
    })
  }
  const writeDevtoolsFile = () => {
    try {
      const dump = context.pages().map((p, i) => {
        const b = devtoolsBufs.get(p)
        return b ? `===== TAB ${i} — ${p.url()}\n--- console\n${b.console.join('\n')}\n--- network\n${b.network.join('\n')}` : ''
      }).filter(Boolean).join('\n\n')
      writeFileSync(join(RUN_DIR, 'devtools.txt'), dump)
    } catch { /* ignore */ }
  }
  watchPage(active)
  await installReactiveMic(active)
  await installActionVisualizer(active)
  if (!live) live = await startLiveStream(active).catch(() => null)
  manifest.live = live?.url ?? null
  manifest.captureMode = DISPLAY_MODE ? 'display (full browser window)' : 'page (CDP)'
  mark(`browser up (${useAuth ? 'auth' : 'guest'}${IN_CONTAINER ? ', container' : ''}, capture: ${DISPLAY_MODE ? 'full-window' : 'page'}) — live: ${live?.url ?? 'n/a'}`)

  // BRAIN — re-initializable in place. A double page reload detaches Stagehand
  // ("uninitialized Stagehand object") and previously killed /act for the rest
  // of the session; now POST /brain rebuilds it over the same CDP endpoint.
  let stagehand: Stagehand | null = null
  let brainAlive = false
  const initBrain = async () => {
    const version: any = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json())
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = envKey('GOOGLE_API_KEY')
    stagehand = new Stagehand({
      env: 'LOCAL', localBrowserLaunchOptions: { cdpUrl: version.webSocketDebuggerUrl },
      model: 'google/gemini-2.5-flash', modelClientOptions: { apiKey: envKey('GOOGLE_API_KEY') }, verbose: 0,
    })
    await stagehand.init()
    brainAlive = true
  }
  await initBrain()
  const brain = async (i: string) => {
    if (!stagehand || !brainAlive) throw new Error('brain dead — POST /brain to re-init')
    try { return await actWithCache(stagehand, active, i) }
    catch (e) {
      if (/uninitialized|detached|closed|Target/i.test(String(e))) { brainAlive = false; mark('brain detached — POST /brain to re-init') }
      throw e
    }
  }

  const chatUrl = `${APP_URL}/chat?provider=gemini&voiceArch=pipeline&agent=claude&agentUrl=${encodeURIComponent(AGENT_URL)}`
  const url = useAuth ? `${APP_URL}/dashboard` : chatUrl
  // BOOT ORDER (v8): the room join happens in the BACKGROUND, after the
  // control server is listening. A wedged "Connecting..." must never leave
  // the engine headless — 2026-07-31 a platform-side guest-connect regression
  // did exactly that: no /status, no /shot, no way to see or steer the boot.
  let tCapture = Date.now()
  let roomReady = false

  const json = (res: any, body: any, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  const readBody = (req: any): Promise<any> => new Promise((r) => { let b = ''; req.on('data', (c: any) => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')) } catch { r({}) } }) })

  let reqN = 0
  // PROOF MEDIA PER TASK (user requirement 2026-07-31): every /act and /say
  // returns BOTH a video clip (ring buffer + heartbeat frames, so it is a
  // continuous wall-clock record) AND a screenshot, in the SAME response —
  // never batched to run end. Failures surface (clipError), they don't
  // silently degrade to "trust me".
  const reqClip = async (n: number, label: string, seconds = 20): Promise<{ clip: string | null; clipError: string | null }> => {
    if (!live?.clip) return { clip: null, clipError: 'live stream unavailable — no clips this session' }
    try {
      const p = join(RUN_DIR, `req-${String(n).padStart(3, '0')}-${label}.mp4`)
      const out = await live.clip(p, seconds)
      if (out) { mark(`clip: ${out}`); return { clip: out, clipError: null } }
      return { clip: null, clipError: 'clip failed — ffmpeg unavailable or too few frames' }
    } catch (e) { return { clip: null, clipError: (e as Error).message } }
  }
  const reqShot = async (n: number, label: string): Promise<string | null> => {
    const p = join(RUN_DIR, `req-${String(n).padStart(3, '0')}-${label}.jpg`)
    try { await active.screenshot({ path: p, type: 'jpeg', quality: 60 }); return p } catch { /* fall back */ }
    // FALLBACK (diag 2026-08-05: page.screenshot fails in headful display mode
    // → artifact:null → /artifact 404s). Use the live x11grab frame so the
    // screenshot field is NEVER null when a stream exists.
    try { const b64 = live?.latestFrame(); if (b64) { writeFileSync(p, Buffer.from(b64, 'base64')); return p } } catch { /* ignore */ }
    return null
  }
  // TAB HUD — ONLY for headless/CDP capture, where the screencast has no
  // browser chrome and tabs would be invisible. In full-window (display) mode
  // the REAL tab strip is on camera, so the injected badge is clutter on the
  // page — removed per user (2026-07-31).
  const updateTabHud = async () => {
    if (DISPLAY_MODE) {
      await Promise.all(context.pages().map((p) => p.evaluate(() => document.getElementById('__osb_tabhud')?.remove()).catch(() => {})))
      return
    }
    const pages = context.pages()
    const activeI = pages.indexOf(active)
    await Promise.all(pages.map((p, i) => p.evaluate((info: { i: number; n: number; isActive: boolean }) => {
      let el = document.getElementById('__osb_tabhud')
      if (!el) {
        el = document.createElement('div'); el.id = '__osb_tabhud'
        Object.assign(el.style, { position: 'fixed', top: '8px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483647', background: 'rgba(15,15,20,0.88)', color: '#ffd479', font: '600 13px monospace', padding: '5px 14px', borderRadius: '8px', pointerEvents: 'none', border: '1px solid rgba(255,212,121,0.4)' })
        document.documentElement.appendChild(el)
      }
      el.textContent = `TAB ${info.i + 1}/${info.n}${info.isActive ? ' • ACTIVE' : ''} — ${location.host}${location.pathname}`
    }, { i, n: pages.length, isActive: i === activeI }).catch(() => { /* page navigating */ })))
  }
  // MULTI-AGENT TAB REGISTRY — several director agents can share one engine
  // without stepping on each other: a tab can be CLAIMED by an owner name;
  // /act & /say on a tab claimed by someone else are refused (409) unless the
  // matching owner is passed. Unclaimed tabs are free-for-all. The registry
  // travels in /status and persists across sleep with the tab state.
  const tabOwners = new Map<Page, { owner: string; claimedAt: number }>()
  const ownerOf = (p: Page) => tabOwners.get(p)?.owner ?? null
  const guardOwnership = (body: any): string | null => {
    const o = ownerOf(active)
    if (o && body.owner !== o) return `tab ${context.pages().indexOf(active)} is claimed by "${o}" — pass matching owner or switch tabs`
    return null
  }

  // STATE ACROSS SLEEP — persist the tab layout (urls, active index, owners)
  // on every change; on boot, reopen it. The engine wakes where it left off.
  const TAB_STATE = join(OUT_DIR, 'last-tabs.json')
  const saveTabState = () => {
    try {
      const pages = context.pages()
      writeFileSync(TAB_STATE, JSON.stringify({
        savedAt: Date.now(), activeIndex: pages.indexOf(active),
        tabs: pages.map((p) => ({ url: p.url(), owner: ownerOf(p) })),
      }, null, 2))
    } catch { /* ignore */ }
  }

  // Stamp a task into the manifest. rel0/rel1 are ms since audio-capture start
  // (the audio timeline), so transcript windows line up with task windows.
  // Every task records WHICH TAB it ran on ({i, url} at execution time) — the
  // per-tab memory that lets a director reconstruct what happened where.
  const activeTab = () => ({ i: context.pages().indexOf(active), url: active.url(), owner: ownerOf(active) })
  const stampTask = (n: number, label: string, startMs: number, clip: string | null, artifact: string | null, text?: string, heard?: string) => {
    const endMs = Date.now()
    touchTab(active)
    const devtools = devtoolsBufs.get(active)?.summary() ?? null
    const rec = { n, label, text, heard, tab: activeTab(), startMs, endMs, rel0: Math.max(0, startMs - tCapture), rel1: Math.max(0, endMs - tCapture), clip, artifact, devtools }
    tasks.push(rec); writeManifest(); writeDevtoolsFile(); saveTabState()
    notifyRef('task', { task: { n, label, text, heard, tab: rec.tab }, clipUrl: clip ? `/clip?n=${n}` : null, artifactUrl: artifact ? `/artifact?n=${n}` : null })
    return rec
  }

  // (room join + tab restore run in background after server.listen — see below)
  // Self-host auth: when OSBORN_ENGINE_TOKEN is set (always on public
  // deployments — Fly exposes the control port), every request must carry it.
  const TOKEN = process.env.OSBORN_ENGINE_TOKEN
  let ending = false
  let lastActivity = Date.now()

  // MEETING AWARENESS (v14, from a real kill): the engine idle-stopped 10min
  // into a live Google Meet (driver hadn't opened a journey, so hold-awake
  // never engaged) and its shutdown clicked Disconnect — turning a survivable
  // participant blip into an explicit leave that nulled the agent's LLM while
  // the Recall bot sat deaf in the call. The engine now detects meeting state
  // from its own page and self-protects, no driver discipline required.
  const meetingActive = async (): Promise<boolean> => {
    try {
      return (await Promise.race([
        active.evaluate(() => /In Meeting|Joining…|Joining\.\.\./i.test(document.body?.innerText || '')),
        new Promise<boolean>((r) => setTimeout(() => r(false), 2500)),
      ])) as boolean
    } catch { return false }
  }

  // EVENT WEBHOOKS — push, not poll. When OSBORN_WEBHOOK_URL is set, the
  // engine POSTs JSON events there (fire-and-forget, 5s cap): task completions
  // (with media URLs), page navigations, tab changes, journey saves, page
  // errors, engine lifecycle. Optional OSBORN_WEBHOOK_TOKEN rides along as
  // x-engine-token. Failures mark once (no log spam) and never block work.
  const WEBHOOK_URL = process.env.OSBORN_WEBHOOK_URL || null
  const WEBHOOK_TOKEN = process.env.OSBORN_WEBHOOK_TOKEN || null
  let webhookFailures = 0
  // LIVE EVENT SUBSCRIPTION — the in-session twin of webhooks: GET /events is
  // an SSE stream on the same control connection. Subscribers get every event
  // the moment it happens (plus the last 25 on connect, so a reconnect misses
  // nothing recent). A sleeping engine says goodbye first (engine_stopping),
  // so subscribers KNOW the stream died on purpose. SSE listeners do NOT hold
  // the engine awake (commands and stream viewers do).
  const eventClients = new Set<import('http').ServerResponse>()
  const eventRing: Array<Record<string, unknown>> = []
  const notify = (event: string, payload: Record<string, unknown> = {}) => {
    const evt = { event, t: Date.now(), run: RUN_STAMP, ...payload }
    eventRing.push(evt); if (eventRing.length > 25) eventRing.shift()
    for (const c of eventClients) { try { c.write(`data: ${JSON.stringify(evt)}\n\n`) } catch { eventClients.delete(c) } }
    if (!WEBHOOK_URL) return
    fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(WEBHOOK_TOKEN ? { 'x-engine-token': WEBHOOK_TOKEN } : {}) },
      body: JSON.stringify(evt),
      signal: AbortSignal.timeout(5000),
    }).then(() => { webhookFailures = 0 })
      .catch(() => { if (++webhookFailures === 1) mark(`webhook delivery failing → ${WEBHOOK_URL}`) })
  }
  // Delivery-proof sink: point OSBORN_WEBHOOK_URL at this engine's own
  // /webhook-sink to verify the full HTTP push path, or read what an external
  // receiver would have gotten.
  const webhookSink: Array<Record<string, unknown>> = []
  notifyRef = notify
  notify('engine_ready', { live: live?.url, profile: manifest.profile, useAuth, captureMode: manifest.captureMode })

  // JOURNEY FRAMING — the "user feel" container around a test. A journey has
  // a name and a beginning; /journey end CLEANS UP (extra tabs closed,
  // default viewport restored) and PROMOTES the step sequence into
  // knowledge/<site>/journeys/ — the layer where a deployment learns each
  // site's real paths over time. A journey with an `owner` is also the
  // MISSION LOCK (v13, born of two real mid-mission machine kills — one from
  // each track): /status carries `mission` so any other driver/deployer sees
  // the engine is claimed, and idle-stop HOLDS while a mission is active
  // (capped at 2h so a forgotten journey can't hold the machine forever).
  let journey: { name: string; goal?: string; owner?: string; startStep: number; startTaskN: number; startUrl: string; startedAt: number } | null = null
  // Fetch-nag (v13): clips that were returned but never downloaded — the
  // act-verify gate's teeth. GET /clip marks a task reviewed-able.
  const fetchedClips = new Set<number>()
  // GRACEFUL SHUTDOWN — used by POST /end AND the idle watchdog. Every step
  // bounded + a hard watchdog: a hung Stagehand/CDP close must never wedge
  // the engine (the manifest's predecessor tasks.json was lost to exactly
  // that hang because it only wrote after a clean teardown).
  const gracefulEnd = async (reason: string) => {
    if (ending) return
    ending = true
    mark(`shutting down — ${reason}`)
    notify('engine_stopping', { reason })
    const watchdog = setTimeout(() => { console.log('[engine] teardown watchdog — force exit'); manifest.endedAt = Date.now(); writeManifest(); process.exit(0) }, 45000)
    const bounded = (p: Promise<unknown> | undefined | null, ms: number) =>
      p ? Promise.race([p.catch(() => null), new Promise((r) => setTimeout(() => r(null), ms))]) : Promise.resolve(null)
    // MEETING-AWARE SHUTDOWN (v14): while a meeting is active, do NOT click
    // Disconnect or POST /leave-room — an explicit leave kills the copilot
    // instantly, while a silent participant drop is absorbed by the agent's
    // 75s leave-grace (0.9.102), so a quick engine restart resumes cleanly.
    if (await meetingActive()) {
      mark('shutdown WITHOUT disconnect — meeting active; drop rides the agent leave-grace')
      notify('engine_stopping_meeting_active', { reason })
    } else {
      await bounded(brain('Click the Disconnect or Leave button to end the voice session').catch(() => null), 12000)
      await active.waitForTimeout(2000).catch(() => {})
      await bounded(fetch(`${AGENT_URL}/leave-room`, { method: 'POST' }), 5000)
    }
    const audioOut = join(RUN_DIR, 'audio-capture.webm')
    const savedAudio = await bounded(saveCapture(active, audioOut).then(() => audioOut), 10000)
    manifest.audioCapture = savedAudio ? 'audio-capture.webm' : null
    await bounded(stagehand?.close(), 8000)
    await bounded(live?.stop(), 5000)
    await bounded(context.close(), 8000)
    await bounded(browser.close(), 8000)
    manifest.endedAt = Date.now()
    writeManifest()
    clearTimeout(watchdog)
    server.close()
    console.log(`[engine] done — run artifacts in ${RUN_DIR}`)
    process.exit(0)
  }
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url || '').split('?')[0]
      if (TOKEN && req.headers['x-engine-token'] !== TOKEN) return json(res, { error: 'unauthorized — x-engine-token required' }, 401)
      // Any authenticated director command counts as activity for idle-stop.
      // /status is excluded (pollers/health checks must not keep it awake).
      if (path !== '/status') lastActivity = Date.now()
      if (req.method === 'GET' && path === '/status') {
        // GROUND TRUTH, not cached flags — the old `inRoom: true` reported a
        // healthy room while the page sat on the "Session paused" idle screen.
        let pageUrl = ''
        let pageState = 'unresponsive'
        let idlePaused = false
        try {
          pageUrl = active.url()
          pageState = (await Promise.race([
            active.evaluate(() => document.readyState),
            new Promise((r) => setTimeout(() => r('unresponsive'), 3000)),
          ])) as string
          if (pageState !== 'unresponsive')
            idlePaused = await active.evaluate(() => /session paused/i.test(document.body?.innerText || '')).catch(() => false)
        } catch { /* page dead */ }
        const lastFrame = live?.lastFrameAt() ?? null
        return json(res, {
          run: RUN_STAMP, runDir: RUN_DIR, roomReady, pageUrl, pageState, idlePaused,
          brain: brainAlive ? 'ready' : 'dead', useAuth, live: live?.url,
          lastFrameAgeMs: lastFrame ? Date.now() - lastFrame : null,
          taskCount: tasks.length, journey: journey?.name ?? null,
          mission: journey ? { name: journey.name, owner: journey.owner ?? null, startedAt: journey.startedAt } : null,
          activeTab: { i: context.pages().indexOf(active), url: active.url() },
          tabs: listTabs(context).map((t) => ({ i: t.index, url: t.url })), marks: marks.slice(-12),
        })
      }
      if (req.method === 'GET' && path === '/runs') {
        // All runs on this volume, newest last — pair with /clip?run=.
        let runs: Array<Record<string, unknown>> = []
        try {
          runs = readdirSync(RUNS_ROOT).sort().map((stamp) => {
            try { const m = JSON.parse(readFileSync(join(RUNS_ROOT, stamp, 'manifest.json'), 'utf8')); return { run: stamp, startedAt: m.startedAt, endedAt: m.endedAt, tasks: (m.tasks ?? []).length } }
            catch { return { run: stamp } }
          })
        } catch { /* empty */ }
        return json(res, { current: RUN_STAMP, runs })
      }
      if (req.method === 'GET' && (path === '/clip' || path === '/artifact')) {
        // Retrieve task N's proof media — how a REMOTE director (or the
        // user's machine) pulls video (/clip) and screenshot (/artifact) off
        // a Fly-hosted engine. `run=<stamp>` reaches PAST runs (they persist
        // on the volume; before v13 they 404'd after every restart).
        const q = new URL(req.url || '', 'http://x').searchParams
        const n = Number(q.get('n'))
        const runParam = q.get('run')
        let file: string | undefined
        if (runParam && runParam !== RUN_STAMP) {
          try {
            const m = JSON.parse(readFileSync(join(RUNS_ROOT, runParam.replace(/[^A-Za-z0-9T:-]/g, ''), 'manifest.json'), 'utf8'))
            const t = (m.tasks ?? []).find((t: { n: number }) => t.n === n)
            file = path === '/clip' ? t?.clip : t?.artifact
          } catch { /* fall through to 404 */ }
        } else {
          const t = tasks.find((t) => t.n === n) as any
          file = path === '/clip' ? t?.clip : t?.artifact
          if (path === '/clip' && file) fetchedClips.add(n)
        }
        if (!file || !existsSync(file)) return json(res, { error: `no ${path.slice(1)} for task ${n}${runParam ? ` in run ${runParam}` : ''} — GET /runs lists runs` }, 404)
        res.writeHead(200, { 'Content-Type': path === '/clip' ? 'video/mp4' : 'image/jpeg', 'Content-Length': statSync(file).size })
        createReadStream(file).pipe(res)
        return
      }
      if (req.method === 'GET' && path === '/logs') {
        // Full devtools state, all tabs — console, network, websockets.
        return json(res, {
          pages: context.pages().map((p, i) => {
            const b = devtoolsBufs.get(p)
            return { i, url: p.url(), console: b?.console.slice(-80) ?? [], network: b?.network.slice(-80) ?? [] }
          }),
        })
      }
      if (req.method === 'GET' && path === '/tasks') {
        // This run's task index — same data as manifest.json on disk.
        return json(res, { run: RUN_STAMP, runDir: RUN_DIR, model: 'per-task video; rel0/rel1 are ms on the audio-capture timeline', recordingStartedAt: tCapture, tasks })
      }
      const body = await readBody(req)
      if (path === '/webhook-sink') {
        if (req.method === 'POST') { webhookSink.push(body); if (webhookSink.length > 20) webhookSink.shift(); return json(res, { ok: true }) }
        return json(res, { received: webhookSink })
      }
      if (req.method === 'GET' && path === '/events') {
        // Subscribe: SSE feed of everything the engine does, live.
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
        res.write(`: engine events — run ${RUN_STAMP}\n\n`)
        for (const e of eventRing) res.write(`data: ${JSON.stringify(e)}\n\n`)
        eventClients.add(res)
        req.on('close', () => eventClients.delete(res))
        return
      }
      if (path === '/act') {
        const owned = guardOwnership(body)
        if (owned) return json(res, { error: owned }, 409)
        const t0 = Date.now()
        await updateTabHud()
        const r = await brain(body.instruction)
        mark(`act: ${String(body.instruction).slice(0, 60)}`)
        // POST-ACTION SETTLE: let the click's EFFECT (popover opening, page
        // reacting) paint and get captured before the clip is cut — clips cut
        // at brain-return ended right before the effect and proved nothing.
        await active.waitForTimeout(body.settleMs ?? 2500).catch(() => {})
        // Act-verify gate teeth (v13): surface the un-reviewed previous clip.
        const prevTask = tasks[tasks.length - 1]
        const nag = prevTask?.clip && !fetchedClips.has(prevTask.n) ? `task ${prevTask.n}'s clip was never fetched — review media before stacking more acts` : null
        const n = ++reqN
        const { clip, clipError } = await reqClip(n, 'act', body.clipSeconds ?? 20)
        const shot = await reqShot(n, 'act')
        const window = stampTask(n, 'act', t0, clip, shot, body.instruction)
        scenarioSteps.push({ kind: 'act', value: String(body.instruction) }); writeScenario()
        // keyframe: latest frame inline — review-and-relay without a download.
        // No inline keyframe (diag 2026-08-05: the 66KB base64 blob made
        // responses 71KB and broke strict JSON parsers twice). The atomic
        // driver fetches artifact+clip to local files instead.
        return json(res, { ok: true, result: r, clip, clipError, artifact: shot, clipUrl: `/clip?n=${n}`, artifactUrl: shot ? `/artifact?n=${n}` : null, nag, window })
      }
      if (path === '/say') {
        const ownedSay = guardOwnership(body)
        if (ownedSay) return json(res, { error: ownedSay }, 409)
        const t0 = Date.now(); await updateTabHud(); await speakText(active, body.text); mark(`say: ${String(body.text).slice(0, 60)}`); await active.waitForTimeout(6000)
        // Join the audio to the task: what did the agent say back?
        const heard = await hearSince(active, Math.max(0, t0 - tCapture)).catch(() => '')
        const n = ++reqN
        const { clip, clipError } = await reqClip(n, 'say', body.clipSeconds ?? 14)
        const shot = await reqShot(n, 'say')
        const window = stampTask(n, 'say', t0, clip, shot, body.text, heard)
        scenarioSteps.push({ kind: 'say', value: String(body.text) }); writeScenario()
        return json(res, { ok: true, clip, clipError, artifact: shot, clipUrl: `/clip?n=${n}`, artifactUrl: shot ? `/artifact?n=${n}` : null, heard, window })
      }
      if (path === '/hear') {
        // Errors surface — a silent catch here hid the timeline-skew bug for a day.
        const since = Date.now() - tCapture - (body.lastMs ?? 20000)
        try { return json(res, { heard: await hearSince(active, Math.max(0, since)) }) }
        catch (e) { mark(`hear failed: ${(e as Error).message}`); return json(res, { heard: '', error: (e as Error).message }) }
      }
      if (path === '/shot') { const b = await active.screenshot({ type: 'jpeg', quality: 60 }); return json(res, { jpegB64: b.toString('base64') }) }
      if (path === '/eval') {
        // Director's console: evaluate JS in the active tab's page context —
        // the programmatic version of typing into the website console. The
        // result AND any console output it triggers land in /logs + devtools.
        const owned = guardOwnership(body)
        if (owned) return json(res, { error: owned }, 409)
        try {
          const value = await Promise.race([
            active.evaluate((expr: string) => { const r = (0, eval)(expr); return typeof r === 'object' ? JSON.stringify(r)?.slice(0, 4000) : String(r) }, String(body.expression)),
            new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout (10s)')), 10000)),
          ])
          mark(`eval: ${String(body.expression).slice(0, 50)}`)
          touchTab(active)
          // Evals are journey steps too — the cloud meeting run saved a
          // 0-step recipe because it was driven entirely via /eval.
          scenarioSteps.push({ kind: 'eval', value: String(body.expression).slice(0, 140) }); writeScenario()
          return json(res, { ok: true, value })
        } catch (e) { return json(res, { ok: false, error: (e as Error).message }) }
      }
      if (path === '/tab') {
        // open | switch | close | claim | release | list. Optional per-op:
        //   owner: "<agent name>"      claims the opened tab / authorizes ops
        //   viewport: 'mobile' | {width,height}   (open) — e.g. mobile view
        // After ANY change of active tab the screencast is retargeted so the
        // live stream + clips show the tab work actually happens on.
        if (body.op === 'open') {
          // REUSE-BEFORE-OPEN (economy doctrine): an existing same-site tab
          // (not tab 0 — that holds the voice room — and unclaimed or ours)
          // gets NAVIGATED instead of stacking a new tab. reuse:false forces new.
          let reused = false
          if (body.reuse !== false && body.url) {
            try {
              const host = new URL(body.url).hostname
              const pages = context.pages()
              const cand = pages.find((p, idx) => { try { return idx > 0 && new URL(p.url()).hostname === host && (!ownerOf(p) || ownerOf(p) === body.owner) } catch { return false } })
              if (cand) { await cand.goto(String(body.url), { timeout: 45000 }); active = cand; reused = true }
            } catch { /* fall through to a fresh tab */ }
          }
          if (!reused) { active = await openTab(context, body.url); watchPage(active) }
          if (body.viewport === 'mobile') await active.setViewportSize({ width: 390, height: 844 })
          else if (body.viewport?.width) await active.setViewportSize({ width: body.viewport.width, height: body.viewport.height })
          if (body.owner) tabOwners.set(active, { owner: String(body.owner), claimedAt: Date.now() })
          touchTab(active)
          await live?.retarget(active).catch(() => {}); mark(`tab ${reused ? 'reuse' : 'open'}: ${body.url ?? ''}${body.owner ? ` [${body.owner}]` : ''}${body.viewport ? ' (mobile)' : ''}`)
        }
        else if (body.op === 'navigate') {
          // Point an EXISTING tab at a new URL (the reuse primitive).
          const target = body.i != null ? context.pages()[body.i] : active
          if (!target) return json(res, { error: `no tab ${body.i}` }, 404)
          const o = ownerOf(target)
          if (o && body.owner !== o) return json(res, { error: `tab is claimed by "${o}"` }, 409)
          await target.goto(String(body.url), { timeout: 45000 })
          active = target; touchTab(active)
          await live?.retarget(active).catch(() => {}); mark(`tab navigate: ${body.url}`)
        }
        else if (body.op === 'switch') { active = await switchTab(context, body.i); touchTab(active); await live?.retarget(active).catch(() => {}); mark(`tab switch: ${body.i}`) }
        else if (body.op === 'close') {
          const target = context.pages()[body.i]
          const o = target ? ownerOf(target) : null
          if (o && body.owner !== o) return json(res, { error: `tab ${body.i} is claimed by "${o}" — pass matching owner to close` }, 409)
          if (target) tabOwners.delete(target)
          active = await closeTab(context, body.i); await live?.retarget(active).catch(() => {}); mark(`tab close: ${body.i}`)
        }
        else if (body.op === 'claim') {
          const target = context.pages()[body.i]
          if (!target) return json(res, { error: `no tab ${body.i}` }, 404)
          const o = ownerOf(target)
          if (o && o !== body.owner) return json(res, { error: `tab ${body.i} already claimed by "${o}"` }, 409)
          tabOwners.set(target, { owner: String(body.owner), claimedAt: Date.now() }); mark(`tab claim: ${body.i} by ${body.owner}`)
        }
        else if (body.op === 'release') { const target = context.pages()[body.i]; if (target) tabOwners.delete(target); mark(`tab release: ${body.i}`) }
        // Tab ops are journey steps too — a recipe missing "open the mobile
        // tab" is not a recipe (first saved journey had steps:1 for this).
        if (['open', 'switch', 'close', 'navigate'].includes(body.op)) {
          scenarioSteps.push({ kind: 'tab', value: `${body.op}${body.url ? ' ' + body.url : ''}${body.viewport ? ' viewport=mobile' : ''}${body.i != null ? ' i=' + body.i : ''}` })
          writeScenario()
        }
        await updateTabHud(); saveTabState()
        notify('tab', { op: body.op, activeTab: activeTab(), tabCount: context.pages().length })
        return json(res, { ok: true, activeTab: activeTab(), tabs: listTabs(context).map((t) => ({ i: t.index, url: t.url, owner: ownerOf(context.pages()[t.index]) })) })
      }
      if (path === '/journey') {
        const host = (() => { try { return new URL(active.url()).hostname } catch { return 'unknown' } })()
        if (body.op === 'start') {
          if (journey && journey.owner && body.owner !== journey.owner) return json(res, { error: `mission "${journey.name}" is active (owner: ${journey.owner}) — coordinate or wait for journey end`, mission: { name: journey.name, owner: journey.owner, startedAt: journey.startedAt } }, 409)
          journey = { name: String(body.name || 'unnamed'), goal: body.goal, owner: body.owner ? String(body.owner) : undefined, startStep: scenarioSteps.length, startTaskN: reqN, startUrl: active.url(), startedAt: Date.now() }
          mark(`journey start: ${journey.name}${journey.owner ? ` [${journey.owner}]` : ''}${journey.goal ? ` — ${journey.goal}` : ''}`)
          return json(res, { ok: true, journey, knownJourneys: listJourneys(host) })
        }
        if (body.op === 'end') {
          if (!journey) return json(res, { error: 'no journey in progress' }, 400)
          const steps = scenarioSteps.slice(journey.startStep)
          let saved: string | null = null
          if (body.save !== false && steps.length) {
            try { saved = saveJourney(host, journey.name, { goal: journey.goal ?? null, startUrl: journey.startUrl, auth: useAuth ? String(manifest.profile) : 'guest', savedAt: new Date().toISOString(), steps }) } catch { /* volume issue */ }
          }
          if (body.cleanup !== false) {
            while (context.pages().length > 1) { try { active = await closeTab(context, context.pages().length - 1) } catch { break } }
            await live?.retarget(active).catch(() => {})
            try { await active.setViewportSize({ width: 1280, height: 720 }) } catch { /* ignore */ }
            saveTabState()
          }
          mark(`journey end: ${journey.name} (${steps.length} step(s)${saved ? ', saved to knowledge' : ''})`)
          const done = { ok: true, name: journey.name, steps: steps.length, saved, tasks: [journey.startTaskN + 1, reqN] }
          notify('journey_end', { name: journey.name, goal: journey.goal ?? null, steps: steps.length, saved: !!saved })
          journey = null
          return json(res, done)
        }
        if (body.op === 'list') return json(res, { site: host, journeys: listJourneys(host) })
        return json(res, { error: 'op must be start | end | list' }, 400)
      }
      if (path === '/brain') {
        // Recover a detached Stagehand without restarting the whole engine.
        try { await stagehand?.close().catch(() => {}) } catch { /* ignore */ }
        await initBrain()
        mark('brain re-initialized')
        return json(res, { ok: true, brain: 'ready' })
      }
      if (path === '/recover') {
        await active.reload({ timeout: 45000 }).catch(() => {})
        await active.waitForTimeout(4000)
        const shot = join(RUN_DIR, `recover-${Date.now()}.jpg`)
        await active.screenshot({ path: shot, type: 'jpeg', quality: 60 }).catch(() => {})
        mark('recovered (page reloaded)')
        return json(res, { ok: true, artifact: shot, brain: brainAlive ? 'ready' : 'dead' })
      }
      if (path === '/end') {
        json(res, { ok: true, msg: 'shutting down' })
        void gracefulEnd('end requested')
        return
      }
      json(res, { error: 'unknown', paths: ['/status', '/tasks', '/clip?n=N', '/artifact?n=N', '/act', '/say', '/hear', '/shot', '/eval', '/tab', '/journey', '/brain', '/recover', '/end'] }, 404)
    } catch (e) { json(res, { error: (e as Error).message, brain: brainAlive ? 'ready' : 'dead' }, 500) }
  })
  server.listen(CONTROL_PORT, () => console.log(`[engine] control API on http://127.0.0.1:${CONTROL_PORT}  (live: ${live?.url})${TOKEN ? '  [token-protected]' : ''}`))

  // BACKGROUND ROOM JOIN + tab restore — the engine is already fully
  // drivable (/status /shot /act /recover /eval) while this runs or wedges.
  void (async () => {
    // GENERIC ENTRY (open-source posture): OSBORN_ENTRY=none skips the
    // voice-native room flow entirely — just load APP_URL and be a browser.
    // Point the engine at ANY site: OSBORN_APP_URL=https://any.site OSBORN_ENTRY=none.
    if (process.env.OSBORN_ENTRY === 'none') {
      try { await active.goto(APP_URL, { timeout: 60000 }) } catch (e) { mark(`entry goto failed: ${(e as Error).message.slice(0, 80)}`) }
      roomReady = true
      mark(`entry: none — ${APP_URL} loaded, no room flow`)
      notify('room_ready', { entry: 'none' })
    } else try {
      const { captureStartedAt } = await enterFreshRoom(active, brain, useAuth ? chatUrl : url, { earsOn: true, agentUrl: AGENT_URL })
      await ensureSessionLive(active, brain, chatUrl, { agentUrl: AGENT_URL })
      tCapture = captureStartedAt ?? Date.now()
      roomReady = true
      mark('in room — awaiting direction')
      notify('room_ready', {})
    } catch (e) {
      mark(`room join FAILED: ${(e as Error).message.slice(0, 120)} — engine still drivable; use /recover or /act to steer`)
      notify('room_join_failed', { error: (e as Error).message.slice(0, 200) })
    }
    // WAKE WHERE IT LEFT OFF: reopen the pre-sleep tab layout (urls + owners
    // + active tab). Index 0 is skipped — the boot flow rebuilt the chat tab.
    // Disable with OSBORN_RESTORE_TABS=0.
    if (process.env.OSBORN_RESTORE_TABS !== '0' && existsSync(TAB_STATE)) {
      try {
        const st = JSON.parse(readFileSync(TAB_STATE, 'utf8'))
        // Never restore chat/session tabs — the boot flow rebuilds the
        // session tab itself; restoring a saved one creates a SECOND room
        // participant (2026-08-02: double-join churn broke the session gate).
        const extra = (st.tabs ?? []).slice(1).filter((t: { url: string }) => {
          try { return new URL(t.url).pathname !== '/chat' } catch { return true }
        })
        for (const t of extra) {
          active = await openTab(context, t.url); watchPage(active)
          if (t.owner) tabOwners.set(active, { owner: t.owner, claimedAt: Date.now() })
        }
        if (extra.length) {
          const pages = context.pages()
          active = await switchTab(context, Math.min(st.activeIndex ?? 0, pages.length - 1))
          await live?.retarget(active).catch(() => {})
          mark(`restored ${extra.length} tab(s) from pre-sleep state`)
        }
      } catch (e) { mark(`tab restore failed: ${(e as Error).message.slice(0, 100)}`) }
    }
  })()

  // IDLE AUTO-STOP (user request 2026-07-31): after OSBORN_IDLE_STOP_MS with
  // no director commands AND nobody watching the live stream, shut down
  // gracefully — on Fly the machine stops (restart policy 'never') and
  // auto_start_machines boots it again on the next request. Default 10 min in
  // containers, disabled locally (set OSBORN_IDLE_STOP_MS to override; 0 = off).
  // 15min default (user request 2026-08-02 — was 10min; meetings/gates need breathing room)
  const IDLE_STOP_MS = Number(process.env.OSBORN_IDLE_STOP_MS ?? (IN_CONTAINER ? 900000 : 0))
  const MISSION_MAX_MS = 2 * 60 * 60 * 1000
  setInterval(async () => {
    if (ending || !IDLE_STOP_MS) return
    if ((live?.viewerCount() ?? 0) > 0) { lastActivity = Date.now(); return }
    // HOLD-AWAKE during missions (v13): an open journey keeps the engine up
    // (a meeting mission dozing mid-call was a real failure) — capped at 2h.
    if (journey && Date.now() - journey.startedAt < MISSION_MAX_MS) { lastActivity = Date.now(); return }
    // MEETING HOLD-AWAKE (v14): journey or not, an active meeting on the page
    // holds the engine up — the 10-min idle once killed a live Meet copilot.
    if (Date.now() - lastActivity > IDLE_STOP_MS - 60000 && await meetingActive()) { lastActivity = Date.now(); mark('idle deferred — meeting active'); return }
    if (Date.now() - lastActivity > IDLE_STOP_MS) void gracefulEnd(`idle ${Math.round(IDLE_STOP_MS / 60000)}min — auto-stop`)
  }, 30000)

  // TAB STALENESS SWEEP (user request 2026-08-01): background tabs untouched
  // for OSBORN_TAB_STALE_MS (default 30min; 0 disables) get closed so tabs
  // never silently stack up. Tab 0 (the voice room) and the active tab are
  // exempt. Closes directly (no focus steal) and announces via events.
  const TAB_STALE_MS = Number(process.env.OSBORN_TAB_STALE_MS ?? 1800000)
  setInterval(async () => {
    if (ending || !TAB_STALE_MS) return
    const pages = context.pages()
    for (let i = pages.length - 1; i >= 1; i--) {
      const p = pages[i]
      if (p === active) continue
      if (!tabLastUsed.has(p)) { touchTab(p); continue }
      if (Date.now() - (tabLastUsed.get(p) ?? 0) <= TAB_STALE_MS) continue
      const url = p.url(); const owner = ownerOf(p)
      await p.close({ runBeforeUnload: false }).catch(() => {})
      if (!p.isClosed()) { mark(`stale tab ${i} refused to close: ${url.slice(0, 50)}`); continue }
      tabOwners.delete(p); tabLastUsed.delete(p)
      mark(`tab ${i} auto-closed (stale ${Math.round(TAB_STALE_MS / 60000)}min): ${url.slice(0, 50)}`)
      notify('tab_stale_closed', { i, url, owner })
      saveTabState()
    }
  }, 60000)
}

main().catch((e) => { console.error('[engine] fatal:', e); process.exit(1) })
