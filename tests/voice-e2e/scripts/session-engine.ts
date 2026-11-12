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
import { execFile } from 'child_process'
import { createHmac, randomBytes } from 'crypto'
import { promisify } from 'util'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, createReadStream, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { installReactiveMic, speakText } from '../lib/reactive-mic'
import { installActionVisualizer } from '../lib/action-visualizer'
import { startLiveStream } from '../lib/live-stream'
import { saveCapture, peekCapture, startElementCapture } from '../lib/audio-capture'
import { enterFreshRoom, ensureSessionLive } from '../lib/steps'
import { hearSince } from '../lib/converse'
import { actWithCache, forgetCached } from '../lib/step-cache'
import { openTab, switchTab, closeTab, listTabs } from '../lib/tabs'
import { attachDevtools, type DevtoolsBuffer } from '../lib/devtools'
import { saveJourney, listJourneys } from '../lib/knowledge'
import { mintProfileFromEnv } from '../lib/mint-profile'
import { optionalEnvKey } from '../lib/env'
import { buildJourneyState, decideRecovery, retryDelayMs, type JourneyStateFile, type PersistedJourney } from '../lib/journey-store'

const __dirname = dirname(fileURLToPath(import.meta.url))
const execFileP = promisify(execFile)
// Agent URL = the Voice Native machine the auto-joined chat talks to. NO
// hardcoded default (#49): the old default host (osborn-1b9d70e5-v2.fly.dev)
// left DNS when that agent machine was retired, and a dead default just wedges
// the boot chat on "Connecting…" forever. Empty = no agent configured → the
// engine skips the room join, opens a neutral page, and marks `agentUnreachable`
// on /status + the live view. Set OSBORN_AGENT_URL to a reachable agent to
// auto-join a chat.
const AGENT_URL = process.env.OSBORN_AGENT_URL || ''
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
const KEEP_RUNS = Number(process.env.OSBORN_KEEP_RUNS ?? 30)
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
  // #120: when this process ADOPTED a journey from a process that died
  // mid-journey, this links back to the run that died (else null). Lets a
  // caller pull the pre-restart run's media via /clip?run=<previousRun>.
  previousRun: null,
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

// LAST-RESORT SAFETY NET: one stray rejection (a model API error surfacing from
// inside the brain library, a CDP call on a closed tab) must never take down
// the engine every driver shares. Log it, mark it, keep serving.
process.on('unhandledRejection', (e) => { mark(`unhandled rejection (engine kept alive): ${String((e as Error)?.message ?? e).slice(0, 160)}`) })
process.on('uncaughtException', (e) => { mark(`uncaught exception (engine kept alive): ${String(e?.message ?? e).slice(0, 160)}`) })

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
  // OSBORN_CHROMIUM_PATH: use an existing Chromium/Chrome binary instead of
  // Playwright's own download — for hosts whose preinstalled browser doesn't
  // match this package's pinned Playwright build ("Executable doesn't exist").
  const CHROMIUM_PATH = process.env.OSBORN_CHROMIUM_PATH || null
  const browser: Browser = await chromium.launch({
    ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH, headless: IN_CONTAINER ? !DISPLAY_MODE : false }
      : IN_CONTAINER ? { headless: !DISPLAY_MODE } : { channel: 'chrome', headless: false }),
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
    live?.trackPage?.(p)
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
  for (const p of context.pages()) live?.trackPage?.(p)
  manifest.live = live?.url ?? null
  manifest.captureMode = DISPLAY_MODE ? 'display (full browser window)' : 'page (CDP)'
  mark(`browser up (${useAuth ? 'auth' : 'guest'}${IN_CONTAINER ? ', container' : ''}, capture: ${DISPLAY_MODE ? 'full-window' : 'page'}) — live: ${live?.url ?? 'n/a'}`)

  // BRAIN — re-initializable in place. A double page reload detaches Stagehand
  // ("uninitialized Stagehand object") and previously killed /act for the rest
  // of the session; now POST /brain rebuilds it over the same CDP endpoint.
  let stagehand: Stagehand | null = null
  let brainAlive = false
  // WHY the brain is down (missing key, bad key, CDP attach failure) — carried
  // on /status and every refused /act so a director never has to guess.
  let brainError: string | null = null
  // BRAIN PROVIDER FALLBACK (ported from b8dd898 on
  // fix/engine-voice-deepgram-gemini): a single depleted key (Gemini prepay
  // ran dry, 402) must not leave the engine brainless. Probe each configured
  // key with a 1-token real completion and build the brain on the first
  // provider that answers: Gemini → Anthropic → z.ai (Anthropic-compatible).
  // Keys travel in headers, never in a URL, so a failed probe can't leak one
  // into a log line.
  let brainModel = ''
  const pickBrainModel = async (): Promise<{ model: string; opts: Record<string, string> }> => {
    const tried: string[] = []
    const probe = async (name: string, url: string, headers: Record<string, string>, body: unknown): Promise<boolean> => {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) }).catch(() => null)
      if (r?.ok) return true
      tried.push(`${name} ${r ? r.status : 'network'}`)
      mark(`brain: ${name} probe failed (${r ? r.status : 'network'}) — trying next provider`)
      return false
    }
    const anthropicBody = (model: string) => ({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] })
    const g = optionalEnvKey('GOOGLE_API_KEY') || optionalEnvKey('GEMINI_API_KEY')
    if (g && await probe('gemini', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', { 'x-goog-api-key': g },
      { contents: [{ parts: [{ text: 'ok' }] }], generationConfig: { maxOutputTokens: 1 } })) return { model: 'google/gemini-2.5-flash', opts: { apiKey: g } }
    const a = optionalEnvKey('ANTHROPIC_API_KEY')
    if (a && await probe('anthropic', 'https://api.anthropic.com/v1/messages', { 'x-api-key': a, 'anthropic-version': '2023-06-01' }, anthropicBody('claude-haiku-5-5')))
      return { model: 'anthropic/claude-haiku-5-5', opts: { apiKey: a } }
    const z = optionalEnvKey('Z_AI_API_KEY') || optionalEnvKey('ZAI_API_KEY')
    if (z && await probe('z.ai', 'https://api.z.ai/api/anthropic/v1/messages', { 'x-api-key': z, 'anthropic-version': '2023-06-01' }, anthropicBody('glm-4.7')))
      return { model: 'anthropic/glm-4.7', opts: { apiKey: z, baseURL: 'https://api.z.ai/api/anthropic/v1' } }
    throw new Error(tried.length ? `no working brain key — ${tried.join(', ')}` : 'no brain key — set GOOGLE_API_KEY (or GEMINI_API_KEY), ANTHROPIC_API_KEY or Z_AI_API_KEY')
  }
  // TEST SEAM: OSBORN_BRAIN_STUB=1 swaps the brain for one that "acts" by
  // doing nothing. It exists to exercise everything AROUND the brain — effect
  // detection, warnings, the scroll fallback, clips — without a model key.
  const BRAIN_STUB = process.env.OSBORN_BRAIN_STUB === '1'
  const initBrain = async () => {
    brainAlive = false
    if (BRAIN_STUB) { brainAlive = true; brainError = null; brainModel = 'stub (does nothing)'; mark('brain STUB active — /act performs no action'); return }
    try {
      const picked = await pickBrainModel()
      const version: any = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json())
      if (picked.model.startsWith('google/')) process.env.GOOGLE_GENERATIVE_AI_API_KEY = picked.opts.apiKey
      // The Anthropic-compatible path (z.ai) lost its key when only passed as
      // a client option alongside a custom baseURL ("Anthropic API key is
      // missing" on every act). The provider SDK also reads these env vars,
      // so set them for whichever Anthropic-style provider was picked.
      if (picked.model.startsWith('anthropic/')) {
        process.env.ANTHROPIC_API_KEY = picked.opts.apiKey
        if (picked.opts.baseURL) process.env.ANTHROPIC_BASE_URL = picked.opts.baseURL; else delete process.env.ANTHROPIC_BASE_URL
      }
      stagehand = new Stagehand({
        env: 'LOCAL', localBrowserLaunchOptions: { cdpUrl: version.webSocketDebuggerUrl },
        model: picked.model as any, modelClientOptions: picked.opts, verbose: 0,
      })
      await stagehand.init()
      brainAlive = true; brainError = null; brainModel = picked.model
      mark(`brain ready on ${picked.model}`)
    } catch (e) {
      brainError = ((e as Error).message || String(e)).slice(0, 200)
      throw e
    }
  }
  // A brain that can't start must NEVER take the whole engine down (it used to
  // be a fatal boot error: no control API, no stream, nothing to diagnose
  // with). Boot brainless: /eval /tab /shot /recover keep working, /act says
  // why it can't, and POST /brain retries once the key/CDP problem is fixed.
  await initBrain().catch(() => mark(`brain unavailable — ${brainError} — engine still drivable (/eval /tab /shot); POST /brain to retry`))
  // Speech-to-text key health, checked at boot and on POST /brain (#151).
  type SttHealth = { provider: string; ok: boolean; status: number | string }
  let sttHealth: SttHealth[] = []
  const probeStt = async () => {
    const out: SttHealth[] = []
    const check = async (provider: string, url: string, headers: Record<string, string>) => {
      try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) }); out.push({ provider, ok: r.ok, status: r.status }) }
      catch (e) { out.push({ provider, ok: false, status: String((e as Error).message).slice(0, 60) }) }
    }
    const sx = optionalEnvKey('SONIOX_API_KEY'); if (sx) await check('soniox', 'https://api.soniox.com/v1/files?limit=1', { Authorization: `Bearer ${sx}` })
    const dg = optionalEnvKey('DEEPGRAM_API_KEY'); if (dg) await check('deepgram', 'https://api.deepgram.com/v1/projects', { Authorization: `Token ${dg}` })
    sttHealth = out
    const bad = out.filter((h) => !h.ok)
    mark(out.length ? `ears: ${out.map((h) => `${h.provider} ${h.ok ? 'ok' : `FAILED (${h.status})`}`).join(', ')}` : 'ears: no speech-to-text key configured — /say and /hear cannot transcribe')
    if (out.length && bad.length === out.length) notify('stt_unavailable', { providers: out })
  }
  void probeStt()
  const brainDownMsg = () => `brain unavailable — ${brainError ?? 'detached'}. POST /brain to re-init; /eval, /tab and /shot still work`
  const brain = async (i: string) => {
    if (BRAIN_STUB) return { cached: false, healed: false, did: 'stub: no action performed' }
    if (!stagehand || !brainAlive) throw new Error(brainDownMsg())
    try { return await actWithCache(stagehand, active, i) }
    catch (e) {
      if (/uninitialized|detached|closed|Target/i.test(String(e))) { brainAlive = false; brainError = 'detached from the browser'; mark('brain detached — POST /brain to re-init') }
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
  // True only after the voice-room join actually succeeded (NOT for
  // OSBORN_ENTRY=none or the agent-unreachable neutral page).
  let joinedRoom = false
  // AGENT REACHABILITY (#49): null while the configured agent is reachable (or
  // before a join is attempted); set to a short "agent unreachable: <host>"
  // reason when the boot chat can't be joined, so /status and the live view say
  // WHY instead of the chat spinning on "Connecting…" forever.
  let agentUnreachable: string | null = null

  const json = (res: any, body: any, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  const readBody = (req: any): Promise<any> => new Promise((r) => { let b = ''; req.on('data', (c: any) => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')) } catch { r({}) } }) })

  let reqN = 0
  const jobs = new Map<string, { done: boolean; path: string; startedAt: number; code?: number; body?: unknown }>()
  let jobN = 0
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
  const reqShot = async (n: number, label: string, page: Page = active): Promise<string | null> => {
    const p = join(RUN_DIR, `req-${String(n).padStart(3, '0')}-${label}.jpg`)
    try { await page.screenshot({ path: p, type: 'jpeg', quality: 60 }); return p } catch { /* fall back */ }
    // FALLBACK (diag 2026-08-05: page.screenshot fails in headful display mode
    // → artifact:null → /artifact 404s). Use the live x11grab frame so the
    // screenshot field is NEVER null when a stream exists.
    try { const b64 = live?.latestFrame(); if (b64) { writeFileSync(p, Buffer.from(b64, 'base64')); return p } } catch { /* ignore */ }
    return null
  }
  // ── AUDIO MUX (v23) ─────────────────────────────────────────────────────
  // The MJPEG stream + all clips are VIDEO-ONLY; the agent's voice is captured
  // separately (element-tap → MediaRecorder). Peek that recording and (a) serve
  // it as mp3 (GET /audio) and (b) mux a task's ALIGNED audio slice into its
  // video clip (GET /clip?n=N&audio=1). Alignment maps wall-clock → recording
  // time via the recording's OWN start (startedAt = now - sinceStartMs), NOT
  // tCapture — raw manifest rel0/rel1 are on tCapture's timeline and misalign by
  // the anchor gap (proven: rel-based slicing returned silence).
  // `startedAt` is the WALL-CLOCK instant of the recording file's time zero.
  // That is NOT when capture was armed: the recorder's timeline begins at the
  // first tapped audio source (the anchor), which can be many seconds later
  // (on the boot tab, the whole room-join gap). It is computed BEFORE the
  // decode, which for a long recording takes seconds and used to skew it.
  // `page` defaults to the active tab; callers outside the action lock must
  // pass the tab they mean. Temp files are per call (two muxes used to share
  // `_peek.*` and could read each other's half-written audio).
  let peekSeq = 0
  const peekAudioToWav = async (page: Page = active, maxMs = 30 * 60 * 1000): Promise<{ wav: string; startedAt: number; durationMs: number } | null> => {
    try {
      const { base64, sinceStartMs, anchorOffsetMs } = await peekCapture(page)
      const startedAt = Date.now() - sinceStartMs + anchorOffsetMs
      if (!base64) return null
      // Decoding the whole recording on every turn does not scale (a 2h
      // capture is ~30s of ffmpeg and ~700MB of wav). Past the cap, proof
      // clips go without the page-audio track rather than stall every /say.
      if (sinceStartMs > maxMs) { mark(`page-audio track skipped — recording is ${Math.round(sinceStartMs / 60000)}min long`); return null }
      const id = ++peekSeq
      const webm = join(RUN_DIR, `_peek-${id}.webm`)
      writeFileSync(webm, Buffer.from(base64, 'base64'))
      const wav = join(RUN_DIR, `_peek-${id}.wav`)
      // Full decode → wav: MediaRecorder opus can't be seeked directly (bad
      // packet headers — proven), so decode once and trim the wav reliably.
      await execFileP('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:a', 'pcm_s16le', '-ar', '48000', wav])
      try { rmSync(webm, { force: true }) } catch { /* ignore */ }
      const probe = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav]).catch(() => ({ stdout: '0' }))
      return { wav, startedAt, durationMs: Math.round((Number(String(probe.stdout).trim()) || 0) * 1000) }
    } catch { return null }
  }
  const muxClipAudio = async (videoPath: string, endMs: number, n: number, page: Page = active): Promise<string | null> => {
    const a = await peekAudioToWav(page)
    if (!a) return null
    try {
      const probe = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath])
      const dur = Math.max(1, Number(String(probe.stdout).trim()) || 14)
      // Clip video spans ~[endMs - dur, endMs] in wall-clock; map to recording time.
      const startSec = Math.max(0, (endMs - a.startedAt) / 1000 - dur)
      const out = join(RUN_DIR, `req-${String(n).padStart(3, '0')}-withaudio.mp4`)
      await execFileP('ffmpeg', ['-y', '-loglevel', 'error', '-i', videoPath, '-ss', String(startSec), '-i', a.wav,
        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', out])
      return existsSync(out) ? out : null
    } catch { return null }
  }
  // EARS ON ANY TAB. Page-audio capture used to be armed only by the boot
  // room-join on tab 0, so a voice session in any other tab was deaf: /say
  // "succeeded" with an empty transcript and /hear threw. The ears now arm
  // themselves on whichever tab is spoken to or listened on, and every answer
  // says what state they were in, so "the agent was silent" can be told apart
  // from "nobody was listening".
  const earsState = async (p: Page): Promise<{ armed: boolean; startedAt: number | null; audioElements: number; playing: number }> =>
    (await Promise.race([
      p.evaluate(() => {
        const c = (globalThis as any).__osbornCapture
        const els = [...document.querySelectorAll('audio,video')] as HTMLMediaElement[]
        return { armed: !!c, startedAt: c?.startedAt ?? null, audioElements: els.length, playing: els.filter((e) => !e.paused && (e.srcObject || e.currentSrc)).length }
      }),
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ]).catch(() => null)) ?? { armed: false, startedAt: null, audioElements: 0, playing: 0, unknown: true }
  const ensureEars = async (p: Page) => {
    const before = await earsState(p) as Awaited<ReturnType<typeof earsState>> & { unknown?: boolean }
    // A page too busy to answer is NOT "unarmed": arming again would replace
    // the existing recording and orphan its recorder. Only arm on a clear no.
    if (before.armed || before.unknown) return { ...before, armedNow: false }
    await startElementCapture(p).catch(() => {})
    return { ...(await earsState(p)), armedNow: true }
  }
  // AUDIBLE PROOF for a spoken turn: the true-time video clip plus BOTH sides
  // of the audio — what the tester said (the synthesized utterance, placed at
  // the instant it was played into the mic) and what the page played back
  // (the ears' recording, aligned by wall clock). Returns null when there is
  // no audio at all to add.
  const muxSayAudio = async (clip: { path: string; startMs: number; endMs: number }, saidWav: string | null, playStartMs: number, n: number, page: Page = active, captions?: { said: string; heard: string }): Promise<{ path: string; said: boolean; heard: boolean } | null> => {
    const args = ['-y', '-loglevel', 'error', '-i', clip.path]
    const filters: string[] = []; const labels: string[] = []
    let idx = 1
    const said = !!saidWav && existsSync(saidWav) && playStartMs > 0
    if (said) {
      const d = Math.round(playStartMs - clip.startMs)
      // d < 0: the clip starts AFTER the utterance began (a turn longer than
      // the frame buffer) — skip that much of the wav instead of pinning the
      // whole utterance to the start of the clip.
      if (d < 0) args.push('-ss', (-d / 1000).toFixed(3))
      args.push('-i', saidWav!); filters.push(`[${idx}:a]aresample=48000${d > 0 ? `,adelay=${d}:all=1` : ''}[s]`); labels.push('[s]'); idx++
    }
    const a = await peekAudioToWav(page)
    // Only a slice that actually overlaps the clip counts as a heard track: a
    // seek past the end of the recording muxes silence and must not be
    // reported as page audio.
    const off = a ? (clip.startMs - a.startedAt) / 1000 : 0
    const heard = !!a && off * 1000 < a.durationMs - 100 && a.startedAt < clip.endMs
    if (a && heard) {
      if (off >= 0) args.push('-ss', off.toFixed(3))
      args.push('-i', a.wav)
      filters.push(`[${idx}:a]aresample=48000${off < 0 ? `,adelay=${Math.round(-off * 1000)}:all=1` : ''}[h]`); labels.push('[h]'); idx++
    }
    const cleanup = () => { if (a) { try { rmSync(a.wav, { force: true }) } catch { /* ignore */ } } }
    if (!labels.length) { cleanup(); return null }
    const out = join(RUN_DIR, `req-${String(n).padStart(3, '0')}-say-av.mp4`)
    // Bounded: an unbounded apad never ends once video is re-encoded.
    const clipDur = Math.max(1, (clip.endMs - clip.startMs) / 1000)
    // Players autoplay muted, so the clip SHOWS its sound: waveform + captions.
    filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,apad=whole_dur=${clipDur.toFixed(3)},atrim=0:${clipDur.toFixed(3)},loudnorm=I=-18:TP=-2,aformat=channel_layouts=stereo,asplit=2[a][aw]`)
    filters.push(`[aw]showwaves=s=1280x90:mode=cline:colors=0x46d38a,format=rgba,colorchannelmixer=aa=0.85[wav]`)
    let vchain = `[0:v]scale=1280:-2,pad=1280:ih+90:0:0:black[base];[base][wav]overlay=0:H-90:shortest=1`
    const capFiles: string[] = []
    if (captions) {
      const saidAt = said ? Math.max(0, (playStartMs - clip.startMs) / 1000) : 0
      const saidFor = said ? Math.max(1.5, (await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', saidWav!]).then((r) => Number(String(r.stdout).trim()) || 3).catch(() => 3))) : 0
      const box = 'box=1:boxcolor=black@0.65:boxborderw=10:fontcolor=white:fontsize=24:x=24'
      const wrap = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 220).replace(/(.{1,80})(\s|$)/g, '$1\n').trim()
      const cap = (name: string, text: string) => { const f = join(RUN_DIR, `_cap-${n}-${name}.txt`); writeFileSync(f, text); capFiles.push(f); return f.replace(/\\/g, '/').replace(/:/g, '\\:') }
      if (said) vchain += `,drawtext=textfile='${cap('said', `TESTER SAID: ${wrap(captions.said)}`)}':${box}:y=24:enable='between(t\\,${saidAt.toFixed(2)}\\,${(saidAt + saidFor).toFixed(2)})'`
      const replyFrom = said ? saidAt + saidFor : 0
      vchain += `,drawtext=textfile='${cap('heard', captions.heard ? `HEARD BACK (transcript): ${wrap(captions.heard)}` : 'NO SPEECH TRANSCRIBED in reply (any sound is still in the audio and waveform)')}':${box}:y=h-90-24-th:enable='gte(t\\,${replyFrom.toFixed(2)})'`
    }
    filters.push(`${vchain}[v]`)
    try {
      await execFileP('ffmpeg', [...args, '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', '-shortest', out])
      for (const f of capFiles) { try { rmSync(f, { force: true }) } catch { /* ignore */ } }
      return existsSync(out) ? { path: out, said, heard } : null
    } catch (e) { mark(`audio mux failed: ${(e as Error).message.slice(0, 100)}`); return null }
    finally { cleanup() }
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

  // ── MULTI-AGENT RESILIENCE (v22) — one engine, many drivers, SAFE ──────────
  // Isolation-by-duplication (a 2nd engine) was a crutch; this makes ONE engine
  // safe for concurrent directors. Each driver is identified by the x-driver-id
  // header (default 'default'). Ownership is DEFAULT-ON, not opt-in: a tab is
  // owned by whoever opened it. An ACTION LOCK serializes bring-to-front + act
  // + capture so two drivers can't interleave in the single Chromium. Each
  // driver acts on ITS OWN tab, never a shared global one — so a foreign
  // /dashboard tab can never bleed into your run again.
  const driverId = (req: import('http').IncomingMessage): string => String(req.headers['x-driver-id'] || 'default')
  const driverActive = new Map<string, Page>()  // driver → its current tab
  let actionChain: Promise<unknown> = Promise.resolve()
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = actionChain.then(fn, fn)
    actionChain = run.then(() => {}, () => {})
    return run as Promise<T>
  }
  // Point the module-level `active` at the driver's tab + bring it to front.
  // Called ONLY under withLock, so mutating shared `active` is safe.
  const focusDriverTab = async (driver: string): Promise<void> => {
    let tab = driverActive.get(driver)
    if (!tab || tab.isClosed()) {
      tab = [...context.pages()].reverse().find((p) => tabOwners.get(p)?.owner === driver) || context.pages()[0]
      driverActive.set(driver, tab)
    }
    active = tab
    await tab.bringToFront().catch(() => {})
    await live?.retarget(tab).catch(() => {})
  }
  // Enforced (not warned): a driver may not act on a tab OWNED BY ANOTHER.
  // SUPERVISOR TAKEOVER — a human (or supervising agent) borrows a driver's
  // tab and hands it back. While borrowed, the original driver's requests get
  // a 409 that says "paused, retry" (not "open your own tab"), and handback
  // restores its ownership so it resumes exactly where the supervisor left it.
  const takeovers = new Map<Page, { by: string; prevOwner: string | null; since: number }>()
  const guardOwnership = (driver: string): Record<string, unknown> | null => {
    const t = driverActive.get(driver) ?? active
    const o = tabOwners.get(t)?.owner
    if (!o || o === driver) return null
    const tk = takeovers.get(t)
    if (tk && tk.prevOwner === driver) return {
      ok: false, code: 'paused_by_supervisor', by: tk.by, since: tk.since, retryAfterSec: 5,
      error: `your tab is temporarily taken over by "${tk.by}" — do NOT open a new tab; retry this same request every ~5s until it succeeds, then re-check the page (the supervisor may have navigated)`,
    }
    return { ok: false, code: 'tab_owned', owner: o, error: `that tab is owned by "${o}" — you are "${driver}"; open your own tab (pass x-driver-id and /tab open)` }
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
  const activeTab = (p: Page = active) => ({ i: context.pages().indexOf(p), url: p.url(), owner: ownerOf(p) })
  const stampTask = (n: number, label: string, startMs: number, clip: string | null, artifact: string | null, text?: string, heard?: string, page: Page = active) => {
    const endMs = Date.now()
    touchTab(page)
    const devtools = devtoolsBufs.get(page)?.summary() ?? null
    const rec = { n, label, text, heard, tab: activeTab(page), startMs, endMs, rel0: Math.max(0, startMs - tCapture), rel1: Math.max(0, endMs - tCapture), clip, artifact, devtools }
    tasks.push(rec); writeManifest(); writeDevtoolsFile(); saveTabState()
    // #120: snapshot journey progress on every task so a restart recovers a
    // journey that points at the work already done (saveJourneyState no-ops
    // when no journey is open).
    saveJourneyState('active')
    notifyRef('task', { task: { n, label, text, heard, tab: rec.tab }, clipUrl: clip ? `/clip?n=${n}` : null, artifactUrl: artifact ? `/artifact?n=${n}` : null })
    return rec
  }

  // (room join + tab restore run in background after server.listen — see below)
  // Self-host auth: when OSBORN_ENGINE_TOKEN is set (always on public
  // deployments — Fly exposes the control port), every request must carry it.
  const TOKEN = process.env.OSBORN_ENGINE_TOKEN
  // PUBLIC EVIDENCE LINKS — proof an agent can actually paste into an issue.
  // /clip and /artifact need the engine token, so a link to them is a 401 for
  // every reader (and for GitHub's image proxy): testers "had" evidence but
  // could not attach it. Each task now also gets signed, token-free URLs
  //   /media/<run>/<n>.jpg | .mp4 | .txt ?s=<signature>
  // that anyone holding the link can open, for as long as the run is kept
  // (newest OSBORN_KEEP_RUNS runs on the volume — they survive restarts). The
  // signature is an HMAC over run+file, so links cannot be guessed or walked.
  const SHARE_SECRET = process.env.OSBORN_SHARE_SECRET || (TOKEN ? createHmac('sha256', TOKEN).update('osborn-share-links').digest('hex') : randomBytes(24).toString('hex'))
  const shareSig = (run: string, file: string) => createHmac('sha256', SHARE_SECRET).update(`${run}/${file}`).digest('hex').slice(0, 24)
  const evidenceFor = (base: string, run: string, n: number, has: { clip?: boolean; shot?: boolean }) => {
    const u = (file: string) => `${base}/media/${run}/${file}?s=${shareSig(run, file)}`
    const screenshot = has.shot ? u(`${n}.jpg`) : null
    const clip = has.clip ? u(`${n}.mp4`) : null
    const log = u(`${n}.txt`)
    return {
      run, task: n, public: true, screenshot, clip, log,
      // Paste-ready: the image renders inline on GitHub, the rest are links.
      markdown: [screenshot ? `![task ${n} screenshot](${screenshot})` : null, clip ? `[task ${n} clip (mp4)](${clip})` : null, `[task ${n} console + network log](${log})`].filter(Boolean).join('\n'),
      note: `public links, no token needed; kept while run ${run} is among the newest ${KEEP_RUNS} runs — GET /evidence?run=${run}&n=${n} re-issues them`,
    }
  }
  const loadRunTasks = (run: string): any[] | null => {
    if (run === RUN_STAMP) return tasks as any[]
    try { return JSON.parse(readFileSync(join(RUNS_ROOT, run.replace(/[^A-Za-z0-9T:-]/g, ''), 'manifest.json'), 'utf8')).tasks ?? [] } catch { return null }
  }
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

  // ── #120: JOURNEY SURVIVES AN ENGINE RESTART ───────────────────────────────
  // `journey` and `RUN_STAMP` are process-memory only. A mid-journey restart
  // (crash / OOM / Fly machine recycle — observed at the Say step, where the
  // edge proxy returns an EMPTY 502 as the dying process drops the connection)
  // starts a fresh process that re-stamps the run id and nulls the journey, so
  // /status reads journey:null and /journey end 400s "no journey in progress".
  // Persist the active journey to a VOLUME-DURABLE file (the same OUT_DIR the
  // tab-state restore already survives sleep on) and ADOPT it on the next boot,
  // keeping run-id continuity (previousRun). Opt out with OSBORN_RECOVER_JOURNEY=0.
  const JOURNEY_STATE = join(OUT_DIR, 'journey-state.json')
  let restoredFromRun: string | null = null
  const saveJourneyState = (status: 'active' | 'ended') => {
    try {
      if (!journey) return
      const pj: PersistedJourney = { name: journey.name, goal: journey.goal, owner: journey.owner, startUrl: journey.startUrl, startedAt: journey.startedAt }
      writeFileSync(JOURNEY_STATE, JSON.stringify(buildJourneyState(RUN_STAMP, status, pj, reqN, tasks.length, Date.now()), null, 2))
    } catch { /* never block the journey on a persistence miss */ }
  }
  if (process.env.OSBORN_RECOVER_JOURNEY !== '0') {
    try {
      const persisted = existsSync(JOURNEY_STATE) ? (JSON.parse(readFileSync(JOURNEY_STATE, 'utf8')) as JourneyStateFile) : null
      const decision = decideRecovery(persisted, { now: Date.now(), currentRun: RUN_STAMP })
      if (decision.recover && decision.journey) {
        // Re-home the step/task counters onto THIS process (the persisted
        // indices belonged to the dead process) and preserve identity + owner
        // (the mission lock survives too). Re-save under the new run id so a
        // SECOND restart chains from here, not from the stale run.
        journey = { name: decision.journey.name, goal: decision.journey.goal, owner: decision.journey.owner, startStep: scenarioSteps.length, startTaskN: reqN, startUrl: decision.journey.startUrl, startedAt: decision.journey.startedAt }
        restoredFromRun = decision.previousRun ?? null
        manifest.previousRun = restoredFromRun
        saveJourneyState('active')
        mark(`journey RECOVERED across restart: "${journey.name}"${restoredFromRun ? ` (previous run ${restoredFromRun})` : ''} — ${decision.reason}`)
        notify('journey_recovered', { name: journey.name, owner: journey.owner ?? null, previousRun: restoredFromRun })
      } else if (persisted && persisted.status === 'active') {
        mark(`journey not recovered — ${decision.reason}`)
      }
    } catch (e) { mark(`journey recovery read failed: ${(e as Error).message.slice(0, 100)}`) }
  }

  // Fetch-nag (v13): clips that were returned but never downloaded — the
  // act-verify gate's teeth. GET /clip marks a task reviewed-able.
  const fetchedClips = new Set<number>()

  // PROCESS DEPTH (v19) — the infra signal for "action vs process". An
  // ACTION is one /act; a PROCESS is exploration that STACKS steps across
  // pages. We track distinct pages visited + action count so a thin,
  // robotic single-navigation is VISIBLE (depth:{pages:1,actions:1}) next to
  // a real exploration (pages:5,actions:12). Surfaced in /status live and
  // saved into each journey so the recipes self-classify action|process.
  const visitedPages = new Set<string>()
  let actionCount = 0
  const noteVisit = () => { try { visitedPages.add(new URL(active.url()).pathname) } catch { /* ignore */ } }
  const depthNow = () => ({ pages: visitedPages.size, actions: actionCount, kind: actionCount <= 1 ? 'action' : 'process', thin: visitedPages.size <= 1 && actionCount <= 1 })
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
    } else if (joinedRoom) {
      // ONLY when a voice room was joined, and ONLY on the room tab (tab 0).
      // This used to run on every shutdown against whatever tab was active, so
      // an idle-stop on a third-party site told the brain to click that site's
      // "Leave"/"Disconnect"-looking button.
      const roomTab = context.pages()[0]
      if (roomTab && !roomTab.isClosed()) active = roomTab
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
      // Media/result URLs in responses are ABSOLUTE when the request came in
      // through the stream-port passthrough (it tells us the public base), so
      // a remote agent can fetch them as-is instead of guessing what a
      // relative "/clip?n=1" is relative to. Direct :8781 callers get the
      // same relative paths as before.
      const mediaBase = String(req.headers['x-control-base'] || '')
      if (req.method === 'GET' && path.startsWith('/media/')) {
        // Signed public evidence — checked BEFORE the token gate on purpose.
        const m = path.match(/^\/media\/([A-Za-z0-9T:-]+)\/(\d+)\.(jpg|mp4|txt)$/)
        const sig = new URL(req.url || '', 'http://x').searchParams.get('s') || ''
        if (!m || sig !== shareSig(m[1], `${m[2]}.${m[3]}`)) return json(res, { error: 'bad or missing evidence signature' }, 403)
        const t = (loadRunTasks(m[1]) ?? []).find((t: any) => t.n === Number(m[2]))
        if (!t) return json(res, { error: `run ${m[1]} task ${m[2]} is no longer stored (runs are pruned to the newest ${KEEP_RUNS})` }, 404)
        if (m[3] === 'txt') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' })
          return res.end(`run ${m[1]} · task ${t.n} · ${t.label}\n${new Date(t.startMs).toISOString()} → ${new Date(t.endMs).toISOString()}\ntab: ${t.tab?.url ?? ''} (owner: ${t.tab?.owner ?? 'none'})\ninstruction/text: ${t.text ?? ''}\n${t.heard ? `heard: ${t.heard}\n` : ''}\n${t.devtools ?? '(no devtools summary recorded)'}\n`)
        }
        const file = m[3] === 'mp4' ? t.clip : t.artifact
        if (!file || !existsSync(file)) return json(res, { error: `no ${m[3]} stored for run ${m[1]} task ${m[2]}` }, 404)
        res.writeHead(200, { 'Content-Type': m[3] === 'mp4' ? 'video/mp4' : 'image/jpeg', 'Content-Length': statSync(file).size, 'Cache-Control': 'public, max-age=86400' })
        createReadStream(file).pipe(res)
        return
      }
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
          // #49: the in-app Browser panel (PR #51 proxy) and any watcher can see
          // whether the auto-joined chat is alive. agentUnreachable is null when
          // reachable, else "agent unreachable: <host>" (or the join error).
          agentUrl: AGENT_URL || null, agentUnreachable,
          brain: brainAlive ? 'ready' : 'dead', brainModel: brainAlive ? brainModel : null, brainError: brainAlive ? null : brainError, stt: sttHealth, useAuth, live: live?.url,
          lastFrameAgeMs: lastFrame ? Date.now() - lastFrame : null,
          taskCount: tasks.length, journey: journey?.name ?? null,
          // #120: previousRun is set when THIS process adopted a journey from a
          // process that died mid-journey; restartRecovered lets a caller tell
          // "engine restarted (journey carried over)" apart from an app failure,
          // and reach the pre-restart media via /clip?run=<previousRun>.
          previousRun: restoredFromRun, restartRecovered: restoredFromRun != null,
          depth: depthNow(),
          takeovers: [...takeovers.entries()].map(([p, t]) => ({ i: context.pages().indexOf(p), by: t.by, prevOwner: t.prevOwner, since: t.since })),
          drivers: [...driverActive.keys()], tabsByOwner: context.pages().map((p,i)=>({i, owner: ownerOf(p)})),
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
        // audio=1: mux the task's ALIGNED audio slice into the (silent) video
        // clip so a remote/cloud director can HEAR the agent, not just see it.
        // Current run only (past runs' recording is gone).
        if (path === '/clip' && q.get('audio') === '1' && !runParam && file) {
          const t3 = tasks.find((t) => t.n === n) as any
          // A spoken-turn clip already carries both sides of the audio, aligned
          // when it was cut — re-muxing it here dropped the tester's track and
          // shifted the page audio by the transcription time. Serve it as is.
          const alreadyAudible = t3?.clipAudio && (t3.clipAudio.said || t3.clipAudio.heard)
          // Otherwise mux from the tab the task ran on, not whichever tab
          // another driver has fronted since.
          const taskPage = context.pages().find((p) => p.url() === t3?.tab?.url && ownerOf(p) === (t3?.tab?.owner ?? null))
          if (t3?.endMs && !alreadyAudible) { const m = await muxClipAudio(file, t3.endMs, n, taskPage ?? active); if (m) file = m }
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
      if (req.method === 'GET' && path === '/audio') {
        // The whole run's captured audio as mp3 (the agent's voice — which is
        // ABSENT from the video-only clips/stream). Room-mode/ears only; on a
        // headless cloud engine this is the only way to hear the agent.
        const a = await peekAudioToWav()
        if (!a) return json(res, { error: 'no audio captured — room-mode ears required (ENTRY=none has none)' }, 404)
        const mp3 = join(RUN_DIR, '_run-audio.mp3')
        try { await execFileP('ffmpeg', ['-y', '-loglevel', 'error', '-i', a.wav, '-c:a', 'libmp3lame', '-q:a', '4', mp3]) }
        catch (e) { return json(res, { error: 'transcode failed: ' + (e as Error).message }, 500) }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': statSync(mp3).size })
        createReadStream(mp3).pipe(res)
        return
      }
      if (req.method === 'GET' && path === '/evidence') {
        // Re-issue the public evidence links for any stored task — today's run
        // or an earlier one — so evidence can be attached long after the action.
        // No n → every task of the run.
        const q = new URL(req.url || '', 'http://x').searchParams
        const run = q.get('run') || RUN_STAMP
        const list = loadRunTasks(run)
        if (!list) return json(res, { ok: false, code: 'no_run', error: `run ${run} is not stored — GET /runs lists runs` }, 404)
        const wanted = q.get('n') ? list.filter((t: any) => t.n === Number(q.get('n'))) : list
        if (!wanted.length) return json(res, { ok: false, code: 'no_task', error: `no task ${q.get('n')} in run ${run}` }, 404)
        return json(res, { ok: true, run, evidence: wanted.map((t: any) => ({ label: t.label, text: t.text ?? null, tab: t.tab ?? null, ...evidenceFor(mediaBase, run, t.n, { clip: !!t.clip, shot: !!t.artifact }) })) })
      }
      if (req.method === 'GET' && path === '/tasks') {
        // This run's task index — same data as manifest.json on disk.
        return json(res, { run: RUN_STAMP, runDir: RUN_DIR, model: 'per-task video; rel0/rel1 are ms on the audio-capture timeline', recordingStartedAt: tCapture, tasks })
      }
      const body = await readBody(req)
      // LONG ACTIONS WITHOUT A HELD-OPEN REQUEST: {"async":true} on /act or
      // /say answers 202 with a job id at once and runs the action in the
      // background; GET /result?id=<job> returns pending or the exact response
      // the synchronous call would have given. Proxies in front of an agent
      // commonly cut requests at ~30s — the action kept running, the caller got
      // a 502, and a blind retry performed it twice.
      if (req.method === 'GET' && path === '/result') {
        const id = new URL(req.url || '', 'http://x').searchParams.get('id') || ''
        const j = jobs.get(id)
        if (!j) return json(res, { ok: false, code: 'no_job', error: `no job "${id}" in this run` }, 404)
        if (!j.done) return json(res, { ok: true, done: false, job: id, path: j.path, runningSec: Math.round((Date.now() - j.startedAt) / 1000) }, 202)
        return json(res, { done: true, job: id, status: j.code, ...(j.body as object) }, 200)
      }
      if (body.async === true && (path === '/act' || path === '/say')) {
        const id = `job-${RUN_STAMP.slice(-8)}-${++jobN}`
        jobs.set(id, { done: false, path, startedAt: Date.now() })
        if (jobs.size > 200) jobs.delete(jobs.keys().next().value as string)
        json(res, { ok: true, async: true, job: id, resultUrl: `${mediaBase}/result?id=${id}` }, 202)
        // Everything below now writes its response into the job record.
        let code = 200
        res = { writeHead: (c: number) => { code = c }, end: (b: string) => { let parsed: unknown = {}; try { parsed = JSON.parse(b) } catch { /* ignore */ } jobs.set(id, { done: true, path, startedAt: jobs.get(id)!.startedAt, code, body: parsed }) }, headersSent: false } as any
      }
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
        const driver = driverId(req)
        // The lock covers the action only; clip, screenshot and record run after it.
        const post = await withLock(async () => {
          await focusDriverTab(driver)  // this driver acts on ITS tab, front + focused
          const page = active
          const owned = guardOwnership(driver)
          if (owned) return json(res, owned, 409)
          if (typeof body.instruction !== 'string' || !body.instruction.trim()) return json(res, { ok: false, code: 'bad_request', error: '/act needs {"instruction": "<what to do>"}' }, 400)
          if (!brainAlive) return json(res, { ok: false, code: 'brain_unavailable', error: brainDownMsg(), driver }, 503)
          const t0 = Date.now()
          await updateTabHud()
          // A model/API failure (quota, 429, 5xx, bad key) is an ANSWER, not a
          // crash: say what the provider said so the director can act on it.
          // GROUND TRUTH AROUND THE ACTION: `ok:true` only ever meant "the brain
          // did not throw". Snapshot the page before and after so the response
          // says what actually changed (url, title, scroll, form/text signature).
          const snap = () => Promise.race([
            active.evaluate(() => {
              const v = [...document.querySelectorAll('input,textarea,select')].slice(0, 200).map((e: any) => `${(e.value || '').length}:${e.checked ? 1 : 0}`).join(',')
              // Scroll position of inner scroll containers too (a page whose
              // window never scrolls can still scroll a panel).
              let inner = 0
              for (const e of Array.from(document.querySelectorAll('*')).slice(0, 4000)) { const t = (e as HTMLElement).scrollTop; if (t) inner += Math.round(t) }
              return {
                url: location.href, title: document.title, scrollY: Math.round((globalThis as any).scrollY || 0), innerScroll: inner,
                // Two signatures, kept apart: `form` (field values + focus) only
                // moves when something acts on the page; `text` (visible text
                // length) also moves by itself on animated pages.
                form: `${v}|${document.activeElement?.tagName || ''}`,
                text: (document.body?.innerText || '').length,
              }
            }),
            new Promise<null>((r) => setTimeout(() => r(null), 3000)),
          ]).catch((e) => { console.log(`[engine] page snapshot failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`); return null }) as Promise<{ url: string; title: string; scrollY: number; innerScroll: number; form: string; text: number } | null>
          // VOLATILITY BASELINE (#146): sample the page twice BEFORE acting. If
          // its text changes with nobody touching it (a live widget, a ticker,
          // a typing animation), text is not evidence of anything and is left
          // out of the comparison. Without this an animated landing page made a
          // scroll that never moved report changed:true, with no warning, and
          // the dead recipe stayed in the action cache.
          const pre = await snap()
          await active.waitForTimeout(350).catch(() => {})
          const before = await snap()
          const textVolatile = !!pre && !!before && pre.text !== before.text
          let r: any
          // PLAIN PAGE SCROLLS ARE DONE BY THE ENGINE, NOT THE BRAIN. On the live
          // landing page the brain's scroll action first moved nothing and, on
          // the identical repeat, scrolled back UP to the top for "scroll down".
          // A scroll with no named target needs no model: it is a mouse-wheel
          // gesture of a known size and direction — exact, instant and free.
          const plainScroll = /^\s*(?:please\s+)?scroll\s+(?:(?:the\s+)?(?:page|window)\s+)?(?:(down|up)|(?:back\s+)?to\s+the\s+(?:very\s+)?(top|bottom|beginning|end|start))(?:\s+(?:of\s+)?(?:the\s+)?(?:page|window))?(?:\s+(?:by\s+)?(?:about\s+|roughly\s+)?(?:(\d+)\s*(?:px|pixels?)|(a|one|two|three|half\s+a)\s+(?:screen|page|viewport)s?|a\s+(?:bit|little)))?\s*\.?\s*$/i.exec(String(body.instruction))
          if (plainScroll) {
            const vp = active.viewportSize() ?? { width: 1280, height: 720 }
            const [, dir, edge, px, screens] = plainScroll
            const size = px ? Number(px) : Math.round(vp.height * 0.9 * (screens ? ({ a: 1, one: 1, two: 2, three: 3 } as Record<string, number>)[screens.toLowerCase()] ?? 0.5 : /bit|little/i.test(plainScroll[0]) ? 0.3 : 1))
            const dy = edge ? (/top|beginning|start/i.test(edge) ? -1e6 : 1e6) : (dir.toLowerCase() === 'up' ? -size : size)
            await active.mouse.move(Math.round(vp.width / 2), Math.round(vp.height / 2)).catch(() => {})
            await active.mouse.wheel(0, dy).catch(() => {})
            r = { cached: false, healed: false, did: `engine mouse-wheel scroll ${edge ? `to the ${edge.toLowerCase()}` : `${dir.toLowerCase()} ${size}px`} (no model call)`, engine: true }
            mark(`act[${driver}]: ${r.did}`)
          } else
          try { r = await brain(body.instruction) }
          catch (e0) {
            let e = e0
            // The provider itself refused (credits ran out, key revoked, rate
            // limit) AFTER boot: re-pick a provider and retry the action once,
            // so a key dying mid-session heals itself instead of failing every
            // /act until someone POSTs /brain.
            const providerDown = /credit|quota|billing|RESOURCE_EXHAUSTED|rate.?limit|api.?key|unauthori|\b(401|402|403|429)\b/i.test(String((e0 as Error).message || e0))
            let healed = false
            if (providerDown) {
              const before = brainModel
              mark(`act[${driver}]: provider refused on ${before} — re-picking a brain provider`)
              try { await stagehand?.close().catch(() => {}) } catch { /* ignore */ }
              await initBrain().catch(() => {})
              if (brainAlive && brainModel !== before) {
                try { r = await brain(body.instruction); healed = true } catch (e1) { e = e1 }
              }
            }
            if (!healed) {
              const msg = ((e as Error).message || String(e)).slice(0, 300)
              mark(`act[${driver}] FAILED: ${msg.slice(0, 90)}`)
              // A failed act is still a task: it must not vanish from the run.
              const fn = ++reqN
              const fshot = await reqShot(fn, 'act')
              stampTask(fn, 'act', t0, null, fshot, body.instruction)
              return json(res, { ok: false, code: brainAlive ? 'brain_error' : 'brain_unavailable', error: `the brain could not act: ${msg}`, driver, brain: brainAlive ? 'ready' : 'dead', brainModel: brainAlive ? brainModel : null, artifact: fshot, artifactUrl: fshot ? `${mediaBase}/artifact?n=${fn}` : null }, brainAlive ? 502 : 503)
            }
          }
          mark(`act[${driver}]: ${String(body.instruction).slice(0, 55)}`)
          // POST-ACTION SETTLE: let the click's EFFECT paint before the clip cut.
          await active.waitForTimeout(body.settleMs ?? 2500).catch(() => {})
          let after = await snap()
          const moved = (a: typeof before, b: typeof before) => !!a && !!b && (a.scrollY !== b.scrollY || a.innerScroll !== b.innerScroll)
          // SCROLL FALLBACK (#146): on some pages the brain's scroll action
          // resolves to an element that does not scroll, and nothing moves. A
          // scroll instruction that moved nothing is retried once as a real
          // mouse-wheel gesture over the viewport, which is what a person does.
          const scrollIntent = /\bscroll/i.test(String(body.instruction))
          let fallback: string | null = null
          if (scrollIntent && !r?.engine && before && after && before.url === after.url && !moved(before, after) && !r?.noop) {
            const ins = String(body.instruction).toLowerCase()
            const vp = active.viewportSize() ?? { width: 1280, height: 720 }
            const dy = /\b(top|beginning|start)\b/.test(ins) ? -1e6 : /\b(bottom|end)\b/.test(ins) ? 1e6 : (/\bup\b/.test(ins) ? -1 : 1) * Math.round(vp.height * 0.9)
            try {
              await active.mouse.move(Math.round(vp.width / 2), Math.round(vp.height / 2))
              await active.mouse.wheel(0, dy)
              await active.waitForTimeout(700)
              const again = await snap()
              if (moved(before, again)) { after = again; fallback = 'mouse-wheel' ; mark(`act[${driver}]: brain scroll moved nothing — mouse-wheel fallback scrolled the page`) }
            } catch { /* keep the original result */ }
          }
          const structural = !!before && !!after && (before.url !== after.url || before.title !== after.title || moved(before, after) || before.form !== after.form)
          const textChanged = !!before && !!after && before.text !== after.text
          const changed = !before || !after ? null
            // A scroll instruction is judged on scroll position (or navigation) alone.
            : scrollIntent ? (before.url !== after.url || moved(before, after))
            : structural || (textChanged && !textVolatile)
          const effect = {
            changed, noop: !!r?.noop, fallback,
            // true when the page's text was already changing on its own before
            // the action, so text was not used as evidence of an effect.
            textVolatile,
            urlBefore: before?.url ?? null, urlAfter: after?.url ?? null,
            titleAfter: after?.title ?? null, scrollBefore: before?.scrollY ?? null, scrollAfter: after?.scrollY ?? null,
          }
          // Nothing observable changed: say so, and never keep the cached
          // recipe for it (a cached no-op was being replayed as a "success").
          let warning: string | null = null
          if (r?.noop) warning = 'the brain found nothing on the page matching this instruction — no action was performed'
          else if (changed === false) {
            warning = scrollIntent
              ? 'the scroll did not move the page or any scrollable panel (also tried a mouse-wheel gesture) — the page may already be at its limit, or the scrollable area is elsewhere; name the panel to scroll'
              : `the action ran but nothing observable changed on the page (url, title, scroll, form values${textVolatile ? '; visible text was ignored because this page animates on its own' : ', text length'}) — verify with /eval or the clip; fine for clipboard/background effects, otherwise rephrase the instruction`
            if (before) forgetCached(before.url, String(body.instruction))
          }
          if (!warning && scrollIntent && before && after && before.url === after.url) {
            const ins = String(body.instruction).toLowerCase()
            const wantDown = /\b(down|bottom|end)\b/.test(ins), wantUp = /\b(up|top|beginning|start)\b/.test(ins)
            const delta = (after.scrollY - before.scrollY) || (after.innerScroll - before.innerScroll)
            if ((wantDown && !wantUp && delta < 0) || (wantUp && !wantDown && delta > 0)) {
              warning = `the page scrolled the OPPOSITE way to the instruction (scroll ${before.scrollY} → ${after.scrollY})`
              forgetCached(before.url, String(body.instruction))
            }
          }
          if (fallback && before) forgetCached(before.url, String(body.instruction))
          if (warning) mark(`act[${driver}] NO VISIBLE EFFECT: ${String(body.instruction).slice(0, 50)}`)
          const prevTask = tasks[tasks.length - 1]
          const nag = prevTask?.clip && !fetchedClips.has(prevTask.n) ? `task ${prevTask.n}'s clip was never fetched — review media before stacking more acts` : null
          actionCount++; noteVisit()
          const n = ++reqN
          return { page, n, t0, r, effect, warning, nag, endMs: Date.now() }
        })
        if (!post) return  // answered inside the lock (refused, invalid, or failed)
        const { page, n, t0, r, effect, warning, nag } = post
        const actFrom = Math.max(t0 - 1500, post.endMs - (body.clipSeconds ?? 45) * 1000)
        const actRange = live?.clipRange ? await live.clipRange(join(RUN_DIR, `req-${String(n).padStart(3, '0')}-act.mp4`), actFrom, post.endMs, page).catch(() => null) : null
        const clip = actRange?.path ?? null
        const clipError = clip ? null : (live ? 'clip failed — too few frames or ffmpeg unavailable' : 'live stream unavailable — no clips this session')
        if (clip) mark(`clip: ${clip}`)
        const shot = await reqShot(n, 'act', page)
        const window = stampTask(n, 'act', t0, clip, shot, body.instruction, undefined, page)
        scenarioSteps.push({ kind: 'act', value: String(body.instruction) }); writeScenario()
        return json(res, { ok: true, result: r, effect, warning, evidence: evidenceFor(mediaBase, RUN_STAMP, n, { clip: !!clip, shot: !!shot }), brainModel, clip, clipError, artifact: shot, clipUrl: `${mediaBase}/clip?n=${n}`, audioClipUrl: `${mediaBase}/clip?n=${n}&audio=1`, artifactUrl: shot ? `${mediaBase}/artifact?n=${n}` : null, nag, driver, window })
      }
      if (path === '/say') {
        const driver = driverId(req)
        // The lock covers speaking only; listening, clip and transcript run after it.
        const spoken = await withLock(async () => {
          await focusDriverTab(driver)
          const page = active
          const ownedSay = guardOwnership(driver)
          if (ownedSay) return json(res, ownedSay, 409)
          if (typeof body.text !== 'string' || !body.text.trim()) return json(res, { ok: false, code: 'bad_request', error: '/say needs {"text": "<what to speak>"}' }, 400)
          const t0 = Date.now(); await updateTabHud()
          // ERROR PARITY (#102): /say is a drive action and must surface WHY it
          // failed — like /hear and /eval do — instead of throwing into the
          // generic 500 and showing the panel a reasonless error. The common
          // failure on a non-room page is the mic precondition (the tab never
          // opened a getUserMedia mic); name it and still stamp a (failed) task
          // so a Say attempt never vanishes from "This run's tasks".
          // #120: BOUNDED RETRY on a TRANSIENT speak failure. A one-shot throw
          // used to degrade straight to a structured 502; a momentary mic/
          // LiveKit hiccup is worth one or two in-process retries. A mic
          // PRECONDITION failure is NOT retried — it will not fix itself (the
          // tab never opened a getUserMedia mic). (A full process death can't be
          // retried here; the caller's re-attach — see drive.sh — covers that.)
          const ears = await ensureEars(active)
          const saidWav = join(RUN_DIR, `said-${Date.now()}.wav`)
          let playStartMs = 0
          const MAX_SAY_ATTEMPTS = Math.max(1, Number(process.env.OSBORN_SAY_RETRIES ?? 2))
          let sayErr: Error | null = null
          for (let attempt = 1; attempt <= MAX_SAY_ATTEMPTS; attempt++) {
            try { await speakText(active, body.text, { keepWav: saidWav, onPlayStart: () => { playStartMs = Date.now() } }); sayErr = null; break }
            catch (e) {
              sayErr = e as Error
              const m = sayErr.message || ''
              if (/mic/i.test(m)) break
              if (attempt < MAX_SAY_ATTEMPTS) {
                mark(`say[${driver}] transient fail (attempt ${attempt}/${MAX_SAY_ATTEMPTS}): ${m.slice(0, 60)} — retrying`)
                await active.waitForTimeout(retryDelayMs(attempt)).catch(() => {})
              }
            }
          }
          if (sayErr) {
            const msg = sayErr.message || 'speak failed'
            const noMic = /mic/i.test(msg)
            mark(`say[${driver}] FAILED after ${MAX_SAY_ATTEMPTS} attempt(s): ${msg.slice(0, 80)}`)
            try { rmSync(saidWav, { force: true }) } catch { /* ignore */ }
            const fn = ++reqN
            const fshot = await reqShot(fn, 'say')
            stampTask(fn, 'say', t0, null, fshot, body.text)
            return json(res, {
              ok: false,
              code: noMic ? 'no_mic' : 'speak_failed',
              error: noMic
                ? `this page has no open microphone — Say needs a Voice Native /chat tab (open one first). (${msg})`
                : `could not speak: ${msg}`,
              artifact: fshot, artifactUrl: fshot ? `${mediaBase}/artifact?n=${fn}` : null, driver,
            }, noMic ? 422 : 502)
          }
          mark(`say[${driver}]: ${String(body.text).slice(0, 50)}`)
          return { page, t0, ears, saidWav, playStartMs }
        })
        if (!spoken) return  // answered inside the lock (refused, invalid, or no mic)
        const { page, t0, ears, saidWav, playStartMs } = spoken
        {
          await page.waitForTimeout(body.listenMs ?? 6000).catch(() => {})
          const n = ++reqN
          // Cut the clip NOW — speak start to end of the listen window — before
          // the (slow) transcription, so the spoken moment is always in it. It
          // used to be "the last 30s", which for a long turn showed only the tail.
          let clip: string | null = null; let clipError: string | null = null
          let audio: { said: boolean; heard: boolean } = { said: false, heard: false }
          const range = live?.clipRange ? await live.clipRange(join(RUN_DIR, `req-${String(n).padStart(3, '0')}-say.mp4`), t0 - 1000, Date.now(), page).catch(() => null) : null
          let hearError: string | null = null
          const heard = await hearSince(page, Math.max(0, t0 - (ears.startedAt ?? tCapture))).catch((e) => { hearError = (e as Error).message.slice(0, 160); return '' })
          if (!range) clipError = live ? 'clip failed — too few frames or ffmpeg unavailable' : 'live stream unavailable — no clips this session'
          else {
            clip = range.path
            const av = await muxSayAudio(range, saidWav, playStartMs, n, page, { said: String(body.text), heard })
            if (av) { clip = av.path; audio = { said: av.said, heard: av.heard } }
            mark(`clip: ${clip}${av ? ' (with audio)' : ' (silent — no audio available)'}`)
          }
          try { rmSync(saidWav, { force: true }) } catch { /* ignore */ }
          const earsAfter = await earsState(page)
          const sayWarning = heard ? null
            : hearError ? `nothing transcribed: ${hearError}`
            : !(optionalEnvKey('SONIOX_API_KEY') || optionalEnvKey('DEEPGRAM_API_KEY') || optionalEnvKey('OPENAI_API_KEY')) ? 'nothing transcribed: the engine has no speech-to-text key (SONIOX_API_KEY / DEEPGRAM_API_KEY) — listen to the clip instead'
            : earsAfter.audioElements === 0 ? 'nothing was heard, and the page has no audio/video element — no agent audio track is attached (the agent is probably not connected or not speaking)'
            : earsAfter.playing === 0 ? 'nothing was heard: the page has audio elements but none is playing'
            : ears.armedNow ? 'nothing was heard; the ears were armed on this tab just before speaking, so audio that started earlier was not captured'
            : 'nothing was heard in the listen window — raise listenMs if the reply comes late'
          const shot = await reqShot(n, 'say', page)
          const window = stampTask(n, 'say', t0, clip, shot, body.text, heard, page)
          ;(window as any).clipAudio = audio; writeManifest()
          scenarioSteps.push({ kind: 'say', value: String(body.text) }); writeScenario()
          return json(res, { ok: true, heardAnything: !!heard, warning: sayWarning, ears: { ...earsAfter, armedNow: ears.armedNow }, clipAudio: audio, evidence: evidenceFor(mediaBase, RUN_STAMP, n, { clip: !!clip, shot: !!shot }), clip, clipError, artifact: shot, clipUrl: `${mediaBase}/clip?n=${n}`, audioClipUrl: `${mediaBase}/clip?n=${n}&audio=1`, artifactUrl: shot ? `${mediaBase}/artifact?n=${n}` : null, heard, driver, window })
        }
      }
      if (path === '/hear') {
        // Errors surface — a silent catch here hid the timeline-skew bug for a day.
        // The CALLER's tab, not whichever tab another driver fronted last.
        const hearTab = driverActive.get(driverId(req)); const hearPage = hearTab && !hearTab.isClosed() ? hearTab : active
        const hearEars = await ensureEars(hearPage)
        if (hearEars.armedNow) return json(res, { heard: '', ears: hearEars, warning: 'the ears were not armed on this tab until this call, so nothing earlier was recorded — have the page play audio again (or /say), then call /hear' })
        const since = Date.now() - (hearEars.startedAt ?? tCapture) - (body.lastMs ?? 20000)
        try { const heard = await hearSince(hearPage, Math.max(0, since)); return json(res, { heard, ears: hearEars, warning: heard ? null : (hearEars.playing === 0 ? 'nothing heard: no audio element on the page is playing' : null) }) }
        catch (e) { mark(`hear failed: ${(e as Error).message}`); return json(res, { heard: '', error: (e as Error).message }) }
      }
      if (path === '/shot') { const driver = driverId(req); return await withLock(async () => { await focusDriverTab(driver); const b = await active.screenshot({ type: 'jpeg', quality: 60 }); return json(res, { jpegB64: b.toString('base64'), driver }) }) }
      if (path === '/eval') {
        const driver = driverId(req)
        return await withLock(async () => {
        await focusDriverTab(driver)
        const owned = guardOwnership(driver)
        if (owned) return json(res, owned, 409)
        if (typeof body.expression !== 'string' || !body.expression.trim()) return json(res, { ok: false, code: 'bad_request', error: '/eval needs {"expression": "<js>"}' }, 400)
        try {
          const value = await Promise.race([
            active.evaluate((expr: string) => { const r = (0, eval)(expr); return typeof r === 'object' ? JSON.stringify(r)?.slice(0, 4000) : String(r) }, String(body.expression)),
            new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout (10s)')), 10000)),
          ])
          mark(`eval[${driver}]: ${String(body.expression).slice(0, 45)}`)
          touchTab(active)
          // Evals are journey steps too — the cloud meeting run saved a
          // 0-step recipe because it was driven entirely via /eval.
          scenarioSteps.push({ kind: 'eval', value: String(body.expression).slice(0, 140) }); writeScenario()
          return json(res, { ok: true, value, driver })
        } catch (e) { return json(res, { ok: false, error: (e as Error).message }) }
        })
      }
      if (path === '/tab') {
        // open | switch | close | claim | release | list. RESILIENCE (v22):
        // the OWNER defaults to the calling driver (x-driver-id) — opening a
        // tab auto-owns it for you and makes it your active tab, so drivers
        // don't fight over one global active. `owner` in the body still works
        // as an explicit override.
        const driver = driverId(req)
        if (body.owner == null) body.owner = driver
        const TAB_OPS = ['open', 'navigate', 'switch', 'close', 'claim', 'release', 'takeover', 'handback', 'list']
        if (!TAB_OPS.includes(body.op)) return json(res, { ok: false, code: 'bad_request', error: `/tab op must be one of ${TAB_OPS.join(' | ')}` }, 400)
        if (['switch', 'close', 'claim', 'release', 'takeover', 'handback'].includes(body.op) && !context.pages()[body.i])
          return json(res, { ok: false, code: 'no_tab', error: `no tab ${body.i} — ${context.pages().length} tab(s) open (0-based); /tab {"op":"list"} shows them` }, 404)
        // Serialized with /act and /say: a /tab landing mid-action used to swap
        // the shared `active` under it, so the action's screenshot, clip and
        // task record described ANOTHER driver's tab.
        return await withLock(async () => {
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
          driverActive.set(driver, active)  // this becomes the driver's active tab
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
        else if (body.op === 'switch') {
          const so = ownerOf(context.pages()[body.i])
          if (so && so !== body.owner) return json(res, { error: `tab ${body.i} is owned by "${so}" — you are "${body.owner}"` }, 409)
          active = await switchTab(context, body.i); driverActive.set(driver, active); touchTab(active); await live?.retarget(active).catch(() => {}); mark(`tab switch: ${body.i}`)
        }
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
        else if (body.op === 'release') {
          // Only the owner may release. (It used to be open to anyone, which
          // made "release then claim" a silent way to steal a tab — use
          // takeover/handback for that, which the owner is told about.)
          const target = context.pages()[body.i]
          const o = ownerOf(target)
          if (o && o !== body.owner) return json(res, { ok: false, code: 'tab_owned', owner: o, error: `tab ${body.i} is owned by "${o}" — only its owner can release it; use {"op":"takeover"} to borrow it` }, 409)
          tabOwners.delete(target); takeovers.delete(target); mark(`tab release: ${body.i}`)
        }
        else if (body.op === 'takeover') {
          const target = context.pages()[body.i]
          const prev = ownerOf(target)
          if (takeovers.has(target)) return json(res, { ok: false, code: 'already_taken_over', by: takeovers.get(target)!.by, error: `tab ${body.i} is already taken over by "${takeovers.get(target)!.by}"` }, 409)
          if (prev === body.owner) return json(res, { ok: false, code: 'bad_request', error: `tab ${body.i} is already yours` }, 400)
          takeovers.set(target, { by: String(body.owner), prevOwner: prev, since: Date.now() })
          tabOwners.set(target, { owner: String(body.owner), claimedAt: Date.now() })
          active = target; driverActive.set(driver, target); touchTab(target)
          await target.bringToFront().catch(() => {}); await live?.retarget(target).catch(() => {})
          mark(`tab TAKEOVER: ${body.i} by ${body.owner}${prev ? ` (from ${prev})` : ''}`)
          notify('takeover', { i: body.i, by: body.owner, prevOwner: prev })
        }
        else if (body.op === 'handback') {
          const target = context.pages()[body.i]
          const tk = takeovers.get(target)
          if (!tk) return json(res, { ok: false, code: 'not_taken_over', error: `tab ${body.i} is not under a takeover` }, 400)
          if (tk.by !== body.owner) return json(res, { ok: false, code: 'tab_owned', owner: tk.by, error: `tab ${body.i} was taken over by "${tk.by}" — only they can hand it back` }, 409)
          takeovers.delete(target)
          if (tk.prevOwner) tabOwners.set(target, { owner: tk.prevOwner, claimedAt: Date.now() }); else tabOwners.delete(target)
          driverActive.delete(driver)
          mark(`tab HANDBACK: ${body.i} by ${body.owner}${tk.prevOwner ? ` → ${tk.prevOwner}` : ''}`)
          notify('handback', { i: body.i, by: body.owner, owner: tk.prevOwner, url: target.url() })
        }
        // Tab ops are journey steps too — a recipe missing "open the mobile
        // tab" is not a recipe (first saved journey had steps:1 for this).
        if (['open', 'switch', 'close', 'navigate'].includes(body.op)) {
          scenarioSteps.push({ kind: 'tab', value: `${body.op}${body.url ? ' ' + body.url : ''}${body.viewport ? ' viewport=mobile' : ''}${body.i != null ? ' i=' + body.i : ''}` })
          writeScenario()
        }
        await updateTabHud(); saveTabState()
        notify('tab', { op: body.op, activeTab: activeTab(), tabCount: context.pages().length })
        return json(res, { ok: true, activeTab: activeTab(), tabs: listTabs(context).map((t) => ({ i: t.index, url: t.url, owner: ownerOf(context.pages()[t.index]) })) })
        })
      }
      if (path === '/journey') {
        const host = (() => { try { return new URL(active.url()).hostname } catch { return 'unknown' } })()
        if (body.op === 'start') {
          if (journey && journey.owner && body.owner !== journey.owner) return json(res, { error: `mission "${journey.name}" is active (owner: ${journey.owner}) — coordinate or wait for journey end`, mission: { name: journey.name, owner: journey.owner, startedAt: journey.startedAt } }, 409)
          journey = { name: String(body.name || 'unnamed'), goal: body.goal, owner: body.owner ? String(body.owner) : undefined, startStep: scenarioSteps.length, startTaskN: reqN, startUrl: active.url(), startedAt: Date.now() }
          saveJourneyState('active')  // #120: durable from the first moment
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
          const depth = depthNow()
          mark(`journey end: ${journey.name} (${steps.length} step(s), ${depth.kind}, ${depth.pages} page(s)${saved ? ', saved' : ''}${depth.thin ? ' — THIN: single navigation, not exploration' : ''})`)
          const done = { ok: true, name: journey.name, steps: steps.length, depth, saved, tasks: [journey.startTaskN + 1, reqN] }
          notify('journey_end', { name: journey.name, goal: journey.goal ?? null, steps: steps.length, depth, saved: !!saved })
          saveJourneyState('ended')  // #120: mark ended BEFORE null so a later boot won't resurrect it
          journey = null
          return json(res, done)
        }
        if (body.op === 'list') return json(res, { site: host, journeys: listJourneys(host) })
        return json(res, { error: 'op must be start | end | list' }, 400)
      }
      if (path === '/brain') {
        // Recover a detached Stagehand without restarting the whole engine.
        try { await stagehand?.close().catch(() => {}) } catch { /* ignore */ }
        try { await initBrain() }
        catch { mark(`brain re-init failed — ${brainError}`); return json(res, { ok: false, brain: 'dead', code: 'brain_unavailable', error: brainDownMsg() }, 503) }
        mark('brain re-initialized')
        await probeStt()
        return json(res, { ok: true, brain: 'ready', brainModel, stt: sttHealth })
      }
      if (path === '/recover') {
        // Under the action lock, on the CALLER's tab: it used to reload the
        // global active tab — i.e. whatever another driver fronted last, even
        // mid-/act — so one driver's recover could wipe another's page.
        const driver = driverId(req)
        return await withLock(async () => {
          await focusDriverTab(driver)
          const owned = guardOwnership(driver)
          if (owned) return json(res, owned, 409)
          await active.reload({ timeout: 45000 }).catch(() => {})
          await active.waitForTimeout(4000)
          const shot = join(RUN_DIR, `recover-${Date.now()}.jpg`)
          await active.screenshot({ path: shot, type: 'jpeg', quality: 60 }).catch(() => {})
          mark(`recovered[${driver}] (page reloaded)`)
          return json(res, { ok: true, artifact: shot, brain: brainAlive ? 'ready' : 'dead', driver, activeTab: activeTab() })
        })
      }
      if (path === '/end') {
        json(res, { ok: true, msg: 'shutting down' })
        void gracefulEnd('end requested')
        return
      }
      json(res, { error: 'unknown', paths: ['/evidence?run=RUN&n=N', '/media/RUN/N.jpg|mp4|txt?s=SIG', '/result?id=JOB', '/status', '/tasks', '/clip?n=N', '/clip?n=N&audio=1', '/artifact?n=N', '/audio', '/logs', '/runs', '/events', '/act', '/say', '/hear', '/shot', '/eval', '/tab', '/journey', '/brain', '/recover', '/end'] }, 404)
    } catch (e) { json(res, { error: (e as Error).message, brain: brainAlive ? 'ready' : 'dead' }, 500) }
  })
  server.listen(CONTROL_PORT, () => console.log(`[engine] control API on http://127.0.0.1:${CONTROL_PORT}  (live: ${live?.url})${TOKEN ? '  [token-protected]' : ''}`))

  // BOOT-TIME AGENT REACHABILITY PROBE (#49). The auto-joined chat only works
  // if the configured agent machine actually answers. A stale/empty
  // OSBORN_AGENT_URL (the old hardcoded default host left DNS when its machine
  // was retired) must NOT send the join flow spinning on "Connecting…" forever.
  // Probe /health once, bounded: if the host doesn't resolve/answer, report it
  // (the join is skipped). A reachable-but-not-yet-in-room agent is NOT a
  // failure — the normal join flow (connect-room) seats it.
  const probeAgent = async (): Promise<string | null> => {
    if (!AGENT_URL) return 'no agentUrl configured — set OSBORN_AGENT_URL to auto-join a chat'
    let host = AGENT_URL
    try { host = new URL(AGENT_URL).host } catch { /* keep raw */ }
    try {
      const r = await fetch(`${AGENT_URL}/health`, { signal: AbortSignal.timeout(6000) })
      if (!r.ok) return `agent unreachable: ${host} (/health ${r.status})`
      await r.json().catch(() => ({}))  // reachability is what matters here, not shape
      return null
    } catch { return `agent unreachable: ${host}` }
  }

  // BACKGROUND ROOM JOIN + tab restore — the engine is already fully
  // drivable (/status /shot /act /recover /eval) while this runs or wedges.
  void (async () => {
    // No reachable agent → open a neutral page (no room) so the browser tool
    // stays usable for plain browsing/testing, and say WHY on /status + the
    // live view instead of spinning on "Connecting…".
    const openNeutral = async (reason: string) => {
      try { await active.goto(APP_URL, { timeout: 60000 }) } catch (e) { mark(`neutral page goto failed: ${(e as Error).message.slice(0, 80)}`) }
      roomReady = true
      live?.setNotice(`${reason} — opened ${APP_URL} for plain browsing; set OSBORN_AGENT_URL to a reachable agent to auto-join a chat`)
      mark(`no room join — ${reason}; ${APP_URL} open for browsing`)
      notify('agent_unreachable', { agentUrl: AGENT_URL || null, reason })
    }
    // GENERIC ENTRY (open-source posture): OSBORN_ENTRY=none skips the
    // voice-native room flow entirely — just load APP_URL and be a browser.
    // Point the engine at ANY site: OSBORN_APP_URL=https://any.site OSBORN_ENTRY=none.
    if (process.env.OSBORN_ENTRY === 'none') {
      try { await active.goto(APP_URL, { timeout: 60000 }) } catch (e) { mark(`entry goto failed: ${(e as Error).message.slice(0, 80)}`) }
      roomReady = true
      mark(`entry: none — ${APP_URL} loaded, no room flow`)
      notify('room_ready', { entry: 'none' })
    } else {
      // #49: reachability gate BEFORE the join flow — never spin on a dead host.
      agentUnreachable = await probeAgent()
      if (agentUnreachable) {
        await openNeutral(agentUnreachable)
      } else try {
        const { captureStartedAt } = await enterFreshRoom(active, brain, useAuth ? chatUrl : url, { earsOn: true, agentUrl: AGENT_URL })
        await ensureSessionLive(active, brain, chatUrl, { agentUrl: AGENT_URL })
        tCapture = captureStartedAt ?? Date.now()
        roomReady = true; joinedRoom = true
        live?.setNotice(null)
        mark('in room — awaiting direction')
        notify('room_ready', {})
      } catch (e) {
        // The join flow still failed (agent died mid-flow, gate wedge, …).
        // Surface it the same way so passive stream viewers see WHY; the engine
        // stays drivable (/recover, /act) instead of a silent spinner.
        agentUnreachable = `room join failed: ${(e as Error).message.slice(0, 120)}`
        live?.setNotice(`agent chat failed to join — ${(e as Error).message.slice(0, 120)}`)
        mark(`room join FAILED: ${(e as Error).message.slice(0, 120)} — engine still drivable; use /recover or /act to steer`)
        notify('room_join_failed', { error: (e as Error).message.slice(0, 200) })
      }
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
