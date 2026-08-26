// Load environment variables FIRST before any other imports
import 'dotenv/config'

import { voice, initializeLogger, type Agent } from '@livekit/agents'
import { CloudTurnDetector } from './turn-detector-shim.js'
import {
  Room, RoomEvent, RemoteParticipant, LocalParticipant,
} from '@livekit/rtc-node'
import { AccessToken } from 'livekit-server-sdk'

// Initialize logger before anything else
initializeLogger({ pretty: true, level: 'info' })

// Prevent MaxListenersExceededWarning on AbortSignal from Claude SDK query() calls
// Each resumed query() adds listeners to the shared signal; default limit is 10
import { setMaxListeners } from 'node:events'
setMaxListeners(50)

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'http'
import { WebSocket, WebSocketServer } from 'ws'
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, cpSync, rmSync, renameSync, statSync, utimesSync, createWriteStream, openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomUUID, randomBytes } from 'node:crypto'
import httpProxy from 'http-proxy'
import { createRequire } from 'node:module'

// 0.9.71: createRequire for resolving package.json versions inside ESM
const __sdkVersionRequire = createRequire(import.meta.url)
import { homedir, tmpdir, totalmem, freemem } from 'node:os'
import { PassThrough } from 'node:stream'
import { createGunzip } from 'node:zlib'

// Resolve __dirname for this ESM module so we can find sibling files (e.g.
// meeting-output.html) relative to the compiled JS location, NOT process.cwd().
// In production cwd is the user's workspace; the static file lives next to dist/index.js.
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
import { createPatch } from 'diff'
import { loadConfig, getMcpServers, getEnabledMcpServerNames, getVoiceMode, getRealtimeConfig, getDirectConfig, listSessions, listAllClaudeSessions, getMostRecentSessionId, sessionExists, cleanupOrphanedMetadata, getSessionSummary, getConversationHistory, ensureSessionWorkspace, getSessionWorkspace, getMcpServerStatusList, buildMcpServersForKeys, listWorkspaceArtifacts, listLibraryFiles, type VoiceMode, type SessionInfo, type SessionSummary, type ConversationExchange } from './config.js'
import { createSTT, createTTS, createRealtimeModelFromConfig, DIRECT_MODE_STT, DIRECT_MODE_TTS } from './voice-io.js'
import { createClaudeLLM, NAMED_AGENTS } from './claude-llm.js'
import { clearPipelineFastBrainSession, prewarmBM25Index } from './pipeline-fastbrain.js'
import { ensureClaudeAuth } from './claude-auth.js'
import { createSmitheryProxy, destroySmitheryProxy, parseSmitheryUrl, isSmitheryUrl, SmitheryAuthorizationError } from './smithery-proxy.js'
import { askHaiku, askFastBrain, updateSpecFromJSONL, processResearchCompletion, handleResearchBatch, prepareBriefingScript, prepareRecoveryScript, writeQuestionToSpec, checkOutputAgainstQuestions, generateProactivePrompt, clearFastBrainSession, type ConversationTurn, type FastBrainCallbacks } from './fast-brain.js'
import { DIRECT_MODE_PROMPT, getRealtimeInstructions, getScriptInjection, getProactiveInjection, getNotificationInjection, getResearchCompleteInjection, getResearchUpdateInjection } from './prompts.js'
import { MCP_CATALOG } from './config.js'
import { getRecallClient } from './recall-client.js'
import { MeetingTranscriptPoller } from './meeting-transcript-poller.js'
import { llm } from '@livekit/agents'
import { z } from 'zod'

// ============================================================
// DUAL MODE VOICE ARCHITECTURE
// ============================================================
// DIRECT MODE (default): STT → Claude Agent SDK → TTS
//   - Full coding capabilities via Claude Agent SDK
//   - Permission system flows to frontend
//   - Best for actual coding tasks
//
// REALTIME MODE: OpenAI/Gemini native speech-to-speech
//   - Faster response, lower latency
//   - Voice LLM with tool calling (ask_agent, respond_permission)
//   - Routes tasks to Claude agents for execution
// ============================================================

// Build an enriched tool-use event for the frontend Logs drawer so it can
// render Claude-style review cards (Read/Edited/Ran with file names, +/- line
// counts, and an expandable diff) instead of a bare tool name. Best-effort:
// any field that can't be derived is simply omitted and the card degrades to
// the tool name. `input` is the raw tool arguments already carried on the
// tool_use/tool_result events emitted by claude-llm.
function buildToolLogEvent(
  name: string,
  input: any,
  status: 'running' | 'completed',
  agentRole: string,
): Record<string, any> {
  const ev: Record<string, any> = { type: 'tool_use', tool: name, status, agentRole }
  const inp = input || {}
  const basename = (p: string) => String(p).split('/').pop() || String(p)

  const fp = inp.file_path || inp.path || inp.notebook_path
  if (fp) { ev.filePath = fp; ev.fileName = basename(fp) }
  if (typeof inp.command === 'string') ev.command = inp.command
  if (typeof inp.pattern === 'string') ev.pattern = inp.pattern
  if (typeof inp.url === 'string') ev.url = inp.url
  if (typeof inp.description === 'string') ev.description = inp.description

  try {
    if (name === 'Edit' && typeof inp.old_string === 'string' && typeof inp.new_string === 'string') {
      ev.linesRemoved = inp.old_string ? inp.old_string.split('\n').length : 0
      ev.linesAdded = inp.new_string ? inp.new_string.split('\n').length : 0
      ev.diff = createPatch(ev.fileName || 'edit', inp.old_string, inp.new_string, '', '', { context: 2 })
    } else if (name === 'MultiEdit' && Array.isArray(inp.edits)) {
      let a = 0, r = 0
      const chunks: string[] = []
      for (const e of inp.edits) {
        const o = String(e?.old_string ?? ''), n = String(e?.new_string ?? '')
        r += o ? o.split('\n').length : 0
        a += n ? n.split('\n').length : 0
        chunks.push(createPatch(ev.fileName || 'edit', o, n, '', '', { context: 2 }))
      }
      ev.editCount = inp.edits.length
      ev.linesRemoved = r
      ev.linesAdded = a
      ev.diff = chunks.join('\n')
    } else if (name === 'Write' && typeof inp.content === 'string') {
      ev.linesAdded = inp.content.split('\n').length
      ev.linesRemoved = 0
      ev.diff = inp.content.split('\n').slice(0, 60).map((l: string) => '+' + l).join('\n')
    }
  } catch { /* diff is best-effort — omit on any failure */ }

  return ev
}

// Load skills list with name + description for frontend display
function loadSkillsList(agentDir: string): { name: string; description: string; folder: string }[] {
  const skillsDir = join(agentDir, '.claude', 'skills')
  if (!existsSync(skillsDir)) return []
  const skills: { name: string; description: string; folder: string }[] = []
  try {
    for (const skillName of readdirSync(skillsDir)) {
      const skillFile = join(skillsDir, skillName, 'SKILL.md')
      if (existsSync(skillFile)) {
        const content = readFileSync(skillFile, 'utf-8')
        // Extract title from first # heading, or use folder name
        const titleMatch = content.match(/^#\s+(?:Skill:\s*)?(.+)/m)
        const name = titleMatch ? titleMatch[1].trim() : skillName
        // Extract description from first paragraph after heading
        const descMatch = content.match(/^#[^\n]+\n+([^\n#]+)/m)
        const description = descMatch ? descMatch[1].trim() : ''
        skills.push({ name, description, folder: skillName })
      }
    }
  } catch (err) {
    console.warn('⚠️ Failed to load skills list:', err)
  }
  return skills
}

// Generate a short, user-friendly room code
function generateRoomCode(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

// Parse CLI arguments
function parseArgs(): { roomCode?: string } {
  const args = process.argv.slice(2)
  let roomCode: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--room' && args[i + 1]) {
      roomCode = args[i + 1]
    }
    // Short code detection (e.g., `npm run dev abc123`)
    if (!args[i].startsWith('-') && args[i].length >= 4 && args[i].length <= 10 &&
        !['dev', 'start'].includes(args[i])) {
      roomCode = args[i]
    }
  }

  return { roomCode }
}

// Global error handlers
process.on('unhandledRejection', (reason: any) => {
  const msg = reason?.message || String(reason)
  if (msg.includes('aborted') || msg.includes('AbortError')) {
    console.log('⚠️ LLM request aborted (user interrupted)')
    return
  }
  // Gemini plugin intentionally supersedes generate_reply calls — safe to suppress
  if (msg.includes('Superseded')) {
    console.log('⚠️ generateReply superseded (expected during concurrent injections)')
    return
  }
  // OpenAI race: voice queue fired while server-side VAD already created a response
  if (msg.includes('conversation_already_has_active_response') || msg.includes('active_response')) {
    console.log('⚠️ OpenAI active response collision (will retry on next listening state)')
    return
  }
  // LiveKit SDK internal error after participant disconnect — safe to suppress
  if (msg.includes("reading 'source'") || msg.includes("reading 'type'")) {
    console.log('⚠️ Post-disconnect cleanup error (harmless)')
    return
  }
  // generateReply timeout — realtime LLM called a tool instead of speaking (toolChoice:'none' ignored)
  // or Superseded — new generateReply cancelled a pending one
  if (msg.includes('generateReply timed out') || msg.includes('generation_created') || msg.includes('Superseded')) {
    console.log('⚠️ generateReply failed:', msg.substring(0, 80))
    return
  }
  // AdaptiveInterruptionDetector crash — LiveKit Cloud returns string instead of JSON.
  // SDK handles this internally (retries → VAD fallback). Suppress residual noise.
  if (msg.includes('interruption prediction') || msg.includes('AdaptiveInterruptionDetector')) {
    return
  }
  console.error('❌ Unhandled Rejection:', msg)
})

process.on('uncaughtException', (error) => {
  if (error.message?.includes('aborted') || error.message?.includes('AbortError')) {
    console.log('⚠️ Operation aborted')
    return
  }
  console.error('❌ Uncaught Exception:', error)
})

// ============================================================
// HTTP API SERVER - Exposes session data to cloud-deployed frontend
// ============================================================

// Module-level room code so the HTTP server can expose it via GET /room-code
let currentRoomCode: string | null = null

// Module-level LiveKit connection state. Shared between main() (which runs the
// connect-with-retry loop) and the /health handler in startApiServer (which
// reports it to the frontend so the user sees a meaningful error instead of a
// dashboard redirect when LiveKit is unreachable / out of quota / etc).
//
// We deliberately do NOT 503 /health on connect failure — Fly's machine
// health-check uses /health, and returning non-2xx triggers a restart loop
// which (a) burns the same failing LiveKit calls every 30s and (b) gets the
// machine killed after 3 failed restarts. By staying 200 OK and surfacing the
// status as a field, we keep the container alive long enough for LiveKit to
// recover (auto-retry) or for the user to read the error and upgrade quota.
const livekitState: {
  status: 'connecting' | 'connected' | 'failed' | 'retrying' | 'idle'
  error: string | null
  errorCode: string | null  // best-effort categorization ('quota_exceeded', 'auth', 'network')
  lastAttemptAt: number | null
  attemptCount: number
} = {
  status: 'connecting',
  error: null,
  errorCode: null,
  lastAttemptAt: null,
  attemptCount: 0,
}

// ── Room-presence lifecycle (2026-06-09) ──────────────────────────────────────
// The agent used to eager-connect to LiveKit on boot and hold the room for the
// machine's entire life. With 1 participant (the agent itself), LiveKit never
// considers the room empty, so it never closes — a single forgotten session
// burned 25h of connection-minutes (room osborn-jzs94j) before we caught it.
//
// Fix: the agent now LEAVES the LiveKit room when no user is present, and only
// rejoins when a user actually connects. Two triggers, both feeding room.disconnect():
//   1. Agent-side "alone" timer — armed in ParticipantDisconnected once a real
//      session has ended; if no user rejoins within ALONE_GRACE_MS, the agent
//      leaves on its own. This is tab-close-proof (does not depend on the
//      frontend's JS still running — the exact gap that let the 25h room linger).
//   2. POST /leave-room — the frontend's explicit "leave" button leaves instantly.
// Rejoin happens via POST /connect-room (frontend connect flow) which re-runs the
// connect-with-retry loop.
//
// `intentionalLeave` distinguishes a voluntary leave from an involuntary LiveKit
// eviction. The ghost-agent fix in RoomEvent.Disconnected auto-rejoins on drop;
// that must NOT fire after a voluntary leave (it would recreate the burn we just
// stopped). The hooks below are populated by main() (which owns `room` and the
// connect-with-retry loop) so the module-level HTTP server can drive them.
let intentionalLeave = false
let connectRoomHook: (() => Promise<string>) | null = null
// Mints a LISTEN-ONLY LiveKit token for the meeting canvas so it can join the
// agent's room and play the agent's REAL TTS audio track — bit-identical to
// the browser voice experience (2026-08-01 quality architecture; replaces the
// synth-file chain when connected). Set from main() where the room name lives.
let canvasTokenHook: (() => Promise<{ token: string; url: string; room: string } | null>) | null = null
let leaveRoomHook: ((reason: string) => Promise<void>) | null = null
// Hook for the bug-reporter skill. The /report-bug HTTP endpoint validates the
// payload + generates the reportId in the module-level handler, then delegates
// to this hook which lives in main() (where sendToFrontend, currentVoiceMode,
// and currentSession are in scope). The frontend listens for the data channel
// message type 'bug_report' and writes the row to Supabase — same architecture
// as the existing fetch-log/save-log flow so we don't ship Supabase credentials
// to the Fly machine.
let bugReportHook: ((reportId: string, payload: BugReportPayload) => void) | null = null

// Module-scope hook wired by main() once startCodeServer() is defined in its
// closure. The /editor route in startApiServer() calls this to start the IDE
// in the background without depending on main()'s closure directly.
let codeServerStartHook: (() => Promise<void>) | null = null

// ── IDE reverse-proxy (module scope — shared between startApiServer + main) ──
// code-server runs on 127.0.0.1:8300; the agent proxies it through its own
// public HTTP server so no Cloudflare tunnel is needed.
const IDE_TARGET = 'http://127.0.0.1:8300'

// Route prefixes that belong to the agent itself. The proxy fall-through checks
// this list FIRST so it never intercepts an agent API path.
const AGENT_ROUTE_PREFIXES = [
  '/health', '/sessions', '/skills', '/agents', '/canvas', '/canvas-token',
  '/canvas-stream', '/events', '/room-code', '/connect-room', '/leave-room',
  '/report-bug', '/restart', '/tts', '/webhook', '/sessions/export',
  '/sessions/import', '/sessions/manifest',
  '/editor',
]

// Set true when code-server is confirmed ready; false when stopped/not running.
// Proxy returns 404 while this is false.
let ideProxyEnabled = false

// Bumped on every proxied HTTP request and WS upgrade so the idle watcher sees
// real editor activity rather than code-server log noise.
let ideLastProxiedActivity = 0

// WebSocket proxy for code-server upgrades. Using http-proxy instead of a raw
// net.createConnection splice: the raw byte-splice causes an immediate 1006
// disconnect because it doesn't properly handle the HTTP/1.1 101 framing that
// code-server expects (confirmed: cloudflared works, raw splice does not).
const wsProxy = httpProxy.createProxyServer({ target: IDE_TARGET, ws: true, changeOrigin: true })
wsProxy.on('error', (err, _req, socket) => {
  try { (socket as import('net').Socket)?.destroy() } catch {}
})

// Per-session cookie token minted when code-server becomes ready. The proxy
// gate checks this token via the osborn_ide cookie — only requests carrying a
// valid cookie are forwarded, so a forgotten agent route can never be silently
// swallowed by the IDE proxy. Cleared in stopIde().
let ideSessionToken: string | null = null

// Cancellation-generation guard for startCodeServer(). Incremented by stopIde()
// every time the IDE is torn down. startCodeServer() captures myGen at entry;
// if ideStartGeneration !== myGen when the poll resolves, the start has been
// superseded (stopIde ran mid-flight) and the result is discarded instead of
// re-enabling the proxy with no participant present.
let ideStartGeneration = 0

// Helper: parse the osborn_ide cookie from a request and return true iff it
// matches the current ideSessionToken (and a token exists).
function hasValidIdeCookie(req: IncomingMessage): boolean {
  if (!ideSessionToken) return false
  const cookieHeader = req.headers.cookie || ''
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name.trim() === 'osborn_ide' && rest.join('=').trim() === ideSessionToken) {
      return true
    }
  }
  return false
}

// ── Meeting canvas broadcaster ───────────────────────────────────────────────
// The "meeting canvas" is a single webpage Recall renders as the bot's camera +
// microphone (output_media). Recall streams BOTH the page's video (as camera)
// AND its audio (as mic) into the meeting, and grants the page mic access to the
// meeting audio — so ONE page is the bot's face (visuals), voice (TTS it plays),
// and ears. The page connects to GET /canvas-stream (SSE) and receives commands:
//   { kind: 'say',  text }                    → page speaks it → meeting hears it
//   { kind: 'show', mode, title?, items?, url?, text? } → page shows a visual
// Drive it via POST /canvas (director/testing) or pushCanvas() from meeting logic.
type CanvasEvent =
  | { kind: 'say'; text: string }
  | { kind: 'caption'; text: string } // show the spoken text as a caption WITHOUT playing audio (voice is via output_audio)
  | { kind: 'stop' } // interruption — stop any in-flight TTS immediately
  | { kind: 'show'; mode: 'idle' | 'notes' | 'stream' | 'link' | 'web' | 'text'; title?: string; items?: string[]; url?: string; text?: string }
const canvasClients = new Set<ServerResponse>()
let latestCanvasShow: CanvasEvent | null = null // last 'show' so a reconnecting canvas resyncs its visual
function pushCanvas(evt: CanvasEvent): void {
  if (evt.kind === 'show') latestCanvasShow = evt
  const line = `data: ${JSON.stringify(evt)}\n\n`
  for (const res of canvasClients) { try { res.write(line) } catch { canvasClients.delete(res) } }
  const desc = evt.kind === 'say' ? evt.text.slice(0, 60) : evt.kind === 'show' ? evt.mode : evt.kind
  console.log(`🖼️ canvas ${evt.kind}: ${desc} → ${canvasClients.size} client(s)`)
}

// ── Meeting interruption state (module scope — shared by the /canvas HTTP
// handler and the recall speech handler in main()) ──────────────────────────
const meetingBotName = 'Osborn' // the bot's name in the meeting; ignore its own speech_on
// True while the bot's TTS is (probably) still playing into the meeting. Set when
// a /canvas say is pushed; cleared after an estimated duration OR on interruption.
// A HUMAN's speech_on while this is true → interrupt.
let meetingAgentSpeaking = false
let meetingSpeakClearTimer: ReturnType<typeof setTimeout> | null = null
let meetingAgentSpeakingText = ''
// Prepended to the next flush: what the bot was cut off saying + who interrupted
// (same pattern as voice-native interruptions).
let meetingInterruptContext = ''
// Meeting speech QUEUE (0.9.121): serialize output_audio so replies never
// overlap — the Recall-sink equivalent of session.say's SpeechHandle queue.
// Recall's output_audio POST returns on ACCEPT, not on finish, so without this
// two replies (from two flushes, or a streamed multi-chunk reply) play ON TOP
// of each other — the "another voice over it" the user heard. Each utterance
// waits for the prior one's estimated playback before it plays; a generation
// counter (bumped on human interruption / a superseding turn) discards anything
// still queued so the bot never talks over itself or a human.
let meetingSpeakChain: Promise<void> = Promise.resolve()
let meetingSpeakGen = 0
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
// Estimated playback duration of a spoken line: ~2.5 words/sec + ~0.8s Recall
// buffer. Used to hold the speech queue so the next utterance doesn't overlap.
function estimatedSpeechMs(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length
  return Math.min(30_000, 800 + (words / 2.5) * 1000)
}
// Interrupt all meeting speech: bump the generation (drops queued + in-synth
// utterances) and stop any output_audio Recall is currently playing.
function interruptMeetingSpeech(reason: string): void {
  meetingSpeakGen++
  meetingAgentSpeaking = false
  if (meetingSpeakClearTimer) { clearTimeout(meetingSpeakClearTimer); meetingSpeakClearTimer = null }
  const recall = getRecallClient()
  const botId = recall?.getActiveBotIds?.()[0]
  if (recall && botId) void recall.stopOutputAudio(botId)
  console.log(`✋ meeting speech interrupted (${reason}) — queue cleared + output_audio stopped`)
}
// Synthesize speech as MP3 (Deepgram fast path, OpenAI fallback) — for
// Recall native output_audio, which requires mp3.
async function synthMp3(text: string): Promise<Buffer | null> {
  const t0 = Date.now()
  const oa = process.env.OPENAI_API_KEY
  if (!oa) { console.warn('⚠️ synthMp3: no OPENAI_API_KEY — meeting has no voice'); return null }
  // Meeting voice = the SAME OpenAI model/voice as the website's regular TTS
  // (DIRECT_MODE_TTS), so the bot sounds IDENTICAL on both fronts (user directive
  // 2026-08-04: Deepgram aura sounded "cheap and inconsistent"). Deepgram removed
  // from the meeting path entirely. Pulls model/voice from DIRECT_MODE_TTS when
  // it's an OpenAI config so the two never drift.
  const model = DIRECT_MODE_TTS.provider === 'openai' ? (DIRECT_MODE_TTS.model || 'tts-1-hd') : 'tts-1-hd'
  const voice = DIRECT_MODE_TTS.provider === 'openai' ? (DIRECT_MODE_TTS.voice || 'fable') : 'fable'
  try {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${oa}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, voice, input: text.slice(0, 4000), response_format: 'mp3' }),
      signal: AbortSignal.timeout(20000),
    })
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer())
      console.log(`🗣️ synthMp3 openai ${model}/${voice} ${buf.length}b in ${Date.now() - t0}ms`)
      return buf
    }
    const e = await r.text().catch(() => '')
    console.warn(`⚠️ synthMp3 openai ${r.status}: ${e.slice(0, 120)}`)
  } catch (e) { console.warn(`⚠️ synthMp3 openai: ${(e as Error).message}`) }
  return null
}

// THE speak path for meetings (2026-08-01): Recall native output_audio FIRST
// (direct, loud, no canvas capture chain), canvas Web-Audio say as FALLBACK.
// THE meeting speak path (2026-08-01, live-verified A/B): VOICE via Recall
// output_audio (reliable, doesn't depend on the headless canvas AudioContext),
// VISUAL caption pushed to the canvas WITHOUT audio (kind:'caption') so the
// bot's camera shows what it's saying — no double-audio. output_audio +
// canvas camera coexist (confirmed: user heard output_audio while the canvas
// was showing). Falls back to canvas 'say' (audio) only if output_audio fails.
function speakIntoMeeting(text: string): Promise<void> {
  if (!text?.trim()) return Promise.resolve()
  // Capture the generation at ENQUEUE time. If an interrupt (or a superseding
  // turn) bumps the gen before this item runs — or mid-synth — we drop it, so
  // the bot never plays a reply the conversation has already moved past.
  const gen = meetingSpeakGen
  const run = meetingSpeakChain.then(async () => {
    if (gen !== meetingSpeakGen) {
      console.log(`🔇 meeting speech superseded — dropping: "${text.slice(0, 40)}"`)
      return
    }
    const recall = getRecallClient()
    const botId = recall?.getActiveBotIds?.()[0]
    if (recall && botId) {
      const mp3 = await synthMp3(text)
      if (gen !== meetingSpeakGen) { console.log(`🔇 meeting speech interrupted mid-synth — dropping: "${text.slice(0, 40)}"`); return }
      if (mp3 && await recall.outputAudio(botId, mp3)) {
        console.log(`📢 spoke via Recall output_audio (${mp3.length}b): "${text.slice(0, 60)}"`)
        pushCanvas({ kind: 'caption', text }) // visual only, no audio
        markMeetingSpeaking(text)
        // Hold the queue for the estimated playback so the NEXT utterance
        // doesn't start on top of this one (POST returns on accept, not finish).
        await sleep(estimatedSpeechMs(text))
        return
      }
    }
    console.log(`📽️ falling back to canvas say (audio): "${text.slice(0, 50)}"`)
    pushCanvas({ kind: 'say', text })
    markMeetingSpeaking(text)
    await sleep(estimatedSpeechMs(text))
  }).catch((e) => { console.warn(`⚠️ meeting speak failed: ${(e as Error).message}`) })
  meetingSpeakChain = run
  return run
}

function markMeetingSpeaking(text: string): void {
  meetingAgentSpeaking = true
  meetingAgentSpeakingText = text
  if (meetingSpeakClearTimer) clearTimeout(meetingSpeakClearTimer)
  const ms = Math.min(30_000, 3_000 + (text.split(/\s+/).length / 2.5) * 1000) // ~2.5 wps + ~3s Recall lag
  meetingSpeakClearTimer = setTimeout(() => { meetingAgentSpeaking = false; meetingAgentSpeakingText = '' }, ms)
}

interface BugReportPayload {
  type: 'bug' | 'feature'
  severity: 'low' | 'medium' | 'high' | 'critical'
  title: string
  description: string
  reproduction_notes?: string
  tags?: string[]
}

function startApiServer(workingDir: string, port: number): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers for cloud frontend
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`)

    const syncToken = process.env.OSBORN_SYNC_TOKEN

    if (req.method === 'GET' && url.pathname === '/sessions') {
      try {
        const limit = parseInt(url.searchParams.get('limit') || '100', 10)
        const sessions = await listAllClaudeSessions(limit)
        const payload = {
          // The agent's working directory at launch — the BASE LAYER of all
          // project organization. The dashboard groups sessions relative to
          // this path: a session whose cwd === baseCwd is a "Workspace"
          // session (the base); a session at `${baseCwd}/<name>` is a
          // project called "<name>". Replaces the dashboard's previously-
          // hardcoded base-path list — agent self-describes its base so
          // the UI doesn't have to keep a sync'd copy.
          baseCwd: workingDir,
          sessions: sessions.map(s => ({
            sessionId: s.sessionId,
            projectSlug: s.projectSlug,
            projectPath: s.projectPath,
            cwd: s.cwd,
            timestamp: s.timestamp.toISOString(),
            lastMessage: s.lastMessage,
            messageCount: s.messageCount,
            fileSize: s.fileSize,
          })),
          total: sessions.length,
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      } catch (err) {
        console.error('API /sessions error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sessions: [], total: 0, error: 'Failed to list sessions' }))
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/canvas-token') {
      // Listen-only LiveKit credentials for the meeting canvas (see hook doc).
      const out = canvasTokenHook ? await canvasTokenHook() : null
      if (!out) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no active room' })); return }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out))
      return
    }

    if (req.method === 'GET' && url.pathname === '/skills') {
      // Installed skills — same list the chat's get_skills data-channel message
      // returns, exposed over HTTP so the DASHBOARD (no LiveKit connection) can
      // render the skills manager too. process.cwd() === sessionBaseDir (the
      // osborn install dir where .claude/skills lives — see main()).
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ skills: loadSkillsList(process.cwd()) }))
      return
    }

    if (req.method === 'GET' && url.pathname === '/agents') {
      // Named sub-agents (researcher/reasoner/writer) — definitions come from
      // claude-llm.ts NAMED_AGENTS (single source of truth, same object the SDK
      // query uses). Prompts are omitted: the UI manager needs role/model/tools,
      // not the full instruction text.
      const agents = Object.entries(NAMED_AGENTS).map(([name, a]: [string, any]) => ({
        name,
        description: a.description,
        model: a.model,
        tools: a.tools,
      }))
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ agents }))
      return
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      // Include osborn version — primary signal used by machines.readInstalledOsbornVersion()
      // to detect which agent version is running. Without this the consumer falls back to
      // parsing the Docker image tag (e.g. ":latest" → rejected) and returns null, which
      // breaks the dashboard's version badge + the upgrade-needed comparison.
      // Read once at module load? No — package.json is small and resolveFromPackage() handles
      // both `dist/` (installed) and `src/` (local dev) layouts.
      let version: string | undefined
      try {
        // Walk up from this file's dirname to find package.json. Works whether running
        // from src/ (tsx local dev) or dist/ (compiled npm install).
        const { readFileSync } = await import('node:fs')
        const { join } = await import('node:path')
        for (const rel of ['../package.json', '../../package.json']) {
          try {
            const pkg = JSON.parse(readFileSync(join(__dirname, rel), 'utf8'))
            if (pkg.name === 'osborn' && pkg.version) { version = pkg.version; break }
          } catch { /* try next */ }
        }
      } catch { /* version optional */ }

      // System memory snapshot — use os.totalmem/freemem for WHOLE-MACHINE
      // stats (the OOM killer watches these, not per-process RSS). processRssMb
      // is additive: useful for spotting leaks but never the headline number.
      const totalMb = Math.round(totalmem() / 1024 / 1024)
      const freeMb  = Math.round(freemem()  / 1024 / 1024)
      const usedMb  = totalMb - freeMb
      const availableMb = freeMb
      const usedPct = Math.round((usedMb / totalMb) * 100)
      const processRssMb = Math.round(process.memoryUsage().rss / 1024 / 1024)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        workingDir,
        version,
        // WHERE this machine physically runs — Fly sets FLY_REGION (e.g. 'ord').
        // The dashboard maps it to a city ("Chicago") so the user always knows
        // the machine's location, not just their own clock. Null in local dev.
        region: process.env.FLY_REGION || null,
        // LiveKit subsystem status — frontend can use this to surface a real
        // error instead of treating the sandbox as totally broken. The HTTP
        // status code stays 200 so Fly health-check stays green and the
        // container isn't restart-looped while LiveKit is unreachable.
        livekit: {
          status: livekitState.status,
          error: livekitState.error,
          errorCode: livekitState.errorCode,
          attemptCount: livekitState.attemptCount,
          lastAttemptAt: livekitState.lastAttemptAt,
        },
        // Whole-machine memory — what the OOM killer watches. All values in MB.
        memory: { totalMb, usedMb, availableMb, usedPct, processRssMb },
      }))
      return
    }

    // POST /webhook/recall — Recall.ai real-time transcript webhooks
    if (req.method === 'POST' && url.pathname === '/webhook/recall') {
      // Respond 200 immediately — never block or Node delays next webhooks
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')

      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        try {
          const payload = JSON.parse(body)
          // 0.9.86: log every receipt so we can SEE what Recall streams
          // (event type + word count) — the handler was silent, making it
          // impossible to tell whether webhooks arrive or are just filtered.
          const evt = payload?.event ?? 'unknown'
          const wc = (payload?.data?.data?.words ?? []).length
          console.log(`📨 Recall webhook: event=${evt} words=${wc}`)
          const recall = getRecallClient()
          if (recall) recall.handleWebhook(payload)
        } catch (e) {
          console.error('Recall webhook parse error:', e)
        }
      })
      return
    }


    // GET /room-code — LEGACY (0.9.83). Returns the LAST-CREATED full room NAME
    // (not a short code anymore) so old frontends that fetch this before joining
    // keep working during rollout. New frontends should instead call
    // POST /connect-room and use the returned { roomName }. Kept as a fallback.
    if (req.method === 'GET' && url.pathname === '/room-code') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ roomCode: currentRoomCode }))
      return
    }

    // POST /connect-room — the frontend connect flow calls this so the agent
    // joins LiveKit for an incoming user. 0.9.83: creates a FRESH, UNIQUE room
    // per session and AWAITS the join so we can return the room NAME the
    // frontend must mint its token against — eliminating the /room-code fetch
    // race. Response: { ok, roomName }. The frontend should bind to roomName
    // directly (mint its LiveKit token for it) rather than fetching /room-code.
    // The agent is in the room by the time this responds, so the user's join
    // fires ParticipantConnected (or is caught by the adopt-sweep either way).
    if (req.method === 'POST' && url.pathname === '/connect-room') {
      if (!connectRoomHook) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'agent not ready' }))
        return
      }
      connectRoomHook()
        .then((roomName) => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, roomName, status: livekitState.status }))
        })
        .catch((e) => {
          console.error('❌ /connect-room hook failed:', e)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e), status: livekitState.status }))
        })
      return
    }

    // POST /leave-room — the frontend's explicit "leave"/disconnect leaves the
    // LiveKit room immediately so connection-minute burn stops the instant the
    // user is done (no waiting for the agent-side alone timer). Sets
    // intentionalLeave so the Disconnected handler does NOT auto-rejoin.
    if (req.method === 'POST' && url.pathname === '/leave-room') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      if (leaveRoomHook) {
        leaveRoomHook('frontend_leave').catch((e) => console.error('❌ /leave-room hook failed:', e))
      }
      return
    }

    // POST /report-bug — invoked by the bug-reporter skill (running inside Claude
    // Code on this same machine) when the user describes an Osborn bug or
    // requests a feature. We validate the payload, generate a reportId, and emit
    // a data channel message via bugReportHook → sendToFrontend. The frontend
    // owns the actual Supabase write (it already has the keys for the log-upload
    // flow, no need to ship them to the Fly machine).
    if (req.method === 'POST' && url.pathname === '/report-bug') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}') as Partial<BugReportPayload>
          const errors: string[] = []
          if (parsed.type !== 'bug' && parsed.type !== 'feature') errors.push('type must be "bug" or "feature"')
          if (!parsed.title || typeof parsed.title !== 'string' || parsed.title.length < 3) errors.push('title required (>= 3 chars)')
          if (!parsed.description || typeof parsed.description !== 'string') errors.push('description required')
          const sev = parsed.severity || 'medium'
          if (!['low', 'medium', 'high', 'critical'].includes(sev)) errors.push('severity invalid')
          if (errors.length) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid payload', details: errors }))
            return
          }
          const reportId = randomUUID()
          const payload: BugReportPayload = {
            type: parsed.type as 'bug' | 'feature',
            severity: sev as BugReportPayload['severity'],
            title: parsed.title!.trim().slice(0, 200),
            description: parsed.description!.trim().slice(0, 8000),
            reproduction_notes: typeof parsed.reproduction_notes === 'string'
              ? parsed.reproduction_notes.trim().slice(0, 4000)
              : undefined,
            tags: Array.isArray(parsed.tags)
              ? parsed.tags.filter((t) => typeof t === 'string').slice(0, 20)
              : undefined,
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ reportId, status: 'submitted' }))
          if (bugReportHook) {
            try { bugReportHook(reportId, payload) } catch (e) {
              console.error('❌ bugReportHook threw:', e)
            }
          } else {
            console.warn('⚠️ /report-bug fired but no bugReportHook registered (frontend may not receive)')
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid JSON', details: (e as Error).message }))
        }
      })
      return
    }

    // POST /restart — graceful process restart (process manager will restart)
    if (req.method === 'POST' && url.pathname === '/restart') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, message: 'Agent restarting...' }))
      console.log('🔄 Restart requested via HTTP — exiting for process manager restart')
      setTimeout(() => process.exit(0), 150)
      return
    }

    // GET /events — Server-Sent Events heartbeat for cloud-sandbox keepalive.
    //
    // This endpoint is the single thing preventing Sprites' CRIU-based
    // hibernation from freezing osborn's Node.js event loop and dropping our
    // LiveKit WebSocket mid-session. Short HTTP pings don't work: Sprites'
    // warm state serves /health responses from a process snapshot without
    // actually resuming the event loop, so background timers (including
    // LiveKit heartbeats) stop firing after a few seconds. That causes the
    // LiveKit server to drop osborn's participant, delete the room, and
    // leave any future user joins stuck at "Connecting..." forever.
    //
    // An OPEN long-lived TCP connection keeps the sprite in 'running' state.
    // The frontend opens this endpoint on chat page mount and holds it open
    // for the entire voice session. While open, osborn's event loop ticks
    // continuously, LiveKit heartbeats fire, and the room stays alive.
    //
    // For local (non-cloud) dev, this endpoint is harmless — it just idles
    // on a client that may never connect. Zero cost when unused.
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        // Disable proxy buffering (nginx-style) so each ping is flushed
        // through Sprites' reverse proxy immediately rather than batched.
        'X-Accel-Buffering': 'no',
      })
      res.write(`: sprite-keepalive connected at ${new Date().toISOString()}\n\n`)
      const heartbeat = setInterval(() => {
        try { res.write(`: ping ${Date.now()}\n\n`) } catch {}
      }, 10_000)
      req.on('close', () => {
        clearInterval(heartbeat)
        console.log('[events] SSE client disconnected')
      })
      console.log('[events] SSE client connected')
      return
    }

    // ── Meeting canvas: SSE stream the Recall webpage subscribes to ──────────
    // The canvas page (frontend /meeting-canvas) opens this as an EventSource.
    // Recall renders that page as the bot's camera+mic, so whatever we push here
    // becomes what the meeting sees + hears. On connect we resync the current
    // visual so a page reload doesn't blank the bot's camera.
    if (req.method === 'GET' && url.pathname === '/canvas-stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(`: canvas connected ${new Date().toISOString()}\n\n`)
      res.write(`data: ${JSON.stringify(latestCanvasShow ?? { kind: 'show', mode: 'idle' })}\n\n`)
      canvasClients.add(res)
      const hb = setInterval(() => { try { res.write(`: ping ${Date.now()}\n\n`) } catch {} }, 10_000)
      req.on('close', () => { clearInterval(hb); canvasClients.delete(res); console.log('[canvas] client disconnected') })
      console.log(`[canvas] client connected (${canvasClients.size} total)`)
      return
    }

    // ── Meeting canvas: TTS audio for speaking INTO the meeting ──────────────
    // GET /tts?text=... → mp3 (OpenAI TTS). The canvas plays this as a real
    // <audio> element so Recall's webpage output pipes it into the meeting —
    // speechSynthesis is NOT captured by Recall, a media element IS.
    if (req.method === 'GET' && url.pathname === '/tts') {
      const text = (url.searchParams.get('text') || '').slice(0, 4000)
      if (!text) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no text' })); return }
      const t0 = Date.now()
      // Meeting voice = the SAME OpenAI model/voice as the website's regular TTS
      // (DIRECT_MODE_TTS) — user directive 2026-08-04: Deepgram aura removed, it
      // sounded cheap/inconsistent. Consistency over the ~2-4s latency Deepgram
      // saved. mp3 out (the canvas <audio> element plays it into the meeting).
      const key = process.env.OPENAI_API_KEY
      if (!key) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no OPENAI_API_KEY' })); return }
      const model = DIRECT_MODE_TTS.provider === 'openai' ? (DIRECT_MODE_TTS.model || 'tts-1-hd') : 'tts-1-hd'
      const voice = url.searchParams.get('voice') || (DIRECT_MODE_TTS.provider === 'openai' ? (DIRECT_MODE_TTS.voice || 'fable') : 'fable')
      try {
        const tts = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, voice, input: text, response_format: 'mp3' }),
        })
        if (!tts.ok) { const e = await tts.text().catch(() => ''); res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `tts ${tts.status}`, detail: e.slice(0, 200) })); return }
        const buf = Buffer.from(await tts.arrayBuffer())
        console.log(`🗣️ /tts openai ${model}/${voice} ${buf.length}b in ${Date.now() - t0}ms t=${new Date().toISOString()}`)
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Content-Length': buf.length })
        res.end(buf)
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: (e as Error).message }))
      }
      return
    }

    // ── Meeting canvas: control endpoint (director / agent tool) ─────────────
    // POST /canvas  { kind:'say', text } | { kind:'show', mode, title?, items?, url?, text? }
    if (req.method === 'POST' && url.pathname === '/canvas') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try {
          const evt = JSON.parse(body || '{}') as CanvasEvent
          if (evt.kind !== 'say' && evt.kind !== 'caption' && evt.kind !== 'show' && evt.kind !== 'stop') throw new Error("kind must be 'say', 'caption', 'show', or 'stop'")
          if (evt.kind === 'say') {
            // Native-first speak path (Recall output_audio → canvas fallback).
            void speakIntoMeeting(evt.text)
          } else {
            pushCanvas(evt)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, clients: canvasClients.size }))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: (e as Error).message }))
        }
      })
      return
    }

    // GET /sessions/export — stream a gzipped tar of ~/.claude/projects/ AND
    // ~/.claude/skills/ to the client. Both directories ship in one archive so
    // a sync covers conversations (projects/) and learned skills together —
    // e.g. PostCompact-written `decisions/SKILL.md` and `learned-behaviors/SKILL.md`
    // travel with the user's session data.
    // Optional ?workDir= query param accepted for backwards compat but ignored
    // (full export is always returned).
    if (req.method === 'GET' && url.pathname === '/sessions/export') {
      if (syncToken) {
        const authHeader = req.headers['authorization'] ?? ''
        if (authHeader !== `Bearer ${syncToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }
      }
      const claudeDir = join(homedir(), '.claude')
      const projectsDir = join(claudeDir, 'projects')
      const skillsDir = join(claudeDir, 'skills')
      const workDir = url.searchParams.get('workDir')
      void workDir
      // Collect which top-level dirs exist — tar fails if we list one that doesn't.
      const topLevel: string[] = []
      if (existsSync(projectsDir)) topLevel.push('projects')
      if (existsSync(skillsDir)) topLevel.push('skills')
      if (topLevel.length === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'No sessions or skills found' }))
        return
      }
      const tarArgs = ['-czf', '-', '-C', claudeDir, ...topLevel]
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': 'attachment; filename="claude-export.tar.gz"',
        'Access-Control-Allow-Origin': '*',
      })
      // Stream tar output directly to response
      const tar = spawn('tar', tarArgs)
      tar.stdout.pipe(res)
      tar.stderr.on('data', (d: Buffer) => console.error('[export]', d.toString()))
      tar.on('close', (code: number | null) => { if (code !== 0) res.destroy() })
      return
    }

    // GET /sessions/export-one?sessionId=X — tar.gz of a SINGLE session's files
    // (the .jsonl, its sidecar dir, and its osb/ workspace), for SESSION SHARING
    // (0.9.123): the frontend fetches this from the owner's machine, uploads it
    // to Supabase Storage, and the recipient's machine imports it via the
    // existing POST /sessions/import (slug-remapped into the recipient's
    // workspace). Note: gated only by knowing the machine URL + the session UUID
    // for the MVP — a per-share access token is a follow-up (tracked in
    // shared_sessions). sessionId is regex-validated to block path traversal.
    if (req.method === 'GET' && url.pathname === '/sessions/export-one') {
      const sessionId = (url.searchParams.get('sessionId') || '').trim()
      if (!sessionId || !/^[a-zA-Z0-9._-]+$/.test(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bad or missing sessionId' })); return
      }
      const claudeDir = join(homedir(), '.claude')
      const projectsDir = join(claudeDir, 'projects')
      if (!existsSync(projectsDir)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no projects dir' })); return }
      // Find the project slug whose folder contains {sessionId}.jsonl.
      let foundSlug: string | null = null
      for (const slug of readdirSync(projectsDir)) {
        if (existsSync(join(projectsDir, slug, `${sessionId}.jsonl`))) { foundSlug = slug; break }
      }
      if (!foundSlug) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'session not found' })); return }
      // Only tar the paths that exist (tar errors on a missing member).
      const members: string[] = [join('projects', foundSlug, `${sessionId}.jsonl`)]
      if (existsSync(join(projectsDir, foundSlug, sessionId))) members.push(join('projects', foundSlug, sessionId))
      if (existsSync(join(projectsDir, foundSlug, 'osb', sessionId))) members.push(join('projects', foundSlug, 'osb', sessionId))
      console.log(`📤 export-one session ${sessionId} (slug ${foundSlug}, ${members.length} member(s))`)
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="session-${sessionId}.tar.gz"`,
        'Access-Control-Allow-Origin': '*',
      })
      const tar = spawn('tar', ['-czf', '-', '-C', claudeDir, ...members])
      tar.stdout.pipe(res)
      tar.stderr.on('data', (d: Buffer) => console.error('[export-one]', d.toString()))
      tar.on('close', (code: number | null) => { if (code !== 0) res.destroy() })
      return
    }

    // GET /sessions/manifest — return mtime+size for all .jsonl files per slug (public, no auth)
    // Helper: merge an extracted tar directory into ~/.claude/{projects,skills}/.
    //
    // Behavior:
    //   1. Skip macOS AppleDouble entries (`._*`) that bsdtar emits
    //   2. Project slugs: apply slug remap when targetWorkDir is supplied so
    //      laptop/codespaces sessions land at the destination's slug.
    //   3. Skills: copy each <skillName>/ directory verbatim (no slug remap —
    //      skill identity is the directory name, same across all environments).
    //      PostCompact-learned skills like 'decisions' and 'learned-behaviors'
    //      from a sprite travel through to the destination this way.
    //   4. Per-file mtime-newer-wins resolves collisions in either dir (preserves
    //      whichever side has the more-recent version).
    //   5. Byte-exact copy — no content mutation in either projects/ or skills/.
    const mergeExtractedClaudeDir = async (
      sourceDir: string,
      targetWorkDir: string | undefined,
    ): Promise<{ filesWritten: number, remapped: Record<string, string>, skillsWritten: number }> => {
      const claudeDir = join(homedir(), '.claude')
      const projectsDir = join(claudeDir, 'projects')
      const skillsDir = join(claudeDir, 'skills')
      mkdirSync(projectsDir, { recursive: true })
      mkdirSync(skillsDir, { recursive: true })

      // The archive may wrap content in a 'projects' / 'skills' subdir, or be
      // a flat dir of slugs. Detect both.
      const extractedProjects = join(sourceDir, 'projects')
      const extractedSkills = join(sourceDir, 'skills')
      const hasProjectsWrapper = existsSync(extractedProjects)
      const hasSkillsWrapper = existsSync(extractedSkills)
      // If neither wrapper exists, treat the source dir as a flat slug dir
      // (back-compat with older client tar layouts).
      const effectiveSource = (hasProjectsWrapper || hasSkillsWrapper) ? null : sourceDir

      // ─── PROJECTS extraction ─────────────────────────────────────────
      const projectsSource = hasProjectsWrapper ? extractedProjects : effectiveSource
      const sourceSlugs = projectsSource
        ? readdirSync(projectsSource).filter(s => !s.startsWith('._') && !s.startsWith('.DS_Store'))
        : []

      // Build remap table: source-slug → target-slug.
      // Only remaps slugs that differ from the target (no-op if already correct).
      const remapped: Record<string, string> = {}
      const targetSlug = targetWorkDir ? targetWorkDir.replace(/\//g, '-') : ''
      if (targetSlug) {
        for (const slug of sourceSlugs) {
          if (slug !== targetSlug) remapped[slug] = targetSlug
        }
      }

      // Slug → original cwd path (reverse of slug encoding):
      //   '-Users-newupgrade-Desktop-Developer-osborn' → '/Users/newupgrade/Desktop/Developer/osborn'
      // Claude Code's slug rule: replace all '/' with '-', so reverse is replace '-' with '/'.
      // Leading '-' becomes '/'. We don't try to recover '.' (Claude uses '--' for it, but
      // dot-prefixed dirs are uncommon and a best-effort rewrite is enough for resume).
      const slugToCwd = (slug: string): string => '/' + slug.replace(/^-/, '').replace(/-/g, '/')

      let filesWritten = 0

      for (const sourceSlug of sourceSlugs) {
        const effectiveSlug = remapped[sourceSlug] ?? sourceSlug
        const destSlug = join(projectsDir, effectiveSlug)
        mkdirSync(destSlug, { recursive: true })

        const sourceSlugPath = join(projectsSource!, sourceSlug)
        // NO content mutation. Earlier versions rewrote the embedded `"cwd":"..."`
        // field inside JSONL entries to match the destination workspace. That was
        // wrong on two counts:
        //   1. The cwd field is documentary metadata, not how Claude Code resolves
        //      a session at resume time — resume uses the slug directory name.
        //   2. Mutating contents breaks roundtripability (laptop → cloud → laptop
        //      ends up with /workspace cwd on laptop), corrupting historical data
        //      across environment hops.
        // What's actually needed is just the slug rename (handled by `effectiveSlug`
        // below). File contents stay byte-exact across every transfer direction.
        void sourceSlugPath
        void targetWorkDir

        // Walk the source slug directory and copy files individually so we can:
        //   (a) skip AppleDouble per-file too (in case nested)
        //   (b) rewrite cwd inside .jsonl files when remapping across workspaces
        //   (c) merge into existing destination directories without renameSync collision
        //   (d) keep newer-by-mtime when both sides have the same file (the user's
        //       requested "overwrite based on timestamp" rule for bidirectional sync)
        const walkAndCopy = (src: string, dst: string): void => {
          const entries = readdirSync(src, { withFileTypes: true })
          for (const e of entries) {
            if (e.name.startsWith('._') || e.name === '.DS_Store') continue
            const sp = join(src, e.name)
            const dp = join(dst, e.name)
            if (e.isDirectory()) {
              mkdirSync(dp, { recursive: true })
              walkAndCopy(sp, dp)
            } else if (e.isFile()) {
              // mtime conflict resolution — when destination already has this file,
              // only overwrite when the source is strictly newer. Preserves work
              // done on the destination side when re-syncing in either direction.
              let shouldWrite = true
              try {
                const dstStat = statSync(dp)
                const srcStat = statSync(sp)
                if (dstStat.mtimeMs >= srcStat.mtimeMs) shouldWrite = false
              } catch { /* dst doesn't exist — write it */ }
              if (!shouldWrite) continue

              // Copy byte-exact — no content mutation. The slug rename above is
              // the only structural change; file contents are immutable historical
              // record and must roundtrip cleanly between environments.
              cpSync(sp, dp, { force: true })
              // 0.9.75: preserve the source mtime on the copy. cpSync stamps the
              // destination with "now", which scrambled session ordering after
              // every sync — the frontend's auto-resume picks most-recent-by-mtime,
              // so a fresh import made a random tar-order file (often a tiny
              // months-old session) look newest, and users kept "resuming" into
              // stale June sessions (confirmed in prod 2026-07-27, 3× in a row).
              // The tarball carries original mtimes; copying must not discard them.
              try {
                const srcStat = statSync(sp)
                utimesSync(dp, srcStat.atime, srcStat.mtime)
              } catch { /* best-effort — ordering degrades gracefully */ }
              filesWritten++
            }
            // skip symlinks, sockets, etc.
          }
        }

        walkAndCopy(sourceSlugPath, destSlug)

        // Best-effort: ensure the resolved workspace directory exists so Claude
        // can resume conversations whose JSONLs reference it.
        const recoveredPath = effectiveSlug.replace(/^-/, '/').replace(/--/g, '/.').replace(/-/g, '/')
        if (recoveredPath && recoveredPath !== '/') {
          try { mkdirSync(recoveredPath, { recursive: true }) } catch { /* ignore */ }
        }
      }

      // ─── SKILLS extraction ───────────────────────────────────────────
      // Skill identity is the directory name (`decisions`, `learned-behaviors`,
      // etc.) so there's no slug remap — each <skillName>/ dir copies into
      // ~/.claude/skills/<skillName>/. Mtime-newer-wins handles collisions:
      //   - Default skills seeded by Docker entrypoint have the boot mtime
      //   - Learned skills from source have whatever mtime they had on origin
      //   - Newer side wins per file
      let skillsWritten = 0
      if (hasSkillsWrapper) {
        const sourceSkillNames = readdirSync(extractedSkills)
          .filter(s => !s.startsWith('._') && !s.startsWith('.DS_Store'))
        for (const skillName of sourceSkillNames) {
          const srcSkillPath = join(extractedSkills, skillName)
          const dstSkillPath = join(skillsDir, skillName)
          mkdirSync(dstSkillPath, { recursive: true })

          // Reuse the same mtime-aware walkAndCopy from the projects loop —
          // it's still in scope from the last iteration. If sourceSlugs was
          // empty, define it inline here. (Define standalone to be safe.)
          const walkSkill = (src: string, dst: string): void => {
            const entries = readdirSync(src, { withFileTypes: true })
            for (const e of entries) {
              if (e.name.startsWith('._') || e.name === '.DS_Store') continue
              const sp = join(src, e.name)
              const dp = join(dst, e.name)
              if (e.isDirectory()) { mkdirSync(dp, { recursive: true }); walkSkill(sp, dp) }
              else if (e.isFile()) {
                let shouldWrite = true
                try {
                  const dstStat = statSync(dp)
                  const srcStat = statSync(sp)
                  if (dstStat.mtimeMs >= srcStat.mtimeMs) shouldWrite = false
                } catch {}
                if (!shouldWrite) continue
                cpSync(sp, dp, { force: true })
                skillsWritten++
              }
            }
          }
          walkSkill(srcSkillPath, dstSkillPath)
        }
      }

      return { filesWritten, remapped, skillsWritten }
    }

    if (req.method === 'GET' && url.pathname === '/sessions/manifest') {
      // Walks BOTH ~/.claude/projects/ AND ~/.claude/skills/ — full tree per
      // top-level directory.
      //   - projects/<slug>/<...> → session JSONLs, sub-agent transcripts, tool-results, osb/
      //   - skills/<skillName>/<...> → SKILL.md + any subfiles
      // Files keyed by path RELATIVE to the slug/skill-name dir so the client
      // can preserve structure when computing diffs. mtime in ms epoch.
      const projectsRoot = join(homedir(), '.claude', 'projects')
      const skillsRoot = join(homedir(), '.claude', 'skills')

      const walkDir = (dir: string): Record<string, { mtime: number, size: number }> => {
        const files: Record<string, { mtime: number, size: number }> = {}
        const walk = (curr: string, relPrefix: string): void => {
          let entries
          try { entries = readdirSync(curr, { withFileTypes: true }) } catch { return }
          for (const e of entries) {
            if (e.name.startsWith('._') || e.name === '.DS_Store') continue
            const sub = join(curr, e.name)
            const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name
            if (e.isDirectory()) walk(sub, rel)
            else if (e.isFile()) {
              try {
                const st = statSync(sub)
                files[rel] = { mtime: st.mtimeMs, size: st.size }
              } catch { /* skip unreadable */ }
            }
          }
        }
        walk(dir, '')
        return files
      }

      const slugMap: Record<string, { files: Record<string, { mtime: number, size: number }> }> = {}
      try {
        for (const slug of readdirSync(projectsRoot, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('._'))
          .map(d => d.name)) {
          slugMap[slug] = { files: walkDir(join(projectsRoot, slug)) }
        }
      } catch { /* projects dir doesn't exist yet — leave empty */ }

      const skillsMap: Record<string, { files: Record<string, { mtime: number, size: number }> }> = {}
      try {
        for (const name of readdirSync(skillsRoot, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('._'))
          .map(d => d.name)) {
          skillsMap[name] = { files: walkDir(join(skillsRoot, name)) }
        }
      } catch { /* skills dir doesn't exist yet — leave empty */ }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ slugs: slugMap, skills: skillsMap }))
      return
    }

    // POST /sessions/import — accept a gzipped tar and extract into ~/.claude/projects/
    if (req.method === 'POST' && url.pathname === '/sessions/import') {
      if (syncToken) {
        const authHeader = req.headers['authorization'] ?? ''
        if (authHeader !== `Bearer ${syncToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }
      }
      // 0.9.74: default targetWorkDir to this machine's own working directory.
      // Stale sync clients that omit the param used to get source slugs written
      // verbatim — those sessions LIST fine (the scanner walks all slugs) but
      // silently fail to RESUME (the SDK resumes at cwd=workingDir, whose slug
      // they don't match). Confirmed in prod 2026-07-27 after a stale-skill
      // upload. On a cloud machine, remapping into our own workspace is always
      // the right default; a client that genuinely wants source slugs preserved
      // (e.g. laptop→laptop mirroring) must now opt in with preserveSlugs=1.
      const targetWorkDir = url.searchParams.get('targetWorkDir')
        ?? (url.searchParams.get('preserveSlugs') === '1' ? null : workingDir)

      const tmpDir = mkdtempSync(join(tmpdir(), 'osborn-import-'))
      const tarProc = spawn('tar', ['-xf', '-', '-C', tmpDir])

      // Stream-sniff the first chunk to detect gzip magic bytes (0x1f 0x8b).
      // Then route through createGunzip() if gzip, otherwise pipe raw to tar.
      // This avoids any reliance on Content-Type or Content-Encoding headers.
      const passthrough = new PassThrough()
      let sniffDone = false
      req.once('data', (firstChunk: Buffer) => {
        sniffDone = true
        const isGzip = firstChunk[0] === 0x1f && firstChunk[1] === 0x8b
        passthrough.write(firstChunk)
        req.pipe(passthrough)
        const source = isGzip ? passthrough.pipe(createGunzip()) : passthrough
        source.pipe(tarProc.stdin)
      })
      req.once('end', () => {
        if (!sniffDone) {
          // Empty body — just end tar stdin
          passthrough.end()
          tarProc.stdin.end()
        }
      })

      tarProc.stdin.on('error', (err: Error) => {
        console.error('[import] tar stdin error', err)
        tarProc.kill('SIGTERM')
        rmSync(tmpDir, { recursive: true, force: true })
        if (!res.headersSent) {
          res.writeHead(500)
          res.end(JSON.stringify({ error: 'upload error' }))
        }
      })

      req.on('aborted', () => {
        tarProc.kill('SIGTERM')
        rmSync(tmpDir, { recursive: true, force: true })
      })

      tarProc.stderr.on('data', (d: Buffer) => console.error('[import]', d.toString()))

      tarProc.on('close', async (code: number | null) => {
        try {
          if (code !== 0) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: 'tar extraction failed', code }))
            return
          }
          const { filesWritten, remapped, skillsWritten } = await mergeExtractedClaudeDir(tmpDir, targetWorkDir ?? undefined)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, filesWritten, remapped, skillsWritten }))
        } catch (err) {
          console.error('[import] merge error:', err)
          if (!res.headersSent) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: 'Failed to merge sessions', detail: String(err) }))
          }
        } finally {
          rmSync(tmpDir, { recursive: true, force: true })
        }
      })
      return
    }

    // POST /sessions/import-chunk — accept a single chunk of a multi-part upload
    if (req.method === 'POST' && url.pathname === '/sessions/import-chunk') {
      if (syncToken) {
        const authHeader = req.headers['authorization'] ?? ''
        if (authHeader !== `Bearer ${syncToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }
      }

      const uploadId = url.searchParams.get('uploadId')
      const chunkIndex = parseInt(url.searchParams.get('chunk') || '0')

      if (!uploadId) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'uploadId required' }))
        return
      }

      // Chunk storage dir: /tmp/osborn-upload-<uploadId>/
      const uploadDir = join(tmpdir(), `osborn-upload-${uploadId}`)
      mkdirSync(uploadDir, { recursive: true })

      // Write chunk to padded filename for correct sort order
      const chunkPath = join(uploadDir, `chunk-${String(chunkIndex).padStart(6, '0')}`)
      const writeStream = createWriteStream(chunkPath)
      req.pipe(writeStream)

      writeStream.on('finish', () => {
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, chunk: chunkIndex }))
      })

      writeStream.on('error', (err) => {
        console.error('[import-chunk] write error', err)
        if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: 'write failed' })) }
      })

      req.on('aborted', () => { writeStream.destroy() })
      return
    }

    // POST /sessions/import-finalize — reassemble chunks, extract, apply slug merge
    if (req.method === 'POST' && url.pathname === '/sessions/import-finalize') {
      if (syncToken) {
        const authHeader = req.headers['authorization'] ?? ''
        if (authHeader !== `Bearer ${syncToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }
      }

      const uploadId = url.searchParams.get('uploadId')
      const total = parseInt(url.searchParams.get('total') || '0')
      const targetWorkDir = url.searchParams.get('targetWorkDir') ?? undefined

      if (!uploadId || total === 0) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'uploadId and total required' }))
        return
      }

      const uploadDir = join(tmpdir(), `osborn-upload-${uploadId}`)

      // Verify all chunks present
      const expectedChunks = Array.from({ length: total }, (_, i) => `chunk-${String(i).padStart(6, '0')}`)
      const presentChunks = existsSync(uploadDir) ? readdirSync(uploadDir).filter(f => f.startsWith('chunk-')).sort() : []

      const missing = expectedChunks.filter(c => !presentChunks.includes(c))
      if (missing.length > 0) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'missing chunks', missing }))
        return
      }

      const tmpExtractDir = mkdtempSync(join(tmpdir(), 'osborn-import-'))

      try {
        // Reassemble all chunks into a combined buffer, then sniff first 2 bytes
        // to detect gzip magic (0x1f 0x8b). Route through createGunzip() if gzip,
        // otherwise pass raw bytes — always using tar -xf (no -z flag).
        const chunkBuffers: Buffer[] = []
        for (const chunkFile of expectedChunks) {
          chunkBuffers.push(readFileSync(join(uploadDir, chunkFile)))
        }
        const combined = Buffer.concat(chunkBuffers)
        const isGzip = combined[0] === 0x1f && combined[1] === 0x8b

        const tarProc = spawn('tar', ['-xf', '-', '-C', tmpExtractDir])

        // Feed combined buffer through gunzip (if needed) then into tar stdin
        const feedStream = new PassThrough()
        const tarInput = isGzip ? feedStream.pipe(createGunzip()) : feedStream
        tarInput.pipe(tarProc.stdin)
        feedStream.end(combined)

        const streamChunks = async () => {
          // feeding is already initiated above; just return a resolved promise
          await Promise.resolve()
        }

        streamChunks().catch(err => {
          console.error('[import-finalize] chunk stream error', err)
          tarProc.kill('SIGTERM')
        })

        tarProc.stderr.on('data', (d: Buffer) => console.error('[import-finalize]', d.toString()))

        tarProc.on('close', async (code: number | null) => {
          try {
            if (code !== 0) {
              res.writeHead(500); res.end(JSON.stringify({ error: 'tar extraction failed', code })); return
            }
            const { filesWritten, remapped, skillsWritten } = await mergeExtractedClaudeDir(tmpExtractDir, targetWorkDir)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, filesWritten, remapped, skillsWritten }))
          } catch (err) {
            console.error('[import-finalize] merge error:', err)
            if (!res.headersSent) {
              res.writeHead(500)
              res.end(JSON.stringify({ error: 'Failed to merge sessions', detail: String(err) }))
            }
          } finally {
            rmSync(uploadDir, { recursive: true, force: true })
            rmSync(tmpExtractDir, { recursive: true, force: true })
          }
        })
      } catch (err) {
        rmSync(uploadDir, { recursive: true, force: true })
        rmSync(tmpExtractDir, { recursive: true, force: true })
        throw err
      }
      return
    }

    // DELETE /sessions/project?slug=<slug> — remove all sessions under a slug.
    // Deletes ~/.claude/projects/<slug>/ and ~/.claude/projects/osb/<slug>/
    // Used by the dashboard "delete project" button.
    if (req.method === 'DELETE' && url.pathname === '/sessions/project') {
      if (syncToken) {
        const authHeader = req.headers['authorization'] ?? ''
        if (authHeader !== `Bearer ${syncToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }
      }
      const slug = url.searchParams.get('slug')
      if (!slug || slug.includes('..') || slug.includes('/')) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid slug' }))
        return
      }
      const projectsDir = join(homedir(), '.claude', 'projects')
      const targetDir = join(projectsDir, slug)
      if (!targetDir.startsWith(projectsDir + '/')) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid slug path' }))
        return
      }
      if (!existsSync(targetDir)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Project not found', slug }))
        return
      }
      try {
        // Count files before deleting so we can report what was removed
        let fileCount = 0
        const countFiles = (dir: string) => {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) countFiles(join(dir, e.name))
            else fileCount++
          }
        }
        countFiles(targetDir)
        rmSync(targetDir, { recursive: true, force: true })
        console.log(`🗑️ Deleted project slug ${slug} (${fileCount} files)`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, slug, filesDeleted: fileCount }))
      } catch (err) {
        console.error(`❌ Failed to delete project ${slug}:`, err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Delete failed: ${(err as Error).message}` }))
      }
      return
    }

    // ── /editor entry point ──────────────────────────────────────────────────
    // Explicit door into the IDE. When code-server is ready this route mints the
    // osborn_ide session cookie and 302s to / (where the proxy then forwards). If
    // code-server is not yet running, it starts it in the background and returns a
    // self-refreshing "Starting…" page so the user naturally re-hits /editor every
    // 3 s until ready.
    if (url.pathname === '/editor' && req.method === 'GET') {
      // AUTH GATE (future): validate key / signed session before minting the cookie
      if (ideProxyEnabled && ideSessionToken) {
        // code-server is up — set cookie and redirect to root (code-server's asset base)
        res.writeHead(302, {
          'Set-Cookie': `osborn_ide=${ideSessionToken}; Path=/; HttpOnly; SameSite=Lax`,
          'Location': '/',
        })
        res.end()
      } else {
        // Not yet running — kick off start in the background, show "Starting…" page
        if (codeServerStartHook) {
          codeServerStartHook().catch((err) => {
            console.error('❌ startCodeServer() from /editor failed:', err)
          })
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, must-revalidate',
          'Pragma': 'no-cache',
        })
        res.end(`<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="3;url=/editor">
<title>Starting editor…</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1e1e1e;color:#ccc}</style>
</head><body><p>Starting your editor…</p></body></html>`)
      }
      return
    }
    // ────────────────────────────────────────────────────────────────────────

    // ── IDE reverse proxy (cookie-gated fall-through) ────────────────────────
    // Forwards to code-server ONLY when:
    //   1. ideProxyEnabled is true (code-server is confirmed ready), AND
    //   2. the request carries a valid osborn_ide session cookie (primary gate), AND
    //   3. the path is not an agent route (secondary backstop).
    // A missing/invalid cookie means the request came from somewhere other than
    // the /editor door — refuse it so a forgotten agent route is never swallowed.
    if (
      ideProxyEnabled &&
      hasValidIdeCookie(req) &&
      !AGENT_ROUTE_PREFIXES.some(p => url.pathname === p || url.pathname.startsWith(p + '/'))
    ) {
      ideLastProxiedActivity = Date.now()
      const targetUrl = new URL(req.url || '/', IDE_TARGET)
      const options = {
        hostname: '127.0.0.1',
        port: 8300,
        path: targetUrl.pathname + (targetUrl.search || ''),
        method: req.method,
        headers: { ...req.headers, host: '127.0.0.1:8300', 'x-forwarded-host': req.headers.host },
      }
      const proxyReq = httpRequest(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers as any)
        proxyRes.pipe(res)
      })
      proxyReq.on('error', () => {
        if (!res.headersSent) { res.writeHead(502); res.end('IDE proxy error') }
      })
      req.pipe(proxyReq)
      return
    }
    // ────────────────────────────────────────────────────────────────────────

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  const host = process.env.HOST || '0.0.0.0'
  server.requestTimeout = 0  // no timeout — large uploads can take minutes
  server.listen(port, host, () => {
    console.log(`🌐 API server listening on http://${host}:${port}`)
    console.log(`   Sessions: http://${host}:${port}/sessions`)
  })

  // Stale upload-chunk cleanup: remove osborn-upload-* dirs older than 30 minutes
  const cleanStaleUploadDirs = () => {
    const tmp = tmpdir()
    const cutoff = Date.now() - 30 * 60 * 1000
    try {
      const entries = readdirSync(tmp)
      for (const entry of entries) {
        if (!entry.startsWith('osborn-upload-')) continue
        const full = `${tmp}/${entry}`
        try {
          const st = statSync(full)
          if (st.isDirectory() && st.mtimeMs < cutoff) {
            rmSync(full, { recursive: true, force: true })
            console.log(`🧹 Removed stale upload dir: ${full}`)
          }
        } catch {
          // ignore per-entry errors
        }
      }
    } catch {
      // ignore if /tmp is unreadable
    }
  }
  cleanStaleUploadDirs()
  setInterval(cleanStaleUploadDirs, 10 * 60 * 1000)



  // WebSocket upgrade handler: forward to code-server when the IDE proxy is
  // active, the request carries a valid osborn_ide session cookie, and the path
  // is not an agent route. code-server's terminal and editor are websocket-heavy
  // — this must work for the integrated terminal to connect.
  // Reject all other upgrades (meeting audio moved to polling in 0.9.xx).
  server.on('upgrade', (req: IncomingMessage, socket, head: Buffer) => {
    const upgradePath = new URL(req.url || '/', `http://localhost`).pathname
    const isAgentRoute = AGENT_ROUTE_PREFIXES.some(p => upgradePath === p || upgradePath.startsWith(p + '/'))
    if (ideProxyEnabled && hasValidIdeCookie(req) && !isAgentRoute) {
      ideLastProxiedActivity = Date.now()
      // code-server's authenticateOrigin() compares Origin against the effective host
      // (X-Forwarded-Host first). changeOrigin:true rewrites Host→127.0.0.1:8300 while the
      // browser's Origin stays the public hostname, causing a 403 → WS 1006. Preserve the
      // real public host so the origin check matches.
      if (!req.headers['x-forwarded-host'] && req.headers.host) {
        req.headers['x-forwarded-host'] = req.headers.host
      }
      wsProxy.ws(req, socket, head, { target: IDE_TARGET })
      return
    }
    socket.destroy()
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`⚠️ API port ${port} in use, trying ${port + 1}...`)
      startApiServer(workingDir, port + 1)
    } else {
      console.error('❌ API server error:', err)
    }
  })
}

// ============================================================
// SESSION CONTEXT HELPERS
// ============================================================

/**
 * Build a context briefing string for the realtime agent
 * Loads session conversation history so the model has deep context.
 * Gemini has smaller context limits — cap at 10 exchanges with 500 char content.
 * OpenAI handles full history (30 exchanges, 2000 char content).
 */

/**
 * Load full session conversation history into the realtime model's ChatContext.
 * This gives the model persistent memory of what was discussed/researched,
 * enabling deeper follow-up conversations without re-delegating to ask_agent.
 *
 * NOTE: Gemini's Live API doesn't support updateChatCtx (crashes with code 1008).
 * For Gemini, the session resume context is already injected via generateReply({ userInput })
 * which becomes part of the conversation history as model turns.
 */
function loadSessionHistoryIntoChatCtx(
  agent: voice.Agent | null,
  history: ConversationExchange[],
  provider?: string
) {
  if (!agent || history.length === 0) return
  // Skip for Gemini — updateChatCtx triggers unsupported operations on Gemini Live API
  if (provider === 'gemini') {
    console.log(`🧠 Skipping ChatCtx load for Gemini (${history.length} exchanges) — context injected via generateReply`)
    return
  }

  try {
    const chatCtx = agent.chatCtx.copy()

    // Inject each conversation exchange as a proper chat message
    for (const exchange of history) {
      chatCtx.addMessage({
        role: exchange.role === 'user' ? 'user' : 'assistant',
        content: exchange.content,
      })
    }

    agent.updateChatCtx(chatCtx)
    console.log(`🧠 Loaded ${history.length} conversation exchanges into ChatCtx (${history.reduce((sum, e) => sum + e.content.length, 0)} chars)`)
  } catch (err) {
    console.log('⚠️ Failed to load session history into ChatCtx:', err)
  }
}


// Main function
async function main() {
  console.log('\n🤖 Osborn Voice AI Coding Assistant\n')

  // Validate environment
  const livekitUrl = process.env.LIVEKIT_URL
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET

  if (!livekitUrl || !apiKey || !apiSecret) {
    console.error('❌ Missing required environment variables:')
    if (!livekitUrl) console.error('   - LIVEKIT_URL')
    if (!apiKey) console.error('   - LIVEKIT_API_KEY')
    if (!apiSecret) console.error('   - LIVEKIT_API_SECRET')
    console.error('\nSet these in your .env file or environment.')
    process.exit(1)
  }

  // Parse CLI args
  const cliArgs = parseArgs()

  // Load configuration
  console.log('📁 Loading configuration...')
  const config = loadConfig()
  const mcpServers = getMcpServers(config)
  const enabledMcpNames = getEnabledMcpServerNames(config)

  if (enabledMcpNames.length > 0) {
    console.log(`🔌 Enabled MCP servers: ${enabledMcpNames.join(', ')}`)
  }

  // Two directory concepts:
  // 1. workingDir (cwd) — where Claude Code operates. Configurable per-session.
  //    Priority: OSBORN_CWD env > config.workingDirectory > process.cwd()
  // 2. sessionBaseDir — where session artifacts live (spec.md, library/).
  //    Always the Osborn agent install directory (where this process started).
  //    This ensures .osborn/sessions/ doesn't scatter across random directories.
  const sessionBaseDir = process.cwd() // Always the Osborn install dir
  // Self-healing fallback: blindly trusting OSBORN_CWD without checking that the directory
  // exists has bitten us in cloud sandboxes where the env var was set to a path that didn't
  // exist (e.g. `/root/workspace` on a daytona/* user). The Claude SDK then fails its spawn
  // call with ENOENT and reports the misleading "Claude Code executable not found" error.
  // Walk the candidate list in priority order and pick the first one that ACTUALLY exists.
  // process.cwd() is the ultimate safety net — it always exists by definition.
  const cwdCandidates: Array<{ source: string; value: string | undefined }> = [
    { source: 'OSBORN_CWD env var', value: process.env.OSBORN_CWD },
    { source: 'config.workingDirectory', value: config.workingDirectory },
    { source: 'process.cwd()', value: process.cwd() },
  ]
  let defaultWorkingDir = process.cwd()
  let cwdSource = 'process.cwd() (last-resort fallback)'
  for (const c of cwdCandidates) {
    if (c.value && existsSync(c.value)) {
      defaultWorkingDir = c.value
      cwdSource = c.source
      break
    }
    if (c.value) {
      console.log(`   ⚠️ ${c.source} = ${c.value} (does not exist, skipping)`)
    }
  }
  let workingDir = defaultWorkingDir
  console.log(`📂 Working directory (cwd): ${workingDir}`)
  console.log(`📂 Session base directory: ${sessionBaseDir}`)
  console.log(`   (cwd from ${cwdSource})`)
  console.log(`🔬 Mode: RESEARCH`)

  // Determine voice mode
  const voiceMode = getVoiceMode(config)
  const realtimeConfig = getRealtimeConfig(config)
  const directConfig = getDirectConfig(config)

  if (voiceMode === 'realtime') {
    console.log(`🎙️ REALTIME MODE: ${realtimeConfig.provider} native speech-to-speech`)
    console.log(`   Voice: ${realtimeConfig.provider === 'openai' ? realtimeConfig.openaiVoice : realtimeConfig.geminiVoice}`)
  } else {
    console.log(`🎯 DIRECT MODE: ${directConfig.stt.provider} STT → Claude Agent SDK → ${directConfig.tts.provider} TTS`)
    console.log('   🔥 Full coding capabilities!')
  }

  // Determine room code. STABLE PER MACHINE, derived from identity we
  // already have: the Fly app name (one app per user). No new storage, no
  // rotation — the same user always lands in the same room, and the room
  // name itself binds to the machine identity. Rotation previously raced
  // any client that fetched /room-code just before a restart (observed
  // 2026-07-28: tester joined osborn-bz2m8n while the rebooted agent created
  // fnz7nz — stuck "Connecting..." forever; idle-exit stop/start cycles made
  // this common). Local/dev fallback: persist a generated code so restarts
  // stay stable there too.
  const identityCode = process.env.FLY_APP_NAME?.replace(/^osborn-/, '') || null
  const roomCodeFile = join(homedir(), '.osborn', 'room-code')
  let persistedRoomCode: string | null = null
  if (!identityCode) {
    try { persistedRoomCode = readFileSync(roomCodeFile, 'utf8').trim() || null } catch { /* first boot */ }
  }
  const roomCode = cliArgs.roomCode || identityCode || persistedRoomCode || generateRoomCode()
  if (!cliArgs.roomCode && !identityCode && roomCode !== persistedRoomCode) {
    try { mkdirSync(dirname(roomCodeFile), { recursive: true }); writeFileSync(roomCodeFile, roomCode) } catch (e) {
      console.warn('⚠️ could not persist room code (rotation race protection disabled):', e instanceof Error ? e.message : e)
    }
  }
  // `roomCode` is the STABLE, identity-derived PREFIX (per machine/user). Under
  // the temporary-rooms architecture (0.9.83) we no longer join ONE fixed room
  // for the machine's life — each user session gets a FRESH, unique room name
  // built by appending a base36 timestamp to this prefix:
  //   osborn-${roomCode}-${Date.now().toString(36)}
  // The stable prefix is preserved purely for log forensics (grep by user).
  // currentRoomCode holds the LAST-CREATED full room NAME so the legacy
  // GET /room-code endpoint keeps working for old frontends during rollout
  // (see note in createRoomSession + the /room-code handler).
  const buildRoomName = () => `osborn-${roomCode}-${Date.now().toString(36)}`

  if (cliArgs.roomCode) {
    console.log(`🔗 Room code prefix: ${roomCode}`)
  } else {
    console.log(`\n✨ Room code prefix: ${roomCode} — each session mints a fresh room osborn-${roomCode}-<ts>\n`)
  }

  // Start HTTP API server for frontend session browsing
  const apiPort = parseInt(process.env.OSBORN_API_PORT || '8741', 10)
  startApiServer(workingDir, apiPort)

  // ============================================================
  // Agent access token — minted FRESH per room session (0.9.83)
  // ============================================================
  // A LiveKit JWT grant is scoped to a specific room name. Since every user
  // session now joins a UNIQUE temporary room (buildRoomName), the token must
  // be minted per room, not once at boot. mintAgentToken(roomName) returns a
  // fresh JWT grant for the given room.
  const mintAgentToken = async (targetRoom: string): Promise<string> => {
    const token = new AccessToken(apiKey, apiSecret, {
      identity: 'osborn-agent',
      name: 'Osborn AI',
      metadata: JSON.stringify({ type: 'agent', version: '0.3.0' }),
    })
    token.addGrant({
      roomJoin: true,
      room: targetRoom,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    })
    return token.toJwt()
  }

  // ============================================================
  // Room session (0.9.83): FRESH Room instance per user session
  // ============================================================
  // rtc-node's Room is single-use: Room.disconnect() ends with
  // removeAllListeners() (room.js:584), wiping EVERY room.on() handler, and its
  // signal-less waitFor + hasCleanedUp reset make a reused Room deaf after any
  // leave/rejoin cycle. So we NEVER reuse a Room after disconnect — instead we
  // create a brand-new Room (with full handler wiring) per session via
  // createRoomSession(), and discard it via destroyRoomSession(). activeRoom is
  // null while the agent is idle (between sessions).
  let activeRoom: Room | null = null
  let activeRoomName: string | null = null  // the temporary room name currently joined

  // Track state
  let pendingSessionClose: Promise<void> | null = null  // Tracks async session close for reconnect safety
  let currentSession: voice.AgentSession | null = null
  // 0.9.81: callable handler reference — see registration site for why.
  let participantConnectedHandler: ((p: RemoteParticipant) => Promise<void>) | null = null
  let currentAgent: voice.Agent | null = null  // For updateChatCtx() context injection
  let currentLLM: ReturnType<typeof createClaudeLLM> | null = null

  // ============================================================
  // SLICE 1: HEADLESS BACKGROUND SESSION REGISTRY
  // Purely additive — zero changes to the focused voice path above.
  // The focused session (currentLLM / currentSession / currentAgent /
  // activeRoom) is untouched by everything below.
  // ============================================================
  interface SessionSlot {
    id: string
    llm: ReturnType<typeof createClaudeLLM>
    isFocused: boolean
    workingDir: string
  }
  const slots = new Map<string, SessionSlot>()
  let focusedSlotId: string | null = null  // reserved for future focused-slot wiring; not used yet

  // Agent-side "alone in room" leave timer (see Room-presence lifecycle note up
  // top). Armed in ParticipantDisconnected once a user has left; if no one
  // rejoins within the grace window the agent leaves LiveKit on its own.
  // Cancelled in ParticipantConnected. 3 min: long enough to ride out a brief
  // reconnect (page refresh, network blip), short enough that a forgotten
  // session costs ~3 min of connection-minutes instead of hours.
  let aloneTimer: ReturnType<typeof setTimeout> | null = null
  const ALONE_GRACE_MS = 3 * 60 * 1000

  // Arm (or re-arm) the alone timer: if no remote participant is present, leave
  // the LiveKit room after the grace window. Called on Connected (covers a
  // machine woken but then abandoned before the user joined) and on
  // ParticipantDisconnected (covers a finished session). Cancelled the moment a
  // user joins. Net invariant: the agent never holds an empty room beyond
  // ALONE_GRACE_MS, in any scenario — the root cause of the 25h burn.
  const armAloneTimer = () => {
    if (aloneTimer) clearTimeout(aloneTimer)
    aloneTimer = null
    if (!activeRoom || activeRoom.remoteParticipants.size > 0) return
    aloneTimer = setTimeout(() => {
      aloneTimer = null
      if (activeRoom && activeRoom.remoteParticipants.size === 0 && livekitState.status === 'connected') {
        console.log(`🕊️ Alone in room ${ALONE_GRACE_MS / 1000}s — destroying room session to stop connection-minute burn`)
        intentionalLeave = true
        // Fresh-Room-per-session (0.9.83): tear down + discard the instance
        // rather than room.disconnect() on a reused Room.
        destroyRoomSession('alone-timer').catch((e) => console.error('alone-leave destroyRoomSession failed:', e))
      }
    }, ALONE_GRACE_MS)
  }

  // 0.9.83: Fast tab-close leave. When a real session ENDS (user left / closed
  // the tab), LiveKit has already dropped that participant server-side, so we
  // don't need the full 3-min alone grace — free the room in ~20s. A short
  // grace still rides out a quick refresh/rejoin. This shrinks the "ghost
  // participant" window that compounds room churn; the 3-min alone-timer
  // remains for the woken-but-never-joined case (armed on connect).
  let fastLeaveTimer: ReturnType<typeof setTimeout> | null = null
  const POST_LEAVE_GRACE_MS = 20 * 1000
  const armFastLeaveTimer = () => {
    if (fastLeaveTimer) clearTimeout(fastLeaveTimer)
    fastLeaveTimer = null
    if (!activeRoom || activeRoom.remoteParticipants.size > 0) return
    fastLeaveTimer = setTimeout(() => {
      fastLeaveTimer = null
      if (activeRoom && activeRoom.remoteParticipants.size === 0 && livekitState.status === 'connected') {
        console.log(`🚪 Room empty ${POST_LEAVE_GRACE_MS / 1000}s after session end (tab close / leave) — destroying room session`)
        intentionalLeave = true
        destroyRoomSession('fast-leave').catch((e) => console.error('fast-leave destroyRoomSession failed:', e))
      }
    }, POST_LEAVE_GRACE_MS)
  }
  const cancelFastLeaveTimer = () => { if (fastLeaveTimer) { clearTimeout(fastLeaveTimer); fastLeaveTimer = null } }

  // ── 0.9.73: Idle machine self-stop (the $123 Fly bill fix) ──
  // After an intentional alone-leave the agent used to sit "idle, awaiting
  // /connect-room" forever — process alive, Fly machine `started`, billing
  // performance-2x 24/7 (~$62/mo). Confirmed twice: room osborn-3h6htr held
  // a zombie WS Jun 18→22 (5,700+ min "In progress" on the LiveKit dashboard),
  // and the July invoice ($123.61) showed two 4GB machines running the whole
  // cycle. The machine's restart policy is `on-failure`, so `process.exit(0)`
  // cleanly STOPS the machine (billing stops, volume + JSONL persist) while
  // crashes still auto-restart. The frontend's startSandbox() boots a stopped
  // machine on the next Resume, so warm-idle buys nothing but cost.
  //
  // Armed when livekitState.status flips to 'idle' (intentional leave), and by
  // the zombie watchdog below. Cancelled implicitly: before exiting we re-check
  // that we're still idle/disconnected — any /connect-room in the window aborts.
  // Local dev (no FLY_APP_NAME) never exits. Override with OSBORN_IDLE_EXIT=0.
  const IDLE_EXIT_GRACE_MS = 15 * 60 * 1000  // 15 min (0.9.120, user directive): rides out setup gaps — user returning, opening the Meet, admitting the bot — before the machine self-stops. Was 10 min, which cold-stopped the test machine between sessions.
  let idleExitTimer: ReturnType<typeof setTimeout> | null = null
  const armIdleExitTimer = (reason: string) => {
    if (!process.env.FLY_APP_NAME || process.env.OSBORN_IDLE_EXIT === '0') return
    if (idleExitTimer) clearTimeout(idleExitTimer)
    console.log(`⏻ [IDLE-EXIT] armed (${IDLE_EXIT_GRACE_MS / 60000} min) — reason: ${reason}`)
    idleExitTimer = setTimeout(() => {
      idleExitTimer = null
      const stillIdle = livekitState.status === 'idle' || livekitState.status === 'failed'
      const empty = !activeRoom || activeRoom.remoteParticipants.size === 0
      if (stillIdle && empty) {
        console.log(`⏻ [IDLE-EXIT] still idle after grace — exiting 0 so Fly stops the machine (billing stops; next Resume boots it)`)
        // Give the log tee a beat to flush, then stop the machine.
        setTimeout(() => process.exit(0), 2000)
      } else {
        console.log(`⏻ [IDLE-EXIT] aborted — status=${livekitState.status} participants=${activeRoom?.remoteParticipants.size ?? 0}`)
      }
    }, IDLE_EXIT_GRACE_MS)
  }
  const cancelIdleExitTimer = () => {
    if (idleExitTimer) {
      clearTimeout(idleExitTimer)
      idleExitTimer = null
      console.log('⏻ [IDLE-EXIT] cancelled — activity resumed')
    }
  }

  // ── 0.9.83: Zombie-presence watchdog + event-loss adopter DELETED ──
  // Both poll-based layers existed solely to compensate for Room-reuse damage:
  //   • zombie-watchdog: RoomEvent callbacks stopped firing after a leave/rejoin
  //     cycle because Room.disconnect() had already run removeAllListeners()
  //     (room.js:584), so even real disconnects went unobserved.
  //   • adopt-poll: ParticipantConnected stopped being delivered on a reused
  //     Room for the same reason.
  // Under fresh-Room-per-session (createRoomSession / destroyRoomSession) the
  // event stream is trustworthy again — every session gets a Room with freshly
  // wired handlers, and we NEVER reuse a Room after disconnect. The legitimate
  // race the adopt-poll also covered (a participant already in the room at join
  // time, who fires no ParticipantConnected event) is now handled once, at the
  // right moment, by the adopt-sweep inside createRoomSession(). The idle-exit
  // timer (above) remains as the billing backstop.

  /**
   * Hard-kill the in-flight Claude SDK query AND the persistent subprocess.
   *
   * Why this exists: the persistent ClaudeLLM session is deliberately kept alive
   * across user messages to avoid JSONL replay (see CLAUDE.md "Persistent Session
   * Architecture"). When the participant disconnects, simply nulling `currentLLM`
   * drops the JS reference but does NOT kill the underlying Claude Code subprocess
   * — the SDK keeps draining the MessageChannel, running tools, and pushing TTS
   * calls into a now-null voice session. Visible in logs as repeated:
   *   "⚠️ tts_say fired but currentSession is null — text dropped"
   * followed by orphaned `🔧 Claude: Bash` calls and `📍 Checkpoint captured` lines
   * that nobody is listening to. Wasted compute, wasted tokens, possible side effects.
   *
   * The right cleanup is `abortQuery()` (on ClaudeLLM directly) or `abortAgent()`
   * (on PipelineDirectLLM, which wraps ClaudeLLM). They both call into
   * `closeSession()` → kills the subprocess. We duck-type to handle both class
   * shapes since `currentLLM` can hold either, depending on voice mode.
   */
  function killCurrentLLM(reason: string): void {
    if (!currentLLM) return
    try {
      const llm = currentLLM as any
      // Heap-OOM fix (2026-06-02): stop the PipelineDirectLLM summary-index
      // watcher BEFORE we abort + drop the reference. The watcher is a 10s
      // setInterval whose closure retains the entire PipelineDirectLLM →
      // ClaudeLLM object graph. killCurrentLLM is the single chokepoint all
      // three cleanup sites (Disconnected, previous-session-cleanup,
      // ParticipantDisconnected) call, but it previously only aborted the
      // SDK subprocess — leaving the interval (and the whole graph) alive and
      // uncollectable on every disconnect/reconnect. A reconnect-heavy session
      // (e.g. 15 reconnects from a frontend redeploy) leaked 15 timers + 15
      // retained graphs, each re-reading JSONL every 10s, until the node heap
      // OOM'd (~980MB) and the process crashed. Stopping the watcher here lets
      // the abandoned graph be GC'd. Duck-typed: only PipelineDirectLLM has it.
      if (typeof llm.stopIndexWatcher === 'function') {
        llm.stopIndexWatcher()
      }
      if (typeof llm.abortQuery === 'function') {
        llm.abortQuery()
      } else if (typeof llm.abortAgent === 'function') {
        llm.abortAgent()
      } else {
        console.warn(`⚠️ killCurrentLLM(${reason}): no abort method on currentLLM`)
      }
    } catch (err) {
      console.error(`❌ killCurrentLLM(${reason}) failed:`, err instanceof Error ? err.message : err)
    }
  }

  // ============================================================
  // SLICE 1: spawnBackgroundSession
  // Creates a fully headless ClaudeLLM subprocess that resumes an
  // existing session.  No AgentSession, no room, no TTS/voice.
  // Output events are forwarded to the frontend data channel only,
  // tagged with the slot id so the frontend can distinguish them.
  // ============================================================
  async function spawnBackgroundSession(sessionId: string, bgWorkingDir?: string): Promise<void> {
    // Hard cap: focused session + background slots must not exceed 3 total.
    // slots Map holds ONLY background slots; focused session is separate.
    if (slots.size >= 2) {
      const msg = `Background session cap reached (${slots.size}/2 slots in use). Kill an existing background slot before spawning a new one.`
      console.warn(`⚠️ spawnBackgroundSession: ${msg}`)
      await sendToFrontend({ type: 'background_session_error', slotId: sessionId, error: msg })
      return
    }

    const slotWorkingDir = bgWorkingDir || workingDir
    const slotId = sessionId  // use sessionId as the slot id for traceability

    console.log(`🔲 Spawning background slot: sessionId=${slotId.substring(0, 8)} cwd=${slotWorkingDir}`)

    // Create a headless LLM instance — reuse the same factory, no voice options.
    // permissionMode bypassPermissions: no dialogs (headless — nobody to click Allow).
    // No AgentSession, no room involvement.
    const bgLLM = createClaudeLLM({
      workingDirectory: slotWorkingDir,
      sessionBaseDir: slotWorkingDir,
      resumeSessionId: sessionId,
      voiceMode: 'direct',           // picks up the research system prompt
      skipTTSQueue: false,           // not going through TTS at all
      permissionMode: 'bypassPermissions',
    })

    // Register slot BEFORE cold-starting so list_slots is accurate from the
    // first moment even if the subprocess takes a few seconds to init.
    const slot: SessionSlot = { id: slotId, llm: bgLLM, isFocused: false, workingDir: slotWorkingDir }
    slots.set(slotId, slot)

    // Dedicated EventEmitter for this background slot's SDK events.
    // Forwards every event to the frontend data channel tagged with slotId.
    // NEVER touches session.say() / TTS / voice.
    const { EventEmitter: SlotEventEmitter } = await import('node:events')
    const bgEmitter = new SlotEventEmitter()

    bgEmitter.on('assistant_text', ({ text }: { text: string }) => {
      sendToFrontend({ type: 'claude_output', slotId, text }).catch(() => {})
    })
    bgEmitter.on('tool_use', ({ name, input, agentRole }: any) => {
      sendToFrontend({ type: 'tool_use', slotId, name, input, agentRole }).catch(() => {})
    })
    bgEmitter.on('tool_result', ({ name, response, agentRole }: any) => {
      sendToFrontend({ type: 'tool_result', slotId, name, response, agentRole }).catch(() => {})
    })
    bgEmitter.on('tool_blocked', ({ name, reason }: any) => {
      sendToFrontend({ type: 'tool_blocked', slotId, name, reason }).catch(() => {})
    })
    bgEmitter.on('session_id', ({ sessionId: sid }: { sessionId: string }) => {
      sendToFrontend({ type: 'background_session_ready', slotId, sessionId: sid }).catch(() => {})
    })
    bgEmitter.on('session_resume_failed', ({ requestedSessionId, actualSessionId }: any) => {
      console.error(`❌ Background slot ${slotId.substring(0, 8)}: resume failed — requested ${requestedSessionId?.substring(0, 8)} got ${actualSessionId?.substring(0, 8)}`)
      sendToFrontend({ type: 'background_session_error', slotId, error: 'Session resume failed' }).catch(() => {})
    })
    // Wire up the LLM's internal EventEmitter so hook-emitted events also flow.
    bgLLM.events.on('session_id', (data: any) => bgEmitter.emit('session_id', data))
    bgLLM.events.on('tool_blocked', (data: any) => bgEmitter.emit('tool_blocked', data))

    // Build minimal sdkOptions for the headless cold start.
    // resume: sessionId brings up real prior context from JSONL.
    // env: CLAUDE_CODE_DISABLE_AUTO_MEMORY prevents concurrent subprocesses
    // from racing the shared ~/.claude/CLAUDE.md memory file.
    // CLAUDE_CONFIG_DIR is intentionally NOT overridden — shared config is fine.
    const bgEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) bgEnv[k] = v
    }
    bgEnv['CLAUDE_CODE_DISABLE_AUTO_MEMORY'] = '1'

    const bgSdkOptions = {
      cwd: slotWorkingDir,
      resume: sessionId,
      permissionMode: 'bypassPermissions' as const,
      enableFileCheckpointing: false,
      settingSources: ['project', 'user'] as any,
      env: bgEnv,
    }

    // Cold-start: deliver an init message so the subprocess actually spawns
    // and begins consuming the session JSONL.
    const KICKOFF_TEXT = '[BACKGROUND_INIT] You have been resumed in headless background mode. No voice session is active. Acknowledge receipt with a single brief line.'

    bgLLM.pushMessage(KICKOFF_TEXT, bgSdkOptions as any, {
      onSessionId: (sid: string) => {
        console.log(`✅ Background slot ${slotId.substring(0, 8)}: session confirmed ${sid.substring(0, 8)}`)
        bgEmitter.emit('session_id', { sessionId: sid })
      },
      onCheckpoint: (_ckpt: string) => { /* not needed for headless */ },
      eventEmitter: bgEmitter,
    })

    console.log(`✅ Background slot registered: id=${slotId.substring(0, 8)} workingDir=${slotWorkingDir}`)
    await sendToFrontend({ type: 'background_session_spawned', slotId, workingDir: slotWorkingDir })
  }

  let localParticipant: LocalParticipant | null = null
  let agentState = 'initializing'
  // Session-level always-allow list: paths the user has approved for this session without prompting
  let sessionAlwaysAllowPaths = new Set<string>()
  let userState = 'listening'  // Track user speech state for queue safety
  let currentVoiceMode: VoiceMode = voiceMode  // Track active voice mode for data handlers
  let currentProvider: string = realtimeConfig.provider  // Track active realtime provider
  // Authenticated Supabase userId from participant metadata. Used to scope
  // workspace artifact uploads to the owner's prefix in Supabase Storage.
  // Empty string = anonymous / unauthenticated; uploads fall back to a
  // session-only path (no user prefix).
  let currentUserId: string = ''
  // Per-user named agents (DB-backed) — sent by the frontend via set_agents
  // after agent_ready. Kept here so agent-side LLM recreations (session
  // switch/resume) reuse them without waiting for a frontend resend. Merged
  // OVER the built-in NAMED_AGENTS (same-name user rows shadow built-ins).
  let userNamedAgents: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }> | null = null
  // Built-ins the user has removed (tombstoned in user_agents with enabled=false).
  // A removed built-in disappears from the effective set but stays re-addable
  // from the frontend's "Available to add" list — default agents are never
  // gone forever, matching the skill-catalog pattern.
  let userRemovedAgents: string[] = []

  let activeMeetingBotId: string | null = null  // Recall.ai bot ID if in a meeting
  // While set (Date.now() < value), the agent's streaming tts_say output is
  // REDIRECTED into the meeting canvas instead of suppressed — the regular
  // voice pipeline reused with the meeting as the sink (latency fix).
  let meetingAddressedUntil = 0
  // True while the meeting-canvas page is connected to the LiveKit room as a
  // listener (browser-parity audio path). When set, meeting replies use the
  // NORMAL session.say pipeline — no suppression, no redirect, no synth chain.
  let meetingCanvasInRoom = false
  // Distinct human speakers seen in the current meeting. In a 1:1 (one human
  // + the bot) EVERY utterance is addressed to the bot — no name needed
  // (2026-08-01: "can you open carfax..." got observer-suppressed because
  // the fresh session's latch was never opened by the name).
  const meetingSpeakers = new Set<string>()
  let activeMeetingPoller: MeetingTranscriptPoller | null = null  // Transcript poller bound to that bot

  // ── IDE (code-server) state ──────────────────────────────────────────────
  // All fields reset together in stopIde(). Never auto-started; only spawned
  // by an explicit start_ide data-channel command from the frontend.
  // Cloudflared is gone — exposure is via the agent's own HTTP server proxy
  // (ideProxyEnabled at module scope, set/cleared by start_ide/stopIde).
  let ideCodeServerProc: ReturnType<typeof spawn> | null = null
  let ideLastActivity: number = 0  // bumped on code-server stdout/stderr
  let ideIdleWatcher: ReturnType<typeof setInterval> | null = null
  // In-flight start promise: set for the duration of startCodeServer()'s async
  // body, cleared in its finally. Concurrent callers (e.g. /editor page refreshes
  // every 3s) return early instead of killing the process that is still booting.
  let ideStartInProgress: Promise<void> | null = null
  // ────────────────────────────────────────────────────────────────────────

  // LIVE meeting transcript → LLM (buffered webhook finals). See recall.on('transcript').
  const meetingTranscriptBuffer: string[] = []
  let meetingFlushTimer: ReturnType<typeof setInterval> | null = null
  // Flush the buffered meeting turns to the LLM. `addressed=true` (the agent was
  // called by name / asked directly) tags the message so the agent RESPONDS by
  // speaking into the meeting; otherwise it's a silent-observer note-taking batch.
  const flushMeetingBuffer = (botId: string, addressed = false) => {
    if (!meetingTranscriptBuffer.length || !currentLLM) return
    const turns = meetingTranscriptBuffer.splice(0) // drain
    if (addressed) {
      // REUSE the regular voice pipeline (2026-08-01 latency fix): during an
      // addressed turn the agent's normal streaming tts_say output is REDIRECTED
      // to the canvas (see the tts_say handler) — same speak path as regular
      // mode, sink = meeting. The old prompt made the agent compose a Bash curl
      // (extra LLM tool roundtrip, ate the 3-call budget, sometimes lost the
      // reply entirely) — measured as most of the 5-8s reply lag.
      // ONCE ADDRESSED, STAY CONVERSATIONAL (2026-08-01 fix): the old 90s
      // window silently ATE every reply generated after it expired — the agent
      // kept "answering" into suppression while the room heard nothing
      // (user transcript full of unheard replies; direct /canvas say test WAS
      // heard). A participant who's been spoken to stays in the conversation;
      // observer restraint comes from the skill not generating chatter, not
      // from muting the audio path. Reset by endMeeting.
      meetingAddressedUntil = Date.now() + 6 * 60 * 60 * 1000
    }
    // NO meeting-specific reply coaching (user directive 2026-08-04): the reply
    // must be exactly what the main Claude Code agent would say — no brevity
    // rules, no "spoken out loud" framing. Just a bare [MEETING — id] routing
    // tag, which is all the plumbing needs: PipelineDirectLLM keys
    // suppressMeetingTTS off the `[MEETING` prefix, and whether the reply is
    // SPOKEN is decided in CODE (activeMeetingBotId + meetingAddressedUntil),
    // not by any prompt instruction. Addressed vs observer is the code boolean.
    const header = `[MEETING — ${botId}]:`
    // Prepend + consume any interruption context (bot was cut off mid-sentence).
    const interrupt = meetingInterruptContext ? `${meetingInterruptContext}\n` : ''
    meetingInterruptContext = ''
    try {
      const ctx = new llm.ChatContext()
      ctx.addMessage({ role: 'user', content: `${interrupt}${header}\n${turns.join('\n')}` })
      currentLLM.chat({ chatCtx: ctx })
      console.log(`📓 Flushed ${turns.length} meeting turn(s) to LLM${addressed ? ' (ADDRESSED — respond)' : ''}`)
    } catch (err) {
      console.warn(`⚠️ Meeting flush failed: ${(err as Error).message}`)
    }
  }
  const startMeetingFlush = (botId: string) => {
    stopMeetingFlush()
    console.log(`📓 Meeting transcript flush timer started (bot ${botId}, 20s)`)
    meetingFlushTimer = setInterval(() => flushMeetingBuffer(botId, false), 20_000)
  }
  const stopMeetingFlush = () => {
    if (meetingFlushTimer) { clearInterval(meetingFlushTimer); meetingFlushTimer = null; console.log('📓 Meeting flush timer stopped') }
    if (addressedFlushTimer) { clearTimeout(addressedFlushTimer); addressedFlushTimer = null }
    meetingTranscriptBuffer.length = 0
  }
  // TURN-DEBOUNCED addressed flush (0.9.121): Recall closes a transcript
  // segment on every pause, so flushing on each final made the bot reply to
  // FRAGMENTS mid-thought (and multiple times per utterance). Instead we
  // debounce: each new transcript final resets a short timer; we only flush
  // (= reply) after the speaker has actually paused, so one turn = one reply.
  // speech_off (a hard silence boundary) can flush sooner via a smaller delay.
  let addressedFlushTimer: ReturnType<typeof setTimeout> | null = null
  const ADDRESSED_DEBOUNCE_MS = 1400
  const scheduleAddressedFlush = (botId: string, delayMs: number = ADDRESSED_DEBOUNCE_MS) => {
    if (addressedFlushTimer) clearTimeout(addressedFlushTimer)
    addressedFlushTimer = setTimeout(() => {
      addressedFlushTimer = null
      if (!meetingTranscriptBuffer.length) return
      // A fresh human turn supersedes anything the bot was still saying about
      // the previous one — interrupt stale queued/playing speech before we reply.
      interruptMeetingSpeech('new addressed turn')
      flushMeetingBuffer(botId, true)
    }, delayMs)
  }

  // ── Meeting lifecycle (centralized teardown, 0.9.95) ──
  // The bot's lifecycle FOLLOWS the voice session (deliberate coupling — a
  // decoupled always-on bot means untracked background agents; revisit only
  // with a status/tracking UI). endMeeting() is the single teardown path,
  // fired by: (a) explicit leave_meeting, (b) user disconnect (auto-leave),
  // (c) Recall reporting a terminal bot status (call_ended/done/fatal —
  // detected on the poller's 30s tick; fixes stale bot state when the meeting
  // ends naturally), or (d) the max-duration backstop below.
  const MEETING_MAX_MS = Math.max(10, Number(process.env.OSBORN_MEETING_MAX_MIN) || 180) * 60 * 1000  // default 3h
  let meetingMaxTimer: ReturnType<typeof setTimeout> | null = null
  const endMeeting = async (reason: string, opts: { leaveBot?: boolean } = {}): Promise<void> => {
    const botId = activeMeetingBotId
    if (!botId) return
    console.log(`🏁 Meeting ended (${reason}) — bot ${botId}`)
    // Stop inputs FIRST so no more chunks land mid-teardown.
    stopMeetingFlush()
    if (activeMeetingPoller) { activeMeetingPoller.stop(); activeMeetingPoller = null }
    if (meetingMaxTimer) { clearTimeout(meetingMaxTimer); meetingMaxTimer = null }
    if (meetingLeaveGraceTimer) { clearTimeout(meetingLeaveGraceTimer); meetingLeaveGraceTimer = null }
    activeMeetingBotId = null
    meetingAddressedUntil = 0
    meetingSpeakers.clear()
    // leaveBot=false when Recall itself reported the meeting over (bot already gone).
    if (opts.leaveBot !== false) {
      const recall = getRecallClient()
      if (recall) await recall.leaveMeeting(botId).catch((e: any) => console.warn(`⚠️ leaveMeeting failed: ${e?.message}`))
    }
    sendToFrontend({ type: 'meeting_left', botId, reason }).catch(() => {})
    // Orphan cleanup: if no user is connected, the LLM subprocess was kept alive
    // solely to serve the meeting — release it now and let idle-exit stop the
    // machine (same billing discipline as 0.9.73, deferred until meeting end).
    const userPresent = activeRoom && activeRoom.remoteParticipants.size > 0
    if (!userPresent && currentLLM) {
      console.log('🏁 Meeting over with no user connected — releasing LLM + arming idle-exit')
      killCurrentLLM(`meeting_ended(${reason})_no_user`)
      currentLLM = null
      clearFastBrainSession()
      clearPipelineFastBrainSession()
      armIdleExitTimer(`meeting ended (${reason}), no user`)
    }
  }
  // WiFi-blip grace: a TRANSIENT participant drop must not kill the meeting
  // (observed 2026-08-01: LiveKit WS blip → user_disconnected → bot left
  // within seconds while the user rejoined moments later). Arm a grace timer
  // instead; a rejoin inside the window cancels it. The deliberate coupling
  // (bot follows the voice session) survives — it just tolerates blips.
  const MEETING_LEAVE_GRACE_MS = 75_000
  let meetingLeaveGraceTimer: ReturnType<typeof setTimeout> | null = null
  const armMeetingLeaveGrace = () => {
    if (!activeMeetingBotId || meetingLeaveGraceTimer) return
    console.log(`🏁 Meeting leave-grace armed (${MEETING_LEAVE_GRACE_MS / 1000}s) — bot stays unless the user is really gone`)
    meetingLeaveGraceTimer = setTimeout(() => {
      meetingLeaveGraceTimer = null
      const userPresent = activeRoom && activeRoom.remoteParticipants.size > 0
      if (activeMeetingBotId && !userPresent) void endMeeting('user_disconnected_grace_expired')
    }, MEETING_LEAVE_GRACE_MS)
  }
  const cancelMeetingLeaveGrace = () => {
    if (meetingLeaveGraceTimer) {
      clearTimeout(meetingLeaveGraceTimer)
      meetingLeaveGraceTimer = null
      console.log('🏁 Meeting leave-grace cancelled — user is back')
    }
  }

  const armMeetingMaxTimer = (botId: string) => {
    if (meetingMaxTimer) clearTimeout(meetingMaxTimer)
    console.log(`⏲️ Meeting max-duration backstop armed: ${MEETING_MAX_MS / 60000} min (override OSBORN_MEETING_MAX_MIN)`)
    meetingMaxTimer = setTimeout(() => {
      meetingMaxTimer = null
      if (activeMeetingBotId === botId) {
        console.log('⏲️ Meeting max duration reached — auto-leaving (backstop, not Recall-reported end)')
        void endMeeting('max_duration_backstop')
      }
    }, MEETING_MAX_MS)
  }

  // ── IDE helpers ─────────────────────────────────────────────────────────

  // ensureCodeServer() — idempotent: installs code-server if missing.
  // Cloudflared is no longer downloaded here (exposure via agent's own HTTP proxy).
  // Emits ide_status:'installing' before any long download so the frontend can
  // show a spinner. (~36s + ~740MB first run, once per machine lifetime).
  const ensureCodeServer = async (): Promise<void> => {
    // Resolve code-server binary
    const which = await new Promise<string>((res) => {
      const p = spawn('which', ['code-server'])
      let out = ''
      p.stdout?.on('data', (d: Buffer) => { out += d.toString() })
      p.on('close', () => res(out.trim()))
    })
    if (!which) {
      await sendToFrontend({ type: 'ide_status', status: 'installing' })
      console.log('⬇️ Installing code-server via official script...')
      await new Promise<void>((res, rej) => {
        const install = spawn('sh', ['-c', 'curl -fsSL https://code-server.dev/install.sh | sh'], {
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        install.stdout?.on('data', (d: Buffer) => process.stdout.write(d))
        install.stderr?.on('data', (d: Buffer) => process.stderr.write(d))
        install.on('close', (code) => code === 0 ? res() : rej(new Error(`code-server install exited ${code}`)))
      })
    }
  }

  // Kill code-server, disable proxy, clear interval, reset IDE state.
  const stopIde = (reason?: string) => {
    // Bump the generation counter so any in-flight startCodeServer() knows it
    // has been cancelled and must not re-enable the proxy or mint a new token.
    ideStartGeneration++
    ideProxyEnabled = false
    ideSessionToken = null
    ideStartInProgress = null
    if (ideIdleWatcher) { clearInterval(ideIdleWatcher); ideIdleWatcher = null }
    if (ideCodeServerProc) {
      try { ideCodeServerProc.kill() } catch {}
      ideCodeServerProc = null
    }
    ideLastActivity = 0
    ideLastProxiedActivity = 0
    const msg: Record<string, string> = { type: 'ide_stopped' }
    if (reason) msg.reason = reason
    sendToFrontend(msg).catch(() => {})
    console.log(`🛑 IDE stopped${reason ? ` (${reason})` : ''}`)
  }

  // Idle watcher: poll every 60s; stop IDE if no proxied HTTP/WS activity
  // within the threshold. Uses ideLastProxiedActivity (real editor traffic seen
  // by the agent's proxy) as the primary signal — more reliable than log noise
  // on code-server's stdout/stderr. Falls back to ideLastActivity (process output)
  // if no proxied activity has ever been recorded (pre-first-browser-open).
  const startIdeIdleWatcher = () => {
    if (ideIdleWatcher) { clearInterval(ideIdleWatcher); ideIdleWatcher = null }
    const idleMinutes = Math.max(1, parseInt(process.env.OSBORN_IDE_IDLE_MIN || '10', 10))
    const idleMs = idleMinutes * 60 * 1000
    ideIdleWatcher = setInterval(() => {
      if (!ideCodeServerProc) { clearInterval(ideIdleWatcher!); ideIdleWatcher = null; return }
      // Prefer proxied-activity timestamp; fall back to process output timestamp.
      const lastSeen = ideLastProxiedActivity > 0 ? ideLastProxiedActivity : ideLastActivity
      const elapsed = Date.now() - lastSeen
      if (elapsed > idleMs) {
        console.log(`⏱️ IDE idle for ${Math.round(elapsed / 60000)} min — stopping`)
        stopIde('idle')
      }
    }, 60_000)
  }

  // ── startCodeServer() ───────────────────────────────────────────────────────
  // Shared helper called by both the start_ide data-channel handler and the
  // GET /editor HTTP route. Idempotent: no-op if code-server is already running
  // and the proxy is enabled. On fresh start it:
  //   1. ensureCodeServer() — installs if missing
  //   2. probes --idle-timeout-seconds flag support
  //   3. spawns code-server on 127.0.0.1:8300 with --auth none, cwd /workspace
  //   4. polls until ready (up to 20 s)
  //   5. mints ideSessionToken (the cookie marker) and sets ideProxyEnabled = true
  const startCodeServer = async (): Promise<void> => {
    // Fast path 1: already fully up — nothing to do.
    if (ideCodeServerProc && ideProxyEnabled) {
      console.log('🖥️ IDE already running — reusing existing instance')
      return
    }
    // Fast path 2: a start is already in progress — join it instead of killing
    // the process that is still booting (prevents the /editor 3s-refresh self-DoS).
    if (ideStartInProgress) {
      console.log('🖥️ IDE start already in progress — awaiting in-flight promise')
      return ideStartInProgress
    }

    // Fresh start: kill any stale proc (shouldn't normally exist here, but be safe).
    if (ideCodeServerProc) stopIde()

    // Capture the current generation AFTER any preceding stopIde() call so that
    // if stopIde() already ran (above), myGen reflects the incremented counter.
    // A concurrent stopIde() after this point will increment ideStartGeneration
    // beyond myGen, signalling cancellation to the poll loop and success branch.
    const myGen = ideStartGeneration

    let resolveFn!: () => void
    let rejectFn!: (err: unknown) => void
    ideStartInProgress = new Promise<void>((res, rej) => { resolveFn = res; rejectFn = rej })

    try {
    await ensureCodeServer()

    // Probe whether this code-server version supports --idle-timeout-seconds
    // (landed ~Oct 2025; older installs predate it). Only pass the flag if
    // the binary reports it — an unknown flag prevents code-server from starting.
    const idleMinutes = Math.max(1, parseInt(process.env.OSBORN_IDE_IDLE_MIN || '10', 10))
    const idleSeconds = idleMinutes * 60
    const supportsIdleFlag = await new Promise<boolean>((res) => {
      const h = spawn('sh', ['-c', 'code-server --help 2>&1 | grep -q idle-timeout-seconds && echo yes || echo no'], {
        env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      h.stdout?.on('data', (d: Buffer) => { out += d.toString() })
      h.on('close', () => res(out.trim() === 'yes'))
    })
    console.log(`🖥️ code-server idle-timeout-seconds flag: ${supportsIdleFlag ? 'supported' : 'absent (using watcher)'}`)

    // Spawn code-server bound to 127.0.0.1:8300 (never 8741).
    console.log('🖥️ Spawning code-server on 127.0.0.1:8300...')
    const csArgs: string[] = [
      '--bind-addr', '127.0.0.1:8300',
      '--auth', 'none',
      '/workspace',
    ]
    if (supportsIdleFlag) {
      csArgs.push('--idle-timeout-seconds', String(Math.max(60, idleSeconds)))
    }
    const codeServerProc = spawn('code-server', csArgs, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    ideCodeServerProc = codeServerProc
    ideLastActivity = Date.now()
    ideLastProxiedActivity = 0

    // Bump lastActivity on any output from code-server (fallback idle signal).
    codeServerProc.stdout?.on('data', () => { ideLastActivity = Date.now() })
    codeServerProc.stderr?.on('data', () => { ideLastActivity = Date.now() })
    codeServerProc.on('exit', (code) => {
      console.log(`🖥️ code-server exited (${code})`)
      if (ideCodeServerProc === codeServerProc) stopIde()
    })

    // Poll until code-server is ready (302 or 200 on the root, up to 20s).
    // Minor fix: if the process we spawned has been replaced or killed mid-poll,
    // reject immediately rather than burning the rest of the 20s timeout.
    await new Promise<void>((res, rej) => {
      let attempts = 0
      const poll = setInterval(() => {
        // Early-exit: stopIde() was called while we were waiting (generation bumped),
        // OR the proc we spawned is no longer the active one for another reason.
        // Either way, cancel the poll immediately so we don't keep hitting 8300
        // for a boot that has already been invalidated.
        if (ideStartGeneration !== myGen || ideCodeServerProc !== codeServerProc) {
          clearInterval(poll)
          rej(new Error('code-server start cancelled (stopIde ran mid-poll)'))
          return
        }
        attempts++
        const check = spawn('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:8300'])
        let out = ''
        check.stdout?.on('data', (d: Buffer) => { out += d.toString() })
        check.on('close', () => {
          const httpCode = parseInt(out.trim(), 10)
          if (httpCode === 200 || httpCode === 302 || httpCode === 301) {
            clearInterval(poll)
            res()
          } else if (attempts >= 40) { // 40 * 500ms = 20s
            clearInterval(poll)
            rej(new Error('code-server did not become ready within 20s'))
          }
        })
      }, 500)
    })
    console.log('✅ code-server ready on 8300')

    // Generation guard: check again right before enabling the proxy. The poll
    // already checks this on each tick, but there is a narrow window between the
    // last tick resolving and reaching here. If stopIde() ran in that window,
    // ideStartGeneration will have been incremented beyond myGen — we must NOT
    // enable the proxy or mint a token, and we must kill the orphan process so
    // no zombie code-server is left running with no participant present.
    if (ideStartGeneration !== myGen) {
      console.log('🖥️ IDE start cancelled (stopIde ran while code-server was booting) — killing orphan proc')
      try { codeServerProc.kill() } catch {}
      // ideCodeServerProc may already be null (stopIde cleared it); only null it
      // if it still points to our proc to avoid clobbering a newer start.
      if (ideCodeServerProc === codeServerProc) ideCodeServerProc = null
      resolveFn()   // resolve (not reject) so the promise chain exits cleanly
      return
    }

    // Mint the session cookie token and enable the proxy. From this point the
    // /editor route will 302+Set-Cookie and the fall-through proxy will only
    // forward requests that carry the valid osborn_ide cookie.
    ideSessionToken = randomBytes(24).toString('hex')
    ideProxyEnabled = true

    // Start idle watcher only when the native idle flag is absent.
    if (!supportsIdleFlag) {
      startIdeIdleWatcher()
    }

    resolveFn()
    } catch (err) {
      rejectFn(err)
      throw err
    } finally {
      ideStartInProgress = null
    }
  }

  // Wire the module-scope hook so startApiServer()'s /editor route can call
  // startCodeServer() without reaching into main()'s closure directly.
  codeServerStartHook = startCodeServer

  // ────────────────────────────────────────────────────────────────────────

  // Track the active resume session ID across scopes (ParticipantConnected + DataReceived)
  // Updated by resume_session, session_selected, continue_session, switch_session handlers
  let currentResumeSessionId: string | undefined

  // Claude auth code submission handler (set during OAuth flow, cleared after)
  let pendingAuthSubmitCode: ((code: string) => void) | null = null

  // Task deduplication guard - prevents Gemini re-execution loops
  let lastTaskRequest = ''
  let lastTaskTime = 0

  // Fast brain (ask_haiku) in-flight tracking — prevents ask_agent double-calling
  let haikuInFlight: { question: string, time: number } | null = null

  // Background research state - tracks async ask_agent execution
  let activeResearch: {
    researchLog: string[]
    pendingUpdates: string[] // Queue of updates waiting to be injected
    cleanup: () => void
    voiceUpdateCount: number // Track voice injection count (no cap — 8s debounce prevents flooding)
    abortController: AbortController // Abort SDK query on disconnect
  } | null = null

  // Persist last completed research context so follow-up questions can reference it
  // (activeResearch is set to null on completion — this preserves the context)
  let lastCompletedResearch: {
    task: string
    researchLog: string[]
    completedAt: number
  } | null = null

  // No manual queuing — the Claude SDK handles sequential queries internally

  // ============================================================
  // Recall.ai — Meeting Transcript Listener
  // ============================================================
  // NOTE: LLM-forwarding via Recall webhook STT was DISABLED in the Phase 2
  // LiveKit-based meeting-bot migration. Reason: Recall sends transcripts as
  // sentence-level fragments (e.g. "transcript.data" events fire ~once per
  // sentence). The old code below called currentLLM.chat() PER FRAGMENT, which
  // meant the agent fired ~10 chat() calls during a single user utterance —
  // each one prompting a separate response. The agent ended up speaking over
  // itself answering partial fragments.
  //
  // Phase 2 routes meeting audio through LiveKit instead (see
  // frontend/src/app/meeting-bot/page.tsx). The agent's existing Deepgram Flux
  // STT processes that audio via end-of-turn detection — ONE chat() call per
  // actual completed utterance, no fragment storms.
  //
  // We keep the listener registered so we have a hook for future work (e.g.
  // forwarding the live transcript to the frontend chat panel as a read-only
  // "what was said in the meeting" display, separate from the LLM input path).
  const recall = getRecallClient()
  if (recall) {
    console.log('🎥 Recall.ai client initialized — LIVE webhook finals buffered → LLM (batch poller download_url is empty mid-call, so the webhook is the only live transcript source)')
    // LIVE meeting transcript → LLM. The realtime webhook (handleWebhook) emits
    // every partial + final. We buffer FINALS (partials are too noisy) and a
    // flush timer (started on join_meeting) batches them to currentLLM.chat()
    // as [MEETING — botId]: every ~20s — so the agent actually sees the meeting
    // and can take notes / delegate to the writer. Previously this was DISABLED
    // and the poller (batch endpoint) was the only LLM path — but that endpoint
    // is empty until the meeting ENDS, so mid-call the LLM saw nothing.
    recall.on('transcript', ({ botId, speaker, text, partial }: { botId: string, speaker: string, text: string, partial?: boolean }) => {
      console.log(`📝 Meeting transcript [${speaker}]${partial ? ' (partial)' : ''}: ${text}`)
      if (!partial && text.trim()) {
        meetingTranscriptBuffer.push(`${speaker}: ${text.trim()}`)
        // Addressed by name → flush NOW (don't wait the 20s batch) and tag it so
        // the agent replies out loud into the meeting. This is the chat-mode path:
        // named/asked → prompt response. Un-addressed chunks stay in the silent
        // 20s batch for note-taking. That's the two-mode seam, mechanically.
        meetingSpeakers.add(speaker)
        // Fuzzy name match: meeting STT routinely mangles "Osborn" — observed
        // live 2026-08-01: "Osborn can you hear me" → "i was born can you hear
        // me" (name trigger missed, bot stayed silent). Accept common
        // mis-transcriptions; mild false-positive risk is acceptable in a
        // room that invited the bot. AND: in a 1:1 meeting (one human + the
        // bot) every utterance is addressed — no name needed.
        // Spoken mode switch: "interactive mode"/"go interactive" opens the
        // conversation latch; "observer mode"/"go silent" closes it.
        if (/\b(interactive mode|go interactive|start responding|talk to (me|us))\b/i.test(text)) {
          meetingAddressedUntil = Date.now() + 6 * 60 * 60 * 1000
          void speakIntoMeeting('Interactive mode on — I will respond out loud.')
        } else if (/\b(observer mode|silent mode|go silent|stop responding)\b/i.test(text)) {
          meetingAddressedUntil = 0
          void speakIntoMeeting('Going silent — just taking notes. Say interactive mode to bring me back.')
        }
        const oneOnOne = meetingSpeakers.size <= 1
        if (oneOnOne || /\b(osborne?|oz\s?born|os\s?born|was born|is born|ozborn|osbourne?|austin\b.{0,8}(hear|there|can you))/i.test(text)) {
          // DEBOUNCED (0.9.121): don't reply to this fragment — wait for the
          // speaker to actually pause. Each new final resets the timer, so one
          // continuous thought (even across Recall's mid-sentence segment splits)
          // becomes ONE reply instead of several talking over each other.
          console.log(`📓 Addressed (${oneOnOne ? '1:1 meeting' : 'by name'}) — turn debounced (~${ADDRESSED_DEBOUNCE_MS}ms)`)
          scheduleAddressedFlush(botId)
        }
      }
    })

    // Participant speech VAD → interruption + silence-boundary chunking.
    recall.on('speech', ({ botId, participant, active }: { botId: string, participant: string, isHost?: boolean, active: boolean }) => {
      const isBot = participant === meetingBotName || participant === 'Osborn' || participant === 'Unknown'
      if (active) {
        // A HUMAN started talking. If the bot is mid-speech → INTERRUPT: stop the
        // bot's audio and record what it was cut off saying so the next flush can
        // tell it what it missed (same pattern as voice-native interruptions).
        if (meetingAgentSpeaking && !isBot) {
          console.log(`✋ Interruption — ${participant} spoke while bot was talking.`)
          // Capture what got cut off BEFORE interrupting (same interruption-
          // context ledger as the website path — the next flush tells the agent
          // it was cut off + what the human likely didn't hear).
          meetingInterruptContext = `[MEETING — interrupted] You were speaking ("${meetingAgentSpeakingText.slice(0, 140)}") when ${participant} started talking and cut you off. They likely didn't hear the rest. When you respond, briefly acknowledge and adapt — don't just repeat.`
          // Actually STOP the voice: canvas stop + Recall output_audio stop +
          // queue-generation bump (drops anything still queued). Before 0.9.121
          // only the canvas was stopped — the real output_audio kept playing.
          pushCanvas({ kind: 'stop' })
          interruptMeetingSpeech(`human ${participant} barged in`)
        }
      } else {
        // speech_off — a natural silence boundary = the speaker finished their
        // utterance. When the conversation latch is open (1:1 or interactive
        // mode), that boundary IS the bot's turn — flush ADDRESSED so it
        // replies at natural pauses, VAD-driven, no name required
        // (user directive 2026-08-01).
        if (!isBot && meetingTranscriptBuffer.length) {
          const latchOpen = Date.now() < meetingAddressedUntil || meetingSpeakers.size <= 1
          if (latchOpen) {
            // Hard silence boundary → the speaker really finished. Flush sooner
            // than the transcript debounce (still debounced so back-to-back
            // speakers coalesce into one turn).
            scheduleAddressedFlush(botId, 450)
          } else {
            flushMeetingBuffer(botId, false) // silent observer note-taking batch
          }
        }
      }
    })
  }

  // ============================================================
  // Interruption Tracking (Content Ledger)
  // ============================================================
  // When user interrupts TTS, LiveKit truncates chatCtx to what was spoken.
  // We capture the spoken text (synchronizedTranscript) and on the next user
  // message, read Claude's full output from JSONL + inject context so Claude
  // knows what was heard vs lost. Claude decides: side question → answer +
  // continue, or redirect → follow new direction.

  // Current SpeechHandle from session.say() — only the latest one matters
  let currentSpeechHandle: any = null

  // Last interruption context — gathered at interrupt time, consumed when user's message arrives
  let lastInterruption: {
    spokenText: string       // synchronizedTranscript — what user heard (word-accurate)
    recentMessages: string   // last 10 assistant messages from JSONL (full untruncated)
    suppressedText: string   // agent text we did NOT play because the user was speaking (see tts_say gate below)
    fullBlockText?: string   // full intended TTS block text — fallback when JSONL is empty
    timestamp: number
  } | null = null

  /**
   * Called when a SpeechHandle finishes (interrupted or not).
   * If interrupted: gather spoken text + JSONL context. Does NOT send to Claude yet —
   * that happens when the user's transcribed message arrives via chat().
   */
  async function handleSpeechDone(handle: any, fullText: string, fullBlockText?: string) {
    if (!handle.interrupted) {
      lastInterruption = null
      return
    }

    // fullText is the synchronized (word-accurate) transcript of what was actually spoken
    // before the interruption. fullBlockText is the original full TTS segment text.
    const fullBlockLen = fullBlockText?.length ?? fullText.length
    console.log(`🔇 Speech interrupted. Heard (${fullText.length} chars): "${fullText}" [full block was ${fullBlockLen} chars]`)

    // Read last 10 assistant messages from JSONL (Claude's full untruncated output).
    // SessionMessage.text is pre-joined from all text content blocks.
    let recentMessages = ''
    const sessionId = currentLLM?.sessionId
    if (sessionId) {
      try {
        const { readSessionHistory } = await import('./session-access.js')
        const history = readSessionHistory(sessionId, workingDir, {
          lastN: 10,
          types: ['assistant', 'tool_use'],  // tool_use entries also carry Claude's spoken text
        })
        recentMessages = history
          .filter((m: any) => m.text)
          .map((m: any) => m.text)
          .join('\n---\n')
      } catch (err) {
        console.warn('⚠️ Failed to read JSONL for interruption context:', err)
      }
    }

    // Store — consumed when user's next message arrives via chat().
    // Preserve any already-buffered suppressedText (the user may have started speaking
    // BEFORE the previous TTS completed, and we may have already suppressed in-flight
    // tts_say events that arrived during that overlap).
    const carriedSuppressed = lastInterruption?.suppressedText ?? ''
    lastInterruption = {
      spokenText: fullText,
      recentMessages,
      suppressedText: carriedSuppressed,
      fullBlockText: fullBlockText && fullBlockText !== fullText ? fullBlockText : undefined,
      timestamp: Date.now(),
    }
    console.log(`📋 Interruption context stored (text: ${fullText.length} chars, JSONL: ${recentMessages.length} chars, block: ${fullBlockText?.length ?? 0} chars, suppressed carried: ${carriedSuppressed.length} chars)`)
  }

  /**
   * Append text the agent tried to say while the user was speaking, but which we
   * suppressed at the tts_say gate to avoid talking over them. Folded into
   * lastInterruption so it travels to Claude in the next chat() call.
   * If no interruption context exists yet (e.g. user just started speaking with no
   * prior TTS interrupt), creates a fresh entry.
   */
  function appendSuppressedText(text: string) {
    const t = text.trim()
    if (!t) return
    if (lastInterruption) {
      const sep = lastInterruption.suppressedText ? '\n' : ''
      lastInterruption.suppressedText = lastInterruption.suppressedText + sep + t
      lastInterruption.timestamp = Date.now()
    } else {
      lastInterruption = { spokenText: '', recentMessages: '', suppressedText: t, timestamp: Date.now() }
    }
    console.log(`🤐 Suppressed text buffered (+${t.length} chars, total ${lastInterruption.suppressedText.length}): "${t.substring(0, 80)}${t.length > 80 ? '...' : ''}"`)
  }

  /**
   * Callback for PipelineDirectLLM — returns pending interruption context and clears it.
   * Called in chat() when user's transcribed message arrives.
   * PipelineDirectLLM enriches the user message with this context before sending to Claude.
   */
  function getAndConsumeInterruptionContext() {
    if (!lastInterruption) return null
    // Expire after 60s — user may have waited too long
    if (Date.now() - lastInterruption.timestamp > 60_000) {
      lastInterruption = null
      return null
    }
    const ctx = {
      spokenText: lastInterruption.spokenText,
      recentMessages: lastInterruption.recentMessages,
      suppressedText: lastInterruption.suppressedText,
      fullBlockText: lastInterruption.fullBlockText,
    }
    lastInterruption = null
    return ctx
  }

  // ============================================================
  // Unified Voice Injection Queue
  // ============================================================
  // ALL system injections (research updates, completions, notifications, errors)
  // go through this queue. Never call generateReply directly for injections.
  // The queue only drains when the voice model is confirmed 'listening'.
  // After draining, the model transitions to thinking/speaking, and the queue
  // naturally pauses until the next 'listening' state.

  const voiceQueue: string[] = []
  let isProcessingQueue = false

  function queueVoiceInjection(instructions: string) {
    voiceQueue.push(instructions)
    console.log(`📥 Voice queue: +1 (total: ${voiceQueue.length}): ${instructions.substring(0, 80)}...`)
    processVoiceQueue()
  }

  function processVoiceQueue() {
    if (voiceQueue.length === 0) return
    if (!currentSession) return
    if (isProcessingQueue) {
      console.log(`⏸️ Voice queue: already processing, ${voiceQueue.length} items waiting`)
      return
    }
    if (agentState !== 'listening') {
      console.log(`⏸️ Voice queue: ${voiceQueue.length} items waiting (model: ${agentState})`)
      return // Will be called again when agent_state_changed → 'listening'
    }
    // Don't inject while user is speaking — server-side VAD will auto-create a response
    if (userState === 'speaking') {
      console.log(`⏸️ Voice queue: ${voiceQueue.length} items waiting (user speaking)`)
      return
    }
    // Don't inject while fast brain tool call is in flight — the tool response will
    // race with our generateReply, causing Gemini to drop our content and only speak
    // the tool response. Wait for the tool call to complete first.
    if (haikuInFlight) {
      console.log(`⏸️ Voice queue: ${voiceQueue.length} items waiting (fast brain in flight: "${haikuInFlight.question.substring(0, 40)}...")`)
      return // Will be retried when haikuInFlight clears (see tool execute handler)
    }

    isProcessingQueue = true

    // Batch ALL queued items into one generateReply call
    const items = voiceQueue.splice(0)
    const batchedInstruction = items.length === 1
      ? items[0]
      : items.join('\n\n---\n\n')

    console.log(`📡 Voice queue: processing ${items.length} batched items (${batchedInstruction.length} chars)`)

    // Safety timeout: if agent_state_changed never fires (edge case — e.g. Gemini
    // WebSocket drops, or state machine hangs). 15s gives the model time to process.
    setTimeout(() => {
      if (isProcessingQueue) {
        console.log('⚠️ Voice queue: safety timeout — clearing guard')
        isProcessingQueue = false
        if (voiceQueue.length > 0 && agentState === 'listening') {
          processVoiceQueue()
        }
      }
    }, 15000)

    try {
      // Skip interrupt for Gemini — disrupts Gemini's state machine, causing it to
      // never transition back to 'listening' (hangs in speaking state indefinitely)
      if (currentProvider !== 'gemini') {
        currentSession.interrupt()
      }

      if (currentProvider === 'gemini') {
        // LiveKit SDK v1.0.51: generateReply({ instructions }) sends a system turn +
        // synthetic "." user turn. After Gemini processes a tool call in this flow,
        // autoToolReplyGeneration does NOT trigger continuation (system-only limitation).
        // Using userInput instead makes it a "user-initiated" request where auto-continuation
        // works. The ask_fast_brain injection bypass handles [SCRIPT]/[PROACTIVE]/[NOTIFICATION]
        // prefixes and returns the content directly as a tool response.
        currentSession.generateReply({
          userInput: batchedInstruction,
        })
      } else {
        // OpenAI respects toolChoice:'none' — speaks instructions directly
        currentSession.generateReply({
          instructions: batchedInstruction,
          toolChoice: 'none' as any,
        })
      }
      // Model transitions to thinking/speaking after this call.
      // When it returns to 'listening', agent_state_changed triggers processVoiceQueue() again.

      // Also inject into chatCtx as persistent context so the model remembers across turns
      injectIntoChatCtx(batchedInstruction)
    } catch (err) {
      console.log('⚠️ Voice queue generateReply failed:', err)
      isProcessingQueue = false
    }
    // isProcessingQueue is cleared when agent_state_changed fires
  }

  // Inject content into the agent's ChatContext as persistent memory
  // This ensures the realtime model can reference prior research in follow-up questions
  // NOTE: Gemini doesn't support updateChatCtx (crashes with "Operation not implemented" code 1008).
  // For Gemini, generateReply({ instructions }) already injects as model turns, so context persists naturally.
  function injectIntoChatCtx(content: string) {
    if (!currentAgent) return
    // Skip for Gemini — updateChatCtx triggers unsupported operations on Gemini Live API
    if (currentVoiceMode === 'realtime' && currentProvider === 'gemini') return
    try {
      const chatCtx = currentAgent.chatCtx.copy()
      chatCtx.addMessage({
        role: 'assistant',
        content: content,
      })
      currentAgent.updateChatCtx(chatCtx)
      console.log(`🧠 ChatCtx updated (+${content.length} chars persistent context)`)
    } catch (err) {
      console.log('⚠️ ChatCtx injection failed:', err)
    }
  }

  // Extract recent voice conversation turns from the realtime LLM's in-memory ChatContext.
  // Replaces the internal conversationHistory array in fast-brain.ts.
  function getChatHistory(maxTurns: number = 20): ConversationTurn[] {
    if (!currentAgent) return []
    try {
      const items = currentAgent.chatCtx.items
      const turns: ConversationTurn[] = []
      for (const item of items) {
        if ((item as any).type !== 'message') continue
        const msg = item as any
        if (msg.role !== 'user' && msg.role !== 'assistant') continue
        const text = msg.textContent ?? ''
        if (!text.trim()) continue
        turns.push({ role: msg.role, text: text.trim() })
      }
      return turns.slice(-maxTurns)
    } catch (err) {
      console.log('⚠️ getChatHistory: failed to read chatCtx:', err)
      return []
    }
  }

  // Research event batching — debounce rapid-fire tool events into a single voice queue entry
  let researchBatchTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleResearchBatch() {
    if (researchBatchTimer) return // Already scheduled
    researchBatchTimer = setTimeout(() => {
      researchBatchTimer = null
      if (!activeResearch || activeResearch.pendingUpdates.length === 0) return

      const updates = activeResearch.pendingUpdates.splice(0)
      const batchText = updates.slice(-10).join('. ')
      console.log(`📡 [research] Batching ${updates.length} events: ${batchText.substring(0, 80)}...`)

      // Send to frontend for visibility
      sendToFrontend({
        type: 'claude_output',
        text: `[Research Progress] ${batchText}`,
        isStreaming: true,
        agentRole: 'research-progress',
      })

      // Route through fast brain — it decides whether to speak (usually silent)
      if (activeResearch.voiceUpdateCount < 2) {
        const voiceSid = currentLLM?.sessionId
        if (voiceSid) {
          const chatHistory = getChatHistory(10)
          handleResearchBatch(workingDir, voiceSid, lastTaskRequest || '', updates, activeResearch.researchLog, chatHistory, workingDir)
            .then(script => {
              if (script && activeResearch) {
                activeResearch.voiceUpdateCount++
                queueVoiceInjection(getScriptInjection(script))
              }
            })
            .catch(() => {}) // Silent fail — updates are optional
        }
      }
    }, 8000) // 8s debounce: reduces voice queue flooding during research
  }

  // Proactive conversational loop — keeps conversation alive during research
  let proactiveTimer: ReturnType<typeof setInterval> | null = null
  let proactivePromptHistory: string[] = []
  const PROACTIVE_INTERVAL = 15000  // 15 seconds (offset from 8s batch timer)
  const MAX_PROACTIVE_PROMPTS = 2   // Cap per research task (reduced from 4 to minimize realtime LLM tokens)

  function startProactiveLoop(task: string, sessionId: string) {
    stopProactiveLoop()
    proactivePromptHistory = []
    let proactiveCount = 0

    proactiveTimer = setInterval(async () => {
      if (!activeResearch) { stopProactiveLoop(); return }
      if (proactiveCount >= MAX_PROACTIVE_PROMPTS) return
      if (agentState !== 'listening' || userState === 'speaking') return
      if (researchBatchTimer) return  // Don't collide with batch updates
      if (isProcessingQueue) return   // Don't collide with voice queue

      try {
        const prompt = await generateProactivePrompt(
          workingDir, sessionId, task,
          activeResearch.researchLog,
          proactivePromptHistory,
          sessionBaseDir,
        )
        if (prompt && prompt !== 'NOTHING') {
          proactivePromptHistory.push(prompt)
          proactiveCount++
          queueVoiceInjection(getProactiveInjection(prompt))
        }
      } catch {} // Silent fail — proactive prompts are optional
    }, PROACTIVE_INTERVAL)
  }

  function stopProactiveLoop() {
    if (proactiveTimer) { clearInterval(proactiveTimer); proactiveTimer = null }
    proactivePromptHistory = []
  }

  // Helper to send data to frontend (with size limit handling)
  //
  // WebRTC SCTP data channel max message size is ~256KB. Sending larger
  // payloads corrupts the publisher transport, killing ALL subsequent sends.
  // We enforce a soft limit (truncate text/content fields) and a hard limit
  // (drop the message entirely with a warning) to prevent this.
  // ⚠️ These limits protect the LiveKit SCTP publisher peer connection.
  // During session resume, 12 artifact requests arrive simultaneously and the agent
  // sends responses back-to-back. If the cumulative payload exceeds the SCTP buffer
  // (~50-100 KB in rapid fire), the publisher PC enters a zombie state and NEVER
  // recovers — the user hears nothing for the rest of the connection. Keep these low.
  const MAX_MESSAGE_SIZE = 30000       // 30KB soft limit — truncate text/content fields
  const HARD_MAX_MESSAGE_SIZE = 50000  // 50KB hard limit — drop if still too large after truncation

  async function sendToFrontend(data: object) {
    if (!localParticipant) {
      console.log('⚠️ sendToFrontend: no localParticipant!')
      return
    }
    try {
      const encoder = new TextEncoder()
      let jsonData = JSON.stringify(data)

      // If message is too large, truncate the text or content field
      if (jsonData.length > MAX_MESSAGE_SIZE) {
        const truncatedData = { ...data } as any
        // Try truncating .text first (assistant_response, claude_output, etc.)
        if (truncatedData.text && typeof truncatedData.text === 'string') {
          const overhead = JSON.stringify({ ...truncatedData, text: '' }).length
          const maxTextLength = MAX_MESSAGE_SIZE - overhead - 100
          truncatedData.text = truncatedData.text.substring(0, maxTextLength) + '\n\n[Message truncated due to size limit]'
          jsonData = JSON.stringify(truncatedData)
          console.log(`⚠️ Message truncated .text from ${(data as any).text?.length} to ${truncatedData.text.length} chars`)
        }
        // Also try truncating .content (research_artifact_content, plan_file_content)
        if (jsonData.length > MAX_MESSAGE_SIZE && truncatedData.content && typeof truncatedData.content === 'string') {
          const overhead = JSON.stringify({ ...truncatedData, content: '' }).length
          const maxContentLength = MAX_MESSAGE_SIZE - overhead - 100
          truncatedData.content = truncatedData.content.substring(0, maxContentLength) + '\n\n[Content truncated due to size limit]'
          truncatedData.truncated = true
          truncatedData.originalSize = Buffer.byteLength((data as any).content, 'utf-8')
          jsonData = JSON.stringify(truncatedData)
          console.log(`⚠️ Message truncated .content from ${(data as any).content?.length} to ${truncatedData.content.length} chars`)
        }
      }

      // Hard cap — if still too large after truncation, drop entirely.
      // This prevents a 480KB base64 image or similar from killing the
      // WebRTC publisher transport (which is unrecoverable without reconnect).
      const payload = encoder.encode(jsonData)
      if (payload.length > HARD_MAX_MESSAGE_SIZE) {
        console.error(`❌ sendToFrontend: dropping message (${(payload.length / 1024).toFixed(0)}KB > ${(HARD_MAX_MESSAGE_SIZE / 1024).toFixed(0)}KB hard limit) — type: ${(data as any).type}`)
        return
      }

      await localParticipant.publishData(payload, {
        reliable: true,
        topic: 'osborn-updates',
      })
      console.log(`📤 Sent to frontend: ${(data as any).type} (${payload.length} bytes)`)
    } catch (err) {
      console.error('❌ sendToFrontend error:', err)
    }
  }

  // Helper: announce via voice - uses voice queue for realtime, say() for direct
  async function announceViaVoice(text: string) {
    if (!currentSession) return
    if (currentVoiceMode === 'realtime') {
      queueVoiceInjection(getNotificationInjection(text))
    } else {
      try {
        await (currentSession as any).say(text)
      } catch (err) {
        console.log('⚠️ Voice announcement failed:', err)
      }
    }
  }

  // Compaction event → frontend bridge. Forwards the raw event (consumed by the
  // dedicated banner UI state machine) AND emits a `claude_output` chat bubble
  // (so the activity is visible inline in chat even when the banner is hidden,
  // collapsed, or unreliable on iPad/iPhone). Extracted as a helper because
  // both direct-mode and pipeline-mode need to register it — the pipeline path
  // previously skipped this entirely, so compaction events fired into the void
  // in pipeline mode.
  const buildOnCompactionEvent = () => (event: any) => {
    // CRITICAL diagnostic — every compaction event MUST appear in the agent
    // log first. If you don't see [COMPACT-AGENT-RX] for an event type, the
    // ClaudeLLM hook isn't calling this callback (most likely culprits:
    // PreCompact/PostCompact hook never registered, or the callback wasn't
    // passed through createPipelineDirectLLM's opts). If you see RX but no
    // CHAT-EMIT, the type didn't match the chat-emit branch. If you see both
    // but the frontend log never shows [COMPACT-FRONTEND], the data channel
    // dropped the message (room not connected, payload too big, etc.).
    console.log(`[COMPACT-AGENT-RX] type=${event.type} keys=[${Object.keys(event).filter(k => k !== 'type').join(',')}]`)
    try {
      // Raw event → banner state machine (compaction_started/progress/complete handlers in VoiceRoom.tsx).
      sendToFrontend({ ...event } as any)
      console.log(`[COMPACT-AGENT-RAW-SENT] type=${event.type}`)

      // Inline chat bubble — reuses the existing claude_output path that's already working.
      if (event.type === 'compaction_started') {
        const triggerLabel = event.trigger ? ` (${event.trigger})` : ''
        const text = `✨ _Teaching Osborn from this session — saving your preferences and decisions…_${triggerLabel}`
        sendToFrontend({
          type: 'claude_output',
          text,
          agentRole: 'direct',
        })
        console.log(`[COMPACT-AGENT-CHAT-EMIT] started → "${text.substring(0, 60)}"`)
      } else if (event.type === 'compaction_complete') {
        const n = event.skillsWritten ?? 0
        const names = Array.isArray(event.skillNames) && event.skillNames.length > 0
          ? ` — ${event.skillNames.join(', ')}`
          : ''
        const text = `✨ Osborn learned — ${n} skill${n === 1 ? '' : 's'} updated${names}. I'll carry these forward.`
        sendToFrontend({
          type: 'claude_output',
          text,
          agentRole: 'direct',
        })
        console.log(`[COMPACT-AGENT-CHAT-EMIT] complete → "${text.substring(0, 80)}"`)
      } else {
        // progress events don't get a chat bubble (too noisy) — they only feed the banner.
        // Log at debug level so we can confirm they fired.
        console.log(`[COMPACT-AGENT-CHAT-SKIP] type=${event.type} (progress events feed the banner only, no inline bubble)`)
      }
    } catch (err) {
      console.error(`[COMPACT-AGENT-ERROR] ${(err as Error).message}`)
    }
  }

  // Create DIRECT session (STT + Claude Agent SDK + TTS)
  async function createDirectSession(resumeSessionId?: string, llmOverride?: any): Promise<{ session: voice.AgentSession; agent: voice.Agent }> {
    console.log('🎯 Creating direct session...')

    const stt = createSTT(DIRECT_MODE_STT)
    const tts = createTTS(DIRECT_MODE_TTS)

    // Create Claude LLM wrapper — direct mode uses speech-optimized system prompt
    // skipTTSQueue: bypass LiveKit's BufferedTokenStream, use session.say() instead
    // llmOverride: pipeline mode passes PipelineDirectLLM which wraps its own ClaudeLLM
    const directLLM = llmOverride || createClaudeLLM({
      workingDirectory: workingDir,
      sessionBaseDir,
      mcpServers,
      resumeSessionId,
      voiceMode: 'direct',
      skipTTSQueue: true,
      onCompactionEvent: buildOnCompactionEvent(),
      // Per-user named agents survive LLM recreations (session switch/resume)
      agents: (userNamedAgents || userRemovedAgents.length) ? (() => {
        const base: Record<string, any> = { ...NAMED_AGENTS }
        for (const r of userRemovedAgents) delete base[r]
        return { ...base, ...(userNamedAgents || {}) }
      })() : undefined,
    })
    currentLLM = directLLM

    // Reset the session always-allow list for each new direct session
    sessionAlwaysAllowPaths = new Set<string>()

    // For resumed sessions, eagerly create workspace (we know the real ID)
    if (resumeSessionId) {
      const workspace = ensureSessionWorkspace(workingDir, resumeSessionId)
      console.log(`📁 Session workspace (resumed): ${workspace}`)
    }

    // For new sessions, create workspace when SDK assigns real session ID
    directLLM.events.once('session_id', ({ sessionId }: { sessionId: string }) => {
      const workspace = ensureSessionWorkspace(workingDir, sessionId)
      console.log(`📁 Session workspace created: ${workspace}`)
      // Pipeline mode: pre-warm BM25 index so first fast brain query is fast
      if (currentVoiceMode === 'pipeline') {
        prewarmBM25Index(sessionId, workingDir).catch(() => {})
      }
    })

    // Also pre-warm for resumed sessions (sessionId already known)
    if (resumeSessionId && currentVoiceMode === 'pipeline') {
      prewarmBM25Index(resumeSessionId, workingDir).catch(() => {})
    }

    // Wire up MCP server changes to frontend
    directLLM.events.on('mcp_servers_changed', (data) => {
      console.log(`🔌 MCP servers changed: ${data.enabledKeys.join(', ') || 'none'}`)
      sendToFrontend({
        type: 'mcp_servers_changed',
        enabledKeys: data.enabledKeys,
        mcpServers: getMcpServerStatusList(config),
      })
    })

    // Wire up events from the Claude SDK wrapper to frontend
    directLLM.events.on('tool_use', (data) => {
      console.log(`🔧 Claude: ${data.name}`)
      sendToFrontend(buildToolLogEvent(data.name, data.input, 'running', data.agentRole || 'main'))
    })

    directLLM.events.on('tool_result', (data) => {
      console.log(`✅ Done: ${data.name}`)
      sendToFrontend(buildToolLogEvent(data.name, data.input, 'completed', data.agentRole || 'main'))

      // Detect research artifact writes (session workspace or legacy research dir)
      if ((data.name === 'Write' || data.name === 'Edit') && data.input?.file_path) {
        const fp = data.input.file_path
        if (fp.includes('/osb/') || fp.includes('.osborn/sessions/') || fp.includes('.osborn/research/')) {
          sendToFrontend({
            type: 'research_artifact_updated',
            filePath: fp,
            fileName: fp.split('/').pop(),
          })
        }
      }
    })

    // Wire up Claude text output - RAW text goes to frontend for chat bubbles
    directLLM.events.on('assistant_text', (data) => {
      console.log(`💬 Claude text (${data.text?.length || 0} chars): ${data.text || ''}`)
      sendToFrontend({
        type: 'claude_output',
        text: data.text,
        isStreaming: true,
        agentRole: 'direct',
        messageId: data.messageId,
        chunkIndex: data.chunkIndex,
      })
    })

    // Wire up Claude final result - RAW result goes to frontend
    directLLM.events.on('assistant_result', (data) => {
      console.log(`📋 Claude result (${data.text?.length || 0} chars): ${data.text || ''}`)
      sendToFrontend({
        type: 'claude_output',
        text: data.text,
        isStreaming: false,
        isFinal: true,
        agentRole: 'direct',
        messageId: data.messageId,
      })
    })

    // Wire up ordered TTS chunk list — emitted once per turn for read-along
    directLLM.events.on('tts_chunks', (data) => {
      sendToFrontend({
        type: 'tts_chunks',
        messageId: data.messageId,
        chunks: data.chunks,
      })
    })

    // Wire up permission requests - sends to frontend for user approval
    directLLM.events.on('permission_request', (data) => {
      console.log(`⚠️ Permission needed: ${data.toolName}`)
      const toolName = data.toolName
      const input = data.input || {}

      // Check session always-allow list before showing dialog
      if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
        const filePath = String(input?.file_path || '')
        if (filePath && sessionAlwaysAllowPaths.has(filePath)) {
          console.log(`✅ Session always-allow: ${filePath}`)
          directLLM.respondToPermission(true)
          return
        }
      }

      // Build descriptive message based on tool type
      let description = `I need permission to use ${toolName}.`
      if (toolName === 'Bash' && input.command) {
        const cmd = String(input.command).substring(0, 60)
        description = `I want to run the command: ${cmd}${String(input.command).length > 60 ? '...' : ''}`
      } else if (toolName === 'Write' && input.file_path) {
        description = `I want to create or overwrite the file: ${input.file_path}`
      } else if (toolName === 'Edit' && input.file_path) {
        description = `I want to edit the file: ${input.file_path}`
      } else if (toolName === 'WebFetch' && input.url) {
        description = `I want to fetch content from: ${input.url}`
      }

      // Generate diff for Write/Edit/MultiEdit tools
      let diffString: string | undefined
      if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
        const diffStart = performance.now()
        try {
          const filePath = String(input?.file_path || '')
          let beforeContent = ''

          const readStart = performance.now()
          try {
            beforeContent = readFileSync(filePath, 'utf-8')
          } catch {
            beforeContent = '' // new file
          }
          const readMs = (performance.now() - readStart).toFixed(2)
          console.log(`⏱️ diff read: ${readMs}ms (${beforeContent.length} chars, ${filePath.split('/').pop()})`)

          let afterContent = beforeContent
          if (toolName === 'Write') {
            afterContent = String(input?.content || '')
          } else if (toolName === 'Edit') {
            const oldStr = String(input?.old_string || '')
            const newStr = String(input?.new_string || '')
            const replaceAll = Boolean(input?.replace_all)
            if (replaceAll) {
              afterContent = beforeContent.split(oldStr).join(newStr)
            } else {
              afterContent = beforeContent.replace(oldStr, newStr)
            }
          } else if (toolName === 'MultiEdit') {
            afterContent = beforeContent
            const edits = Array.isArray(input?.edits) ? input.edits as Array<{old_string: string, new_string: string, replace_all?: boolean}> : []
            for (const edit of edits) {
              if (edit.replace_all) {
                afterContent = afterContent.split(edit.old_string).join(edit.new_string)
              } else {
                afterContent = afterContent.replace(edit.old_string, edit.new_string)
              }
            }
          }

          const patchStart = performance.now()
          const fileName = filePath.split('/').pop() || filePath
          diffString = createPatch(fileName, beforeContent, afterContent, '', '', { context: 4 })
          const patchMs = (performance.now() - patchStart).toFixed(2)
          const totalMs = (performance.now() - diffStart).toFixed(2)
          console.log(`⏱️ diff patch: ${patchMs}ms | total: ${totalMs}ms (before: ${beforeContent.length} chars, after: ${afterContent.length} chars, diff: ${diffString.length} chars)`)
        } catch (e) {
          const totalMs = (performance.now() - diffStart).toFixed(2)
          console.log(`⏱️ diff failed after ${totalMs}ms:`, e)
          // diff generation failed — proceed without diff
          diffString = undefined
        }
      }

      console.log(`🔍 perm payload: diff=${diffString ? `✅ ${diffString.length} chars` : '❌ NONE'} toolName=${toolName}`)
      sendToFrontend({
        type: 'permission_request',
        toolName: data.toolName,
        input: data.input,
        description,
        agentRole: 'direct',
        diff: diffString,
      })
      // Speak the descriptive request so user knows to respond
      //do not delete!! Leave this section commented out
      // say permission, request permission, ask for permission with session.say
      // if (currentSession) {
      //   const ttsMessage = `${description} Say yes, no, or always.`
      //   // ;(currentSession as any).say?.(ttsMessage).catch(() => {})
      //   ;(currentSession as any).say?.(ttsMessage)
      // }
    })

    // Wire up TTS say — bypass LiveKit's BufferedTokenStream, speak directly via session.say()
    // Each text block from Claude gets spoken immediately as it arrives, no internal buffering
    directLLM.events.on('tts_say', (data) => {
      if (!data.text?.trim()) {
        console.log(`🔇 tts_say fired but text is empty — skipping`)
        return
      }

      // MEETING PATH (fix 2026-08-01) — runs BEFORE the currentSession guard.
      // A meeting reply routes to the meeting via speakIntoMeeting → Recall
      // output_audio, which needs NO LiveKit voice session. Keeping this ahead
      // of the guard is what lets the bot keep replying AFTER the browser voice
      // session dropped (currentLLM is deliberately kept alive for exactly this;
      // see handleParticipantDisconnected). Before the fix a participant blip
      // nulled currentSession and EVERY meeting reply was "text dropped" — the
      // deaf-bot bug proven live 2026-08-01 via synthetic transcript inject.
      // Set by PipelineDirectLLM.chat() when the turn is a [MEETING —] chunk.
      if ((directLLM as unknown as { suppressMeetingTTS?: boolean }).suppressMeetingTTS) {
        // Parity relay (behind OSBORN_MEETING_AUDIO=parity) speaks via
        // session.say, so it still needs a live session — it falls through to
        // the normal browser-TTS path below only when currentSession exists.
        const parity = process.env.OSBORN_MEETING_AUDIO === 'parity' && meetingCanvasInRoom && activeMeetingBotId && Date.now() < meetingAddressedUntil && !!currentSession
        if (parity) {
          console.log(`🔊🎼 meeting reply via NATIVE session.say (canvas relays): "${data.text.slice(0, 50)}"`)
          markMeetingSpeaking(data.text)
          // fall through to normal browser TTS (currentSession present)
        } else if (activeMeetingBotId && Date.now() < meetingAddressedUntil) {
          // NATIVE sink: one clean output_audio push into the meeting, NO
          // LiveKit session required — this is the path that survives a
          // voice-session drop.
          console.log(`🔊➡️📢 tts_say → meeting (native audio) t=${new Date().toISOString()}: "${data.text.slice(0, 60)}"`)
          void speakIntoMeeting(data.text)
          return
        } else {
          console.log(`🔇 tts_say suppressed (meeting turn — response goes to /canvas, not browser): "${data.text.slice(0, 60)}"`)
          return
        }
      }

      // NORMAL BROWSER TTS (and the parity fall-through): needs a live session.
      // TTS errors can kill the session while a background query still runs.
      if (!currentSession) {
        console.warn(`⚠️ tts_say fired but currentSession is null — text dropped (${data.text?.length || 0} chars): "${data.text || ''}"`)
        return
      }

      // Suppress while the user is mid-utterance. Without this, agent text generated
      // in parallel by the Claude SDK plays right over the user — same problem as
      // pre-interrupt overlap, but at the *output* side. The suppressed text gets
      // folded into lastInterruption so the next chat() to Claude carries it as
      // "you wrote this but the user did not hear it — re-articulate if relevant."
      if (userState === 'speaking') {
        appendSuppressedText(data.text)
        return
      }

      const sayId = Date.now() // simple ID to correlate start/end logs
      console.log(`🗣️ [${sayId}] session.say START (${data.text.length} chars): "${data.text}"`)

      try {
        const handle = (currentSession as any).say(data.text)

        if (handle && typeof handle.addDoneCallback === 'function') {
          // SpeechHandle — track it and register interruption callback
          currentSpeechHandle = handle
          // Wall-clock timer: capture when audio actually starts playing (first frame)
          // Used as fallback if LiveKit's playbackPosition is 0 (race condition)
          let playbackStartedAt: number | null = null
          const audioOutputRef = (currentSession as any)?.output?.audio
          if (audioOutputRef && typeof audioOutputRef.on === 'function') {
            const onPlaybackStarted = () => {
              playbackStartedAt = Date.now()
              console.log(`🔊 [${sayId}] audio first frame out (playbackStarted)`)
              audioOutputRef.off('playbackStarted', onPlaybackStarted)
              // Notify frontend that this TTS chunk is now audibly playing
              if (data.messageId != null && data.chunkIndex != null) {
                sendToFrontend({
                  type: 'tts_chunk_playing',
                  messageId: data.messageId,
                  chunkIndex: data.chunkIndex,
                  text: data.text,
                })
              }
            }
            audioOutputRef.on('playbackStarted', onPlaybackStarted)
          }
          handle.addDoneCallback((sh: any) => {
            if (sh.interrupted) {
              console.log(`🔇 [${sayId}] session.say INTERRUPTED`)
              const audioOutput = (currentSession as any)?.output?.audio
              const sdkTranscript = audioOutput?.lastPlaybackEvent?.synchronizedTranscript
              const sdkPlaybackSec = audioOutput?.lastPlaybackEvent?.playbackPosition ?? 0

              let spokenText: string
              let method: string

              if (sdkTranscript) {
                // Best case: LiveKit gave us word-accurate transcript (requires alignedTranscript TTS)
                spokenText = sdkTranscript
                method = 'sdk-transcript'
              } else if (sdkPlaybackSec > 0) {
                // Second: LiveKit gave us playback duration — estimate chars from it
                const CHARS_PER_SEC = 14
                const charCount = Math.min(Math.round(sdkPlaybackSec * CHARS_PER_SEC), data.text.length)
                const slicePoint = data.text.lastIndexOf(' ', charCount) || charCount
                spokenText = slicePoint > 0 ? data.text.slice(0, slicePoint) : data.text
                method = 'sdk-position'
              } else if (playbackStartedAt !== null) {
                // Third: use our wall-clock timer from first audio frame
                const elapsedSec = (Date.now() - playbackStartedAt) / 1000
                const CHARS_PER_SEC = 14
                const charCount = Math.min(Math.round(elapsedSec * CHARS_PER_SEC), data.text.length)
                const slicePoint = data.text.lastIndexOf(' ', charCount) || charCount
                spokenText = slicePoint > 0 ? data.text.slice(0, slicePoint) : data.text
                method = 'wall-clock'
              } else {
                // Fallback: interrupt fired before first frame — pass full block
                spokenText = data.text
                method = 'full-block-fallback'
              }

              console.log('🔇 Interruption estimate:', JSON.stringify({
                method,
                sdkPlaybackSec,
                isSynced: !!sdkTranscript,
                spokenChars: spokenText.length,
                fullChars: data.text.length,
                heard: spokenText.slice(0, 80) + (spokenText.length > 80 ? '...' : '')
              }))
              handleSpeechDone(sh, spokenText, data.text)
            } else {
              console.log(`✅ [${sayId}] session.say DONE`)
              if (currentSpeechHandle === sh) lastInterruption = null
            }
          })
          console.log(`🗣️ [${sayId}] session.say queued (SpeechHandle tracked)`)
        } else if (handle && typeof handle.then === 'function') {
          // Promise-based fallback (older SDK path)
          handle
            .then(() => console.log(`✅ [${sayId}] session.say DONE`))
            .catch((err: any) => console.error(`❌ [${sayId}] session.say FAILED:`, err?.message || err))
        }
      } catch (err: any) {
        // Catch synchronous "AgentSession is not running" errors
        console.warn(`⚠️ [${sayId}] session.say threw — session likely dead: ${err?.message}`)
      }
    })

    // Wire up session resume failure - notify frontend when SDK creates new session instead
    directLLM.events.on('session_resume_failed', (data) => {
      console.error(`❌ Session resume failed: ${data.requestedSessionId} → ${data.actualSessionId}`)
      sendToFrontend({
        type: 'session_resume_failed',
        requestedSessionId: data.requestedSessionId,
        actualSessionId: data.actualSessionId,
      })
    })

    // Wire up file checkpoint capture - track restore points for file rewind
    directLLM.events.on('checkpoint_captured', (data) => {
      console.log(`📍 Checkpoint: ${data.checkpointId.substring(0, 8)}...`)
      sendToFrontend({
        type: 'checkpoint_captured',
        checkpointId: data.checkpointId,
      })
    })

    // Dispatcher v1 — writer reviewer rejected verdict → frontend
    directLLM.events.on('dispatch_rejected', (data: { tuid: string; verdict: string; review: string }) => {
      console.log(`[DISPATCH] dispatch_rejected tuid=${(data.tuid ?? '').slice(0, 8)} sending to frontend`)
      sendToFrontend({
        type: 'task_review',
        tuid: data.tuid,
        verdict: data.verdict,
        review: data.review,
      })
    })

    // Dispatcher v1 — sub-agent completed → frontend (Feature A)
    directLLM.events.on('task_completed', (d: any) => sendToFrontend({
      type: 'task_completed',
      agent_type: d.agent_type,
      agent_id: d.agent_id,
      last_assistant_message: d.last_assistant_message,
    }))

    // Dispatcher v1 — sub-agent started → frontend stop-key signal (Feature A2)
    directLLM.events.on('agent_started', (d: any) => sendToFrontend({
      type: 'agent_started',
      agent_type: d.agent_type,
      agent_id: d.agent_id,
    }))

    // Create the Agent with instructions, STT, LLM, TTS
    // VAD (Silero ONNX) removed — caused 2-5s inference lag on CPU, making interruption detection worse
    // Turn detection is server-side (Deepgram endpointing), interruptions handled by STT
    const agent = new voice.Agent({
      instructions: DIRECT_MODE_PROMPT,
      stt,
      llm: directLLM,
      tts,
      turnDetection: 'stt',
    })

    // 0.9.62: REVERT to the AgentSession config that was deployed during the
    // user's known-good month (0.9.52, Jun 09). Pre-48h evidence shows the
    // explicit interruption block introduced in 0.9.60 + the timer bumps in
    // 0.9.61 made things WORSE, not better — osbornojure logs showed 5+
    // consecutive TTS stalls on a single TTS-say, each one re-triggering
    // because the underlying pause-and-resume deadlock (workflow finding:
    // waitUntilTimeout signal-blind, audioOutput.pause without _currentSpeech.interrupt,
    // captureFrame parked on playbackEnabledFuture) is INHERENT to the
    // 1.4.x pause path and our tuned thresholds (minDuration: 1000, minWords: 3)
    // simply make each rare-but-deadlocking trigger more catastrophic.
    //
    // Stripped back to SDK defaults for every interrupt-related knob. SDK
    // 1.4.6 defaults (aecWarmupDuration: 3000, minDuration: 500, minWords: 0,
    // falseInterruptionTimeout: 2000, resumeFalseInterruption: true,
    // discardAudioIfUninterruptible: true, ttsReadIdleTimeout: 10000,
    // maxUnrecoverableErrors: 3) are what was silently running via caret-resolved
    // 1.4.5 throughout the user's working month. Restoring them.
    const session = new voice.AgentSession({
      turnDetection: 'stt',
      preemptiveGeneration: false,  // Only fire LLM on final committed transcript, not partial preemptives
      // Commented out — kept for reference. These were added across 0.9.60/0.9.61
      // to try to harden interrupt + TTS handling, but evidence (osbornojure
      // 2026-06-16/17 logs + the interrupt-stall workflow) showed they made
      // things worse: tighter gates concentrated the rare-but-deadlocking pause
      // path triggers into longer events that the SDK's signal-blind read loop
      // (utils.js:624 waitUntilTimeout) couldn't recover from. Defaults from
      // SDK 1.4.6 (matching what silently ran via caret-resolved 1.4.5 throughout
      // the user's last-working month) are restored by leaving these unset.
      //
      // aecWarmupDuration: 5000,                    // default 3000 (left at default)
      // 0.9.64 evidence (0.9.63 osbornojure logs): the ONE stall in a long
      // session fired AFTER session.say DONE during a ~73s silent gap before
      // the next agent response — the forwarder's 10s idle timer fired during
      // an LLM-think pause, not from an interrupt (OVERLAPPING SPEECH: 0,
      // AGENT FALSE INTERRUPTION: 0, interrupting TTS: 0 in that session).
      // Bumping both watchdogs to 30s gives the forwarder room to ride out
      // normal between-message pauses without timing out. Independent of the
      // interruption block above, which is doing its job (0 interrupts fired).
      ttsReadIdleTimeout: 40_000,                 // default 10000 → 30000
      forwardAudioIdleTimeout: 40_000,            // default 10000 → 30000
      // connOptions: {
      //   maxUnrecoverableErrors: 15,               // default 3 (left at default)
      // },
      turnHandling: {
        endpointing: {
          mode: 'fixed' as any,
          minDelay: 500,    // Wait 500ms after STT commits before generating reply
          maxDelay: 2000,   // Force end-of-turn after 2s to prevent hangs
        },
        // Tightened gates: only commit to the pause path when the STT layer is
        // confident this is real speech, not echo. Once paused, give the user
        // a full 3s window to keep talking before deciding it was false and
        // resuming. Other two knobs left at SDK defaults.
        interruption: {
          minDuration: 1500,                  // default 500  — require 1.5s sustained speech (faster barge-in than 2500)
          minWords: 2,                        // default 0    — require ≥2 transcript words
          falseInterruptionTimeout: 3500,     // default 2000 — 3.5s false-interrupt window (belt-and-suspenders since minDuration was loosened)
          // resumeFalseInterruption: true,      // default true  (unchanged)
          // discardAudioIfUninterruptible: true,// default true  (unchanged)
        },
      },
    })

    // 0.9.71: dump the RESOLVED AgentSession options (after defaults applied)
    // so prod logs prove exactly what tuning is live for any given session.
    try {
      const so: any = (session as any).sessionOptions ?? {}
      const detect = (session as any).interruptionDetection
      const turn = so.turnHandling ?? {}
      console.log('🧪 [BE-AGENT-SESSION-CONFIG]', JSON.stringify({
        t: new Date().toISOString(),
        maxToolSteps: so.maxToolSteps,
        userAwayTimeout: so.userAwayTimeout,
        aecWarmupDuration: so.aecWarmupDuration,
        ttsReadIdleTimeout: so.ttsReadIdleTimeout,
        forwardAudioIdleTimeout: so.forwardAudioIdleTimeout,
        useTtsAlignedTranscript: so.useTtsAlignedTranscript,
        ttsTextTransforms: so.ttsTextTransforms,
        interruptionDetectionMode: detect, // 'vad' | 'adaptive' | undefined
        turnHandling: {
          turnDetection: turn.turnDetection,
          endpointing: turn.endpointing,
          interruption: turn.interruption,
          preemptiveGeneration: turn.preemptiveGeneration,
          userTurnLimit: turn.userTurnLimit,
        },
      }))
    } catch (err) {
      console.log('🧪 [BE-AGENT-SESSION-CONFIG] failed:', err instanceof Error ? err.message : String(err))
    }

    return { session, agent }
  }

  // ============================================================
  // REALTIME MODE - OpenAI/Gemini native speech-to-speech
  // ============================================================

  // Claude handler for realtime mode tool execution
  let realtimeClaudeHandler: ReturnType<typeof createClaudeLLM> | null = null

  // Create REALTIME session (OpenAI/Gemini native speech-to-speech)
  async function createRealtimeSession(sessionRealtimeConfig?: typeof realtimeConfig, resumeSessionId?: string): Promise<{ session: voice.AgentSession; agent: voice.Agent }> {
    const rtConfig = sessionRealtimeConfig || realtimeConfig
    console.log(`🎯 Creating realtime session (${rtConfig.provider})...`)

    // Create Claude LLM for tool execution (research tasks)
    realtimeClaudeHandler = createClaudeLLM({
      workingDirectory: workingDir,
      sessionBaseDir,
      mcpServers,
      resumeSessionId,
      onCompactionEvent: buildOnCompactionEvent(),
    })
    currentLLM = realtimeClaudeHandler

    // For resumed sessions, eagerly create workspace (we know the real ID)
    if (resumeSessionId) {
      const workspace = ensureSessionWorkspace(workingDir, resumeSessionId)
      console.log(`📁 Session workspace (resumed): ${workspace}`)
    }

    // For new sessions, create workspace when SDK assigns real session ID
    realtimeClaudeHandler.events.once('session_id', ({ sessionId }: { sessionId: string }) => {
      const workspace = ensureSessionWorkspace(workingDir, sessionId)
      console.log(`📁 Session workspace created: ${workspace}`)
    })

    // Wire up MCP server changes to frontend
    realtimeClaudeHandler.events.on('mcp_servers_changed', (data) => {
      console.log(`🔌 MCP servers changed: ${data.enabledKeys.join(', ') || 'none'}`)
      sendToFrontend({
        type: 'mcp_servers_changed',
        enabledKeys: data.enabledKeys,
        mcpServers: getMcpServerStatusList(config),
      })
    })

    // Wire up Claude events to frontend
    realtimeClaudeHandler.events.on('tool_use', (data) => {
      console.log(`🔧 Claude: ${data.name}`)
      sendToFrontend(buildToolLogEvent(data.name, data.input, 'running', data.agentRole || 'main'))
    })

    realtimeClaudeHandler.events.on('tool_result', (data) => {
      console.log(`✅ Done: ${data.name}`)
      sendToFrontend(buildToolLogEvent(data.name, data.input, 'completed', data.agentRole || 'main'))

      // Detect research artifact writes (session workspace or legacy research dir)
      if ((data.name === 'Write' || data.name === 'Edit') && data.input?.file_path) {
        const fp = data.input.file_path
        if (fp.includes('/osb/') || fp.includes('.osborn/sessions/') || fp.includes('.osborn/research/')) {
          sendToFrontend({
            type: 'research_artifact_updated',
            filePath: fp,
            fileName: fp.split('/').pop(),
          })
        }
      }
    })

    realtimeClaudeHandler.events.on('assistant_result', (data) => {
      console.log(`📋 Claude result (${data.text?.length || 0} chars): ${data.text || ''}`)
      sendToFrontend({
        type: 'claude_output',
        text: data.text,
        isStreaming: false,
        isFinal: true,
        agentRole: 'realtime',
      })
    })

    // Stream Claude's research text to frontend as progress updates
    // Skips during active research to avoid duplication with per-task onText handler
    realtimeClaudeHandler.events.on('assistant_text', (data) => {
      if (data.text && data.text.trim()) {
        if (activeResearch) return
        sendToFrontend({
          type: 'claude_output',
          text: data.text,
          isStreaming: true,
          agentRole: 'realtime-agent',
        })
      }
    })

    realtimeClaudeHandler.events.on('permission_request', (data) => {
      console.log(`⚠️ Permission needed: ${data.toolName}`)
      const toolName = data.toolName
      const input = data.input || {}

      // Build descriptive message based on tool type
      let description = `I need permission to use ${toolName}.`
      if (toolName === 'Bash' && input.command) {
        const cmd = String(input.command).substring(0, 60)
        description = `I want to run the command: ${cmd}${String(input.command).length > 60 ? '...' : ''}`
      } else if (toolName === 'Write' && input.file_path) {
        description = `I want to create or overwrite the file: ${input.file_path}`
      } else if (toolName === 'Edit' && input.file_path) {
        description = `I want to edit the file: ${input.file_path}`
      } else if (toolName === 'WebFetch' && input.url) {
        description = `I want to fetch content from: ${input.url}`
      }

      sendToFrontend({
        type: 'permission_request',
        toolName: data.toolName,
        input: data.input,
        description,
        agentRole: 'realtime',
      })
    })

    // Wire up session resume failure for realtime mode
    realtimeClaudeHandler.events.on('session_resume_failed', (data) => {
      console.error(`❌ Session resume failed: ${data.requestedSessionId} → ${data.actualSessionId}`)
      sendToFrontend({
        type: 'session_resume_failed',
        requestedSessionId: data.requestedSessionId,
        actualSessionId: data.actualSessionId,
      })
    })

    // Wire up file checkpoint capture for realtime mode
    realtimeClaudeHandler.events.on('checkpoint_captured', (data) => {
      console.log(`📍 Checkpoint: ${data.checkpointId.substring(0, 8)}...`)
      sendToFrontend({
        type: 'checkpoint_captured',
        checkpointId: data.checkpointId,
      })
    })


    // Extracted research execution — called by ask_agent, SDK handles queuing internally
    function executeResearch(task: string): string {
      sendToFrontend({ type: 'system', text: `Executing: ${task}` })

      // Fire-and-forget: write user question to spec.md BEFORE agent starts
      const questionSid = currentLLM?.sessionId || resumeSessionId
      if (questionSid) {
        writeQuestionToSpec(workingDir, questionSid, task).catch(err =>
          console.error('❌ writeQuestionToSpec failed:', err)
        )
      }

      // Clean up previous research UI tracking — but let the SDK query complete in background.
      // The SDK has an internal queue: new query() calls enqueue behind running ones.
      // Old research results land in JSONL and fast brain can access them later.
      if (activeResearch) {
        activeResearch.cleanup() // Remove event listeners so UI tracks new task
        if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
        // NOTE: NOT aborting — old SDK process continues writing to JSONL
      }

      // Set up research log batching — events push to queue for state-driven injection
      const researchLog: string[] = []
      const pendingUpdates: string[] = []
      const onToolUse = (data: any) => {
        const input = data.input || {}
        let entry: string

        if (data.name === 'Read' && input.file_path) {
          const fileName = input.file_path.split('/').pop() || input.file_path
          entry = `Reading ${fileName}`
        } else if (data.name === 'Bash' && input.command) {
          const cmd = input.command.substring(0, 80)
          entry = `Running: ${cmd}`
        } else if (data.name === 'Glob' && input.pattern) {
          entry = `Searching for files matching ${input.pattern}`
        } else if (data.name === 'Grep' && input.pattern) {
          entry = `Searching for "${input.pattern}" in files`
        } else if (data.name === 'WebSearch' && input.query) {
          entry = `Searching the web for "${input.query}"`
        } else if (data.name === 'WebFetch' && input.url) {
          const hostname = input.url.replace(/https?:\/\//, '').split('/')[0]
          entry = `Fetching content from ${hostname}`
        } else if (data.name === 'Write' && input.file_path) {
          const fileName = input.file_path.split('/').pop() || input.file_path
          entry = `Writing ${fileName}`
        } else if (data.name === 'Edit' && input.file_path) {
          const fileName = input.file_path.split('/').pop() || input.file_path
          entry = `Editing ${fileName}`
        } else if (data.name.startsWith('mcp__')) {
          const parts = data.name.split('__')
          const serverName = parts[1] || 'external'
          const toolAction = parts.slice(2).join(' ') || 'tool'
          entry = `Using ${serverName}: ${toolAction}`
        } else {
          entry = `Using ${data.name}`
        }

        researchLog.push(entry)
        pendingUpdates.push(entry)
        scheduleResearchBatch()
      }
      const ANSWER_CHECK_THRESHOLD = 300 // chars — only check substantial outputs
      const onToolResult = (data: any) => {
        // Only log to researchLog for the final summary — don't push to pendingUpdates
        // This prevents redundant "Reading config.ts. Read done." voice updates
        researchLog.push(`${data.name} completed`)
        // Fire-and-forget: check if substantial tool results answer any spec questions
        // Note: PostToolUse emits { name, input, response } — use data.response (not data.result)
        const resultText = typeof data.response === 'string' ? data.response : JSON.stringify(data.response || '')
        if (resultText.length > ANSWER_CHECK_THRESHOLD) {
          const sid = currentLLM?.sessionId || resumeSessionId
          if (sid) checkOutputAgainstQuestions(workingDir, sid, resultText, 'tool_result').catch(() => {})
        }
        // When AskUserQuestion completes, the user's answer is a decision — track it in spec
        if (data.name === 'AskUserQuestion' && data.response) {
          const sid = currentLLM?.sessionId || resumeSessionId
          if (sid) {
            const questionText = JSON.stringify(data.input?.questions || data.input || {})
            const answerText = typeof data.response === 'string' ? data.response : JSON.stringify(data.response)
            const specUpdate = `User answered a clarifying question during research.\nQuestion: ${questionText}\nAnswer: ${answerText}\nRecord this as a user decision in spec.md.`
            askHaiku(workingDir, sid, specUpdate, undefined, undefined, undefined, workingDir).catch(err =>
              console.error('❌ Failed to record AskUserQuestion answer in spec:', err)
            )
            console.log(`📝 AskUserQuestion answer forwarded to fast brain for spec tracking`)
          }
        }
      }
      const onText = (data: any) => {
        if (data.text?.trim()) {
          const text = data.text.trim()
          const preview = text.substring(0, 150)
          const firstSentence = preview.match(/^[^.!?\n]+[.!?]/)?.[0] || preview
          researchLog.push(firstSentence)
          pendingUpdates.push(firstSentence)
          scheduleResearchBatch()
          // Fire-and-forget: check if substantial agent reasoning answers any spec questions
          if (text.length > ANSWER_CHECK_THRESHOLD) {
            const sid = currentLLM?.sessionId || resumeSessionId
            if (sid) checkOutputAgainstQuestions(workingDir, sid, text, 'assistant_text').catch(() => {})
          }
        }
      }
      // Capture the SDK's requestId for this query — identifies this research task
      // in the JSONL file for targeted retrieval by fast brain
      let sdkRequestId: string | null = null
      const onQueryRequestId = (data: any) => {
        if (!sdkRequestId && data.requestId) {
          sdkRequestId = data.requestId
          console.log(`📋 [research] SDK requestId: ${sdkRequestId}`)
        }
      }
      realtimeClaudeHandler!.events.on('tool_use', onToolUse)
      realtimeClaudeHandler!.events.on('tool_result', onToolResult)
      realtimeClaudeHandler!.events.on('assistant_text', onText)
      realtimeClaudeHandler!.events.on('query_request_id', onQueryRequestId)

      const cleanupListeners = () => {
        realtimeClaudeHandler?.events.off('tool_use', onToolUse)
        realtimeClaudeHandler?.events.off('tool_result', onToolResult)
        realtimeClaudeHandler?.events.off('assistant_text', onText)
        realtimeClaudeHandler?.events.off('query_request_id', onQueryRequestId)
      }

      // Create AbortController for this research task — abort on disconnect/cleanup
      const researchAbortController = new AbortController()

      // Track active research — updates drain when model enters 'listening' state
      const thisResearch = {
        researchLog,
        pendingUpdates,
        cleanup: cleanupListeners,
        voiceUpdateCount: 0,
        abortController: researchAbortController,
      }
      activeResearch = thisResearch

      // Start proactive conversational loop
      const proactiveSid = currentLLM?.sessionId || resumeSessionId
      if (proactiveSid) {
        startProactiveLoop(task, proactiveSid)
      }

      // Run research in the background (non-blocking)
      // Pass AbortController so research can be stopped on disconnect
      const researchPromise = (async () => {
        const stream = realtimeClaudeHandler!.chat({
          chatCtx: {
            items: [{ type: 'message', role: 'user', content: [task] }],
          } as any,
          abortController: researchAbortController,
        })

        let result = ''
        for await (const chunk of stream) {
          if (chunk.delta?.content) {
            result += chunk.delta.content
          }
        }
        return result
      })()

      // Handle completion asynchronously
      researchPromise.then(async (result) => {
        // Check if aborted — empty result means clean abort, skip pipeline
        if (researchAbortController.signal.aborted || !result.trim()) {
          console.log(`🛑 [realtime] Research aborted or empty: ${task.substring(0, 60)}`)
          cleanupListeners()
          if (activeResearch === thisResearch) {
            activeResearch = null
          }
          return
        }

        const isStillCurrent = activeResearch === thisResearch
        console.log(`✅ [realtime] Research complete (${result.length} chars${isStillCurrent ? '' : ', superseded by newer task'})`)

        // Clean up
        cleanupListeners()

        // Send raw result to frontend as a log entry (not assistant_response — that's reserved
        // for the voice model's spoken response, avoiding duplication in chat)
        await sendToFrontend({ type: 'claude_output', text: result, isStreaming: false, agentRole: 'research-result' })
        const resultPreview = result.length > 150
          ? result.substring(0, 150) + '...'
          : result
        await sendToFrontend({ type: 'task_completed', task, resultPreview })

        // Only modify global state if we're still the current research task.
        // If a newer task replaced us, don't clobber its timers/state.
        if (isStillCurrent) {
          if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
          stopProactiveLoop()
        }

        // Preserve research context for follow-up questions
        lastCompletedResearch = {
          task,
          researchLog: [...researchLog],
          completedAt: Date.now(),
        }

        // Only clear activeResearch if we're still the current task
        if (isStillCurrent) {
          activeResearch = null
        }

        // Send research_task_complete to frontend for inline chat tracking
        await sendToFrontend({
          type: 'research_task_complete',
          task,
          summary: result.substring(0, 500),
        })

        // Route through fast brain to generate a teleprompter script from the findings
        // Fast brain reads full JSONL and writes a spoken monologue
        const voiceSid = currentLLM?.sessionId || resumeSessionId
        const chatHistory = getChatHistory(10)
        console.log(`📡 [realtime] Generating teleprompter script via fast brain (result: ${result.length} chars, agentState: ${agentState})`)
        // Create sendToChat for research completion to send structured data to frontend
        const completionSendToChat = (text: string) => {
          sendToFrontend({ type: 'assistant_response', text })
        }
        if (voiceSid) {
          processResearchCompletion(workingDir, voiceSid, task, result, chatHistory, completionSendToChat, workingDir)
            .then(script => {
              queueVoiceInjection(getScriptInjection(script))
            })
            .catch(() => {
              // Fallback: use truncated result directly if fast brain fails
              queueVoiceInjection(getScriptInjection(result.substring(0, 500)))
            })
        } else {
          queueVoiceInjection(getScriptInjection(result.substring(0, 500)))
        }

        // Fire-and-forget JSONL-based refinement pass via fast brain
        // Reads FULL untruncated data from JSONL — no content buffer, no truncation
        const postResearchSessionId = currentLLM?.sessionId || resumeSessionId
        if (postResearchSessionId) {
          updateSpecFromJSONL(workingDir, postResearchSessionId, task, researchLog, workingDir)
            .then(updateResult => {
              if (!updateResult) return

              // Notify frontend about spec.md update
              if (updateResult.spec) {
                const specPath = join(getSessionWorkspace(workingDir, postResearchSessionId), 'spec.md')
                sendToFrontend({
                  type: 'research_artifact_updated',
                  filePath: specPath,
                  fileName: 'spec.md',
                })
              }
            })
        }
      }).catch(async (err) => {
        // Clean up
        cleanupListeners()
        const isStillCurrent = activeResearch === thisResearch
        if (isStillCurrent) {
          if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
          stopProactiveLoop()
          activeResearch = null
        }

        // If aborted (user disconnected), log quietly
        if (researchAbortController.signal.aborted) {
          console.log(`🛑 [realtime] Research aborted: ${task.substring(0, 60)}`)
          return
        }

        console.error(`❌ [realtime] Research failed:`, err)
        // Queue error notification — will be spoken when model is available
        queueVoiceInjection(getNotificationInjection(`Research encountered an error: ${(err as Error).message}. You could try asking again.`))
      })

      // Return immediately to unblock the voice model
      return 'Research started. I\'ll relay findings as they come in — you can keep talking to the user while I work.'
    }

    // Create tools for the realtime voice LLM
    // The realtime model is a thin teleprompter — only 2 tools:
    // 1. ask_fast_brain: ALL user questions route here (the fast brain decides everything)
    // 2. respond_permission: voice permission flow for Claude SDK blocked operations

    const askFastBrainTool = llm.tool({
      description: `Ask your brain. Call this for EVERY user message — greetings, questions, decisions, requests, everything. No exceptions. Returns what you should say.`,
      parameters: z.object({
        question: z.string().describe('The user\'s question or statement'),
      }),
      execute: async ({ question }) => {
        // INJECTION BYPASS: When Gemini receives a system injection via generateReply(),
        // it calls ask_fast_brain with the injection content (Gemini always calls tools).
        // For Gemini: this is the INTENDED path — we deliberately don't set toolChoice:'none'
        //   so the tool call goes through and we return the content as a tool response.
        // For OpenAI: this is a fallback guard — OpenAI normally speaks instructions directly
        //   with toolChoice:'none', but if it somehow calls the tool, we handle it here.
        const injectionMatch = question.match(/\[(SCRIPT|PROACTIVE|NOTIFICATION)\]\s*([\s\S]*)/)
        if (injectionMatch) {
          const content = injectionMatch[2].trim()
          console.log(`⚡ [fast brain] BYPASS: injection [${injectionMatch[1]}] → returning content directly (${content.length} chars)`)
          return content || question
        }

        // Use pending sessionId for fresh sessions where SDK hasn't assigned one yet
        const sessionId = currentLLM?.sessionId || currentResumeSessionId || resumeSessionId || 'pending'
        console.log(`🧠 [fast brain] Question: "${question.substring(0, 80)}..."`)

        // Track in-flight state
        haikuInFlight = { question, time: Date.now() }

        // Build research context — from active research or last completed research
        let researchContext: string | undefined
        if (activeResearch && activeResearch.researchLog.length > 0) {
          const recentLog = activeResearch.researchLog.slice(-15)
          researchContext = `Research topic: "${lastTaskRequest || 'unknown'}"\nSteps completed (${activeResearch.researchLog.length} total, showing last ${recentLog.length}):\n${recentLog.join('\n')}`
        } else if (lastCompletedResearch && (Date.now() - lastCompletedResearch.completedAt) < 600000) {
          // Include context from last completed research (within 10 minutes)
          const recentLog = lastCompletedResearch.researchLog.slice(-15)
          researchContext = `[COMPLETED RESEARCH] Topic: "${lastCompletedResearch.task}"\nSteps completed (${lastCompletedResearch.researchLog.length} total, showing last ${recentLog.length}):\n${recentLog.join('\n')}\n\n(Research completed — results are in JSONL and spec.md. Answer from those, do NOT trigger new research on this topic.)`
        }

        const callbacks: FastBrainCallbacks = {
          triggerResearch: (task: string) => {
            // Deduplication guard
            const now = Date.now()
            if (task === lastTaskRequest && (now - lastTaskTime) < 10000) {
              console.log('⏭️ Skipping duplicate research task (within 10s window)')
              return
            }
            lastTaskRequest = task
            lastTaskTime = now
            executeResearch(task)
          },
          queueVoice: (script: string) => {
            queueVoiceInjection(getScriptInjection(script))
          },
          sendToFrontend: (data: any) => {
            sendToFrontend(data)
          },
        }

        try {
          const chatHistory = getChatHistory(20)
          const result = await askFastBrain(workingDir, sessionId, question, {
            chatHistory,
            researchContext,
            callbacks,
          })
          haikuInFlight = null
          // Voice queue items may have been held while fast brain was in flight — retry now
          if (voiceQueue.length > 0) {
            setTimeout(() => processVoiceQueue(), 500)
          }

          console.log(`🧠 [fast brain] Response type: ${result.type}, script: ${result.script.length} chars`)

          // If this was a user direction during active research,
          // pass it to the agent SDK so it picks up the context
          if (activeResearch && result.type === 'recorded' && (
            question.toLowerCase().includes('decided') ||
            question.toLowerCase().includes('prefers') ||
            question.toLowerCase().includes('focus on') ||
            question.toLowerCase().includes('redirect')
          )) {
            console.log(`📨 [fast brain] Passing user direction to agent SDK queue`)
            executeResearch(`[USER DIRECTION during active research] ${question}. The user's spec.md has been updated. Acknowledge briefly and incorporate.`)
          }

          return result.script
        } catch (err) {
          haikuInFlight = null
          // Voice queue items may have been held while fast brain was in flight — retry now
          if (voiceQueue.length > 0) {
            setTimeout(() => processVoiceQueue(), 500)
          }
          console.error('❌ Fast brain failed:', err)
          return 'I\'m having trouble processing that. Could you try again?'
        }
      },
    })

    const respondPermissionTool = llm.tool({
      description: `Respond to a permission request. Call after hearing user's response.`,
      parameters: z.object({
        response: z.enum(['allow', 'deny', 'always_allow']),
      }),
      execute: async ({ response }) => {
        if (!realtimeClaudeHandler?.hasPendingPermission()) {
          return 'No pending permission.'
        }
        const pending = realtimeClaudeHandler.getPendingPermission()
        const allow = response === 'allow' || response === 'always_allow'
        realtimeClaudeHandler.respondToPermission(allow)
        await sendToFrontend({ type: 'permission_response', response, toolName: pending?.toolName })
        return `Permission ${response} for ${pending?.toolName || 'tool'}.`
      },
    })

    // Instructions for realtime voice LLM
    const realtimeInstructions = getRealtimeInstructions(workingDir)

    // Create realtime model
    const realtimeModel = createRealtimeModelFromConfig(rtConfig, realtimeInstructions)

    // Create the Agent with MINIMAL tools — fast brain handles all routing
    const agent = new voice.Agent({
      instructions: realtimeInstructions,
      llm: realtimeModel,
      tools: {
        ask_fast_brain: askFastBrainTool,
        respond_permission: respondPermissionTool,
      },
    })

    // Create the session
    const session = new voice.AgentSession({})

    return { session, agent }
  }

  // ============================================================
  // Room Event Handlers (0.9.83: registered per-session via wireRoomHandlers)
  // ============================================================
  //
  // Every handler BODY lives here in main()'s scope (closing over currentSession,
  // sendToFrontend, etc.). The actual `room.on(...)` REGISTRATION happens inside
  // wireRoomHandlers(room) — called once per fresh Room in createRoomSession().
  // We never re-use a Room after disconnect (rtc-node's Room.disconnect() runs
  // removeAllListeners() at room.js:584, wiping every listener), so handlers are
  // wired fresh onto each new instance.

  // Post-connect setup. RoomEvent.Connected is NEVER emitted by rtc-node (grep
  // of dist finds zero emit("connected") — only connectionStateChanged), so this
  // body — which used to live in a dead RoomEvent.Connected handler — is now
  // called directly from createRoomSession() after connect() resolves.
  const postConnectSetup = (room: Room, connectedRoomName: string) => {
    // 0.9.68: log Room SID + name PROMINENTLY so we can cross-reference
    // this specific session in LiveKit Cloud dashboard → Sessions tab.
    // @livekit/rtc-node Room exposes SID via async getSid() (it's resolved
    // after WebRTC handshake), so we fetch it asynchronously and log when ready.
    console.log(`✅ Connected to room: ${connectedRoomName} | t=${new Date().toISOString()}`)
    room.getSid().then((sid: string) => {
      console.log(`🔗 [LIVEKIT-DASHBOARD] room sid=${sid} name=${connectedRoomName} — search at https://cloud.livekit.io/projects → Sessions → "${sid}"`)
    }).catch((err: unknown) => {
      console.log(`⚠️ [LIVEKIT-DASHBOARD] failed to fetch room SID: ${err instanceof Error ? err.message : String(err)}`)
    })

    // 0.9.71: SDK + runtime snapshot — proves what's actually running so
    // future log forensics can rule out version drift in one grep.
    try {
      const pkgs: any = {}
      for (const name of [
        'osborn',
        '@livekit/agents',
        '@livekit/agents-plugin-openai',
        '@livekit/agents-plugin-deepgram',
        '@livekit/agents-plugin-silero',
        '@livekit/agents-plugin-google',
        '@livekit/agents-plugin-elevenlabs',
        '@livekit/agents-plugin-livekit',
        '@livekit/rtc-node',
        'livekit-server-sdk',
        '@anthropic-ai/claude-agent-sdk',
        '@google/genai',
        'openai',
      ]) {
        try { pkgs[name] = __sdkVersionRequire(`${name}/package.json`).version } catch {}
      }
      console.log('🧪 [BE-SDK-VERSIONS]', JSON.stringify({ t: new Date().toISOString(), node: process.version, pkgs }))
    } catch (err) {
      console.log('🧪 [BE-SDK-VERSIONS] failed:', err instanceof Error ? err.message : String(err))
    }

    localParticipant = room.localParticipant
    // Arm the alone timer: if we connected but no user joins within the grace
    // window (e.g. machine woken then abandoned mid-handshake), leave the room
    // rather than hold it indefinitely. Cancelled in ParticipantConnected.
    armAloneTimer()
  }

  // NOTE: previously this section also had a RoomEvent.ActiveSpeakersChanged
  // handler that interrupted TTS on any sustained audio activity (~50ms after
  // mic onset). That fired too eagerly — coughs, paper rustles, the agent's
  // own TTS bleeding through the mic, and other non-speech sounds tripped it
  // ~10-15% of the time, leaving the agent silent with no recovery path
  // (because no STT transcript would follow). Dropped in favor of the
  // user_state_changed → 'speaking' handler below, which is fed by Deepgram
  // Flux STT's speech-vs-noise classification: slower (~100-300ms) but
  // confidence-aware. The latency tradeoff is worth eliminating the false
  // interrupts at the root.

  // Disconnected handler body (0.9.83: reworked for fresh-Room-per-session).
  // The Room instance that just fired this is ALREADY dead (rtc-node ran
  // cleanupOnDisconnect + removeAllListeners). We NEVER reconnect it. If the
  // disconnect was involuntary mid-session, we create a BRAND-NEW Room joining
  // the SAME LiveKit room name so any in-flight frontend token stays valid.
  const handleRoomDisconnected = () => {
    console.log('👋 Disconnected from room')
    const disconnectedRoomName = activeRoomName
    // Clean up active research and voice queue
    voiceQueue.length = 0
    isProcessingQueue = false
    currentSpeechHandle = null
    lastInterruption = null

    if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
    stopProactiveLoop()
    if (activeResearch) {
      activeResearch.abortController.abort()
      activeResearch.cleanup()
      activeResearch = null
    }
    lastCompletedResearch = null
    currentSession = null
    currentAgent = null
    // Same disconnect-leak fix as the other two cleanup sites — kill the Claude SDK
    // subprocess BEFORE dropping the reference. See killCurrentLLM() for full context.
    killCurrentLLM('disconnected_cleanup')
    currentLLM = null
    clearFastBrainSession()
    clearPipelineFastBrainSession()

    // ── Voluntary-leave guard ──
    // If we left the room ON PURPOSE (user clicked leave → /leave-room, or the
    // agent-side alone timer fired), do NOT auto-rejoin — rejoining would
    // recreate the connection-minute burn we just stopped. The
    // destroyRoomSession() path already set intentionalLeave and will null out
    // activeRoom + arm idle-exit; here we just do bookkeeping and bail. Reset
    // the flag so a later involuntary drop still rejoins.
    if (intentionalLeave) {
      intentionalLeave = false
      livekitState.status = 'idle'
      livekitState.error = null
      livekitState.errorCode = null
      // The Room instance is dead. Drop our reference so nothing reuses it.
      activeRoom = null
      activeRoomName = null
      console.log('🕊️ Left LiveKit room intentionally — idle, awaiting /connect-room (no auto-rejoin)')
      // 0.9.73: idle machines must not bill forever — stop the Fly machine
      // after the grace window unless a /connect-room revives us first.
      armIdleExitTimer('intentional leave → idle')
      return
    }

    // ── Involuntary drop (LiveKit evicted our WS: idle, network blip, quota) ──
    // The old code called room.connect() on the SAME (now-listener-less) Room —
    // which "succeeded" but produced a deaf agent every time (no events reached
    // the wiped listeners). Fix: discard the dead instance and create a FRESH
    // Room rejoining the SAME LiveKit room name so any in-flight frontend token
    // stays valid. status='retrying' closes the lie window until reconnect.
    activeRoom = null
    activeRoomName = null
    livekitState.status = 'retrying'
    livekitState.error = 'LiveKit room disconnected; attempting to rejoin'
    livekitState.errorCode = 'disconnected'
    console.log(`🔄 Rejoining LiveKit room after involuntary disconnect (fresh Room, same name: ${disconnectedRoomName})...`)
    createRoomSession(disconnectedRoomName || buildRoomName()).catch(err => {
      console.error('❌ Reconnect createRoomSession threw:', err)
      livekitState.status = 'failed'
      livekitState.error = err instanceof Error ? err.message : String(err)
    })
  }

  // wireRoomHandlers(room): register EVERY room.on(...) listener onto a fresh
  // Room instance. Called once per session from createRoomSession(). The bodies
  // close over main()-scope state; `room` is the fresh instance passed in.
  const wireRoomHandlers = (room: Room) => {
    // 0.9.71: Room-level audio observability — observe-only logs so we can
    // cross-reference user mic mute/quality changes against TTS cutoffs without
    // re-introducing the over-eager ActiveSpeakers interrupt.
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: any[]) => {
      try {
        const ids = (speakers || []).map((s: any) => s?.identity).filter(Boolean)
        console.log(`🎙️ [ROOM-SPEAKERS] count=${ids.length} ids=${JSON.stringify(ids)} t=${new Date().toISOString()}`)
      } catch {}
    })
    room.on(RoomEvent.ConnectionQualityChanged, (quality: any, participant: any) => {
      try {
        console.log(`📶 [ROOM-QUALITY] participant=${participant?.identity} quality=${quality} t=${new Date().toISOString()}`)
      } catch {}
    })
    room.on(RoomEvent.TrackMuted, (publication: any, participant: any) => {
      try {
        console.log(`🔇 [ROOM-TRACK-MUTED] participant=${participant?.identity} kind=${publication?.kind} source=${publication?.source} sid=${publication?.sid} t=${new Date().toISOString()}`)
      } catch {}
    })
    room.on(RoomEvent.TrackUnmuted, (publication: any, participant: any) => {
      try {
        console.log(`🔊 [ROOM-TRACK-UNMUTED] participant=${participant?.identity} kind=${publication?.kind} source=${publication?.source} sid=${publication?.sid} t=${new Date().toISOString()}`)
      } catch {}
    })
    room.on(RoomEvent.TrackSubscribed, (track: any, publication: any, participant: any) => {
      try {
        console.log(`📥 [ROOM-TRACK-SUBSCRIBED] participant=${participant?.identity} kind=${track?.kind} source=${publication?.source} sid=${publication?.sid} t=${new Date().toISOString()}`)
      } catch {}
    })
    room.on(RoomEvent.TrackUnsubscribed, (track: any, publication: any, participant: any) => {
      try {
        console.log(`📤 [ROOM-TRACK-UNSUBSCRIBED] participant=${participant?.identity} kind=${track?.kind} source=${publication?.source} sid=${publication?.sid} t=${new Date().toISOString()}`)
      } catch {}
    })

    room.on(RoomEvent.Disconnected, handleRoomDisconnected)
    room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => { participantConnectedHandler?.(p) })
    room.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected)
    room.on(RoomEvent.DataReceived, handleDataReceived)
  }

  // 0.9.83: handler kept as a named reference so createRoomSession's adopt-sweep
  // can CALL it directly for participants already in the room at join time
  // (they fire no ParticipantConnected event — rtc-node populates them from the
  // connect callback, not via events).
  participantConnectedHandler = async (participant: RemoteParticipant) => {
    console.log(`\n👤 User joined: ${participant.identity}`)
    // The meeting canvas joining as a listener = browser-parity audio path is
    // LIVE: the agent's normal session.say plays through the canvas into the
    // meeting, so tts_say suppression/redirect must stand down.
    if (participant.identity === 'meeting-canvas') {
      meetingCanvasInRoom = true
      console.log('📽️🔊 meeting-canvas joined the LiveKit room — native session.say relays to the meeting')
      return // not a user; skip session setup for it
    }
    // A user (re)arriving cancels the meeting leave-grace — the bot stays.
    cancelMeetingLeaveGrace()

    // A user is present — cancel any pending agent-side "alone" leave.
    if (aloneTimer) { clearTimeout(aloneTimer); aloneTimer = null }
    // 0.9.83: and the fast tab-close leave (user rejoined within the grace).
    cancelFastLeaveTimer()
    // 0.9.73: and any pending idle machine self-stop.
    cancelIdleExitTimer()

    // Wait for previous session's byte stream handler to fully deregister.
    // Quick reconnects (< ~6s) crash with "byte stream handler already set" without this.
    if (pendingSessionClose) {
      console.log('⏳ Waiting for previous session to fully close...')
      await pendingSessionClose
    }

    // Clean up any existing session before creating a new one
    voiceQueue.length = 0
    isProcessingQueue = false
    currentSpeechHandle = null
    lastInterruption = null

    if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
    stopProactiveLoop()
    clearFastBrainSession()
    clearPipelineFastBrainSession()
    if (activeResearch) {
      activeResearch.abortController.abort()
      activeResearch.cleanup()
      activeResearch = null
    }
    lastCompletedResearch = null
    if (currentSession) {
      console.log('🧹 Cleaning up previous session...')
      try {
        await currentSession.close()
      } catch {}
      try {
        currentSession.removeAllListeners()
      } catch {}
      currentSession = null
      currentAgent = null
      // Same disconnect-leak fix — kill the previous user's Claude subprocess
      // before binding currentLLM to the new user's session below.
      killCurrentLLM('previous_session_cleanup')
      currentLLM = null
    }

    // Extract voice architecture, provider, and sessionId from participant metadata (sent by frontend)
    // This overrides the config file setting for per-session flexibility
    let sessionVoiceMode: VoiceMode = voiceMode  // Default to config
    let sessionRealtimeProvider: 'gemini' | 'openai' = realtimeConfig.provider  // Default to config
    let preSelectedSessionId: string | null = null
    try {
      const metadata = JSON.parse(participant.metadata || '{}')
      console.log(`📋 Participant metadata:`, metadata)
      // userId from authenticated Supabase session — used to scope Supabase
      // Storage uploads so each user's workspace artifacts live under their
      // own prefix. Falls through to '' (anonymous) if not authenticated.
      if (typeof metadata.userId === 'string' && metadata.userId.length > 0) {
        currentUserId = metadata.userId
      } else {
        currentUserId = ''
      }
      if (metadata.voiceArch === 'realtime' || metadata.voiceArch === 'direct' || metadata.voiceArch === 'pipeline') {
        sessionVoiceMode = metadata.voiceArch
        console.log(`🎙️ Using voice mode from frontend: ${sessionVoiceMode}`)
      } else if (metadata.voiceArch) {
        console.log(`⚠️ Unknown voiceArch "${metadata.voiceArch}", using config: ${voiceMode}`)
      }
      // Read provider selection from frontend (openai or gemini)
      if (metadata.provider === 'openai' || metadata.provider === 'gemini') {
        sessionRealtimeProvider = metadata.provider
        console.log(`🎙️ Using provider from frontend: ${sessionRealtimeProvider}`)
      }
      // Read pre-selected session ID from frontend (session browser selection)
      if (metadata.sessionId && typeof metadata.sessionId === 'string' && metadata.sessionId.length > 0) {
        preSelectedSessionId = metadata.sessionId
        console.log(`📂 Pre-selected session from frontend: ${preSelectedSessionId}`)
      }
      // Read working directory override from frontend.
      //
      // If the path doesn't exist yet (new project on first use, or freshly
      // imported sessions on a new sprite), create it with mkdirSync so the
      // agent can accept it. This is safe: recursive mkdirSync is a no-op when
      // the directory already exists, and project paths always live under the
      // workspace root. The Claude SDK child_process.spawn requires the cwd to
      // exist — mkdirSync satisfies that requirement without silently falling back.
      if (metadata.workingDirectory && typeof metadata.workingDirectory === 'string' && metadata.workingDirectory.length > 0) {
        if (!existsSync(metadata.workingDirectory)) {
          mkdirSync(metadata.workingDirectory, { recursive: true })
          console.log(`📁 Created project directory: ${metadata.workingDirectory}`)
        }
        workingDir = metadata.workingDirectory
        console.log(`📂 Working directory from frontend: ${workingDir}`)
      } else {
        // Reset to default for new connections (in case previous session changed it)
        workingDir = defaultWorkingDir
      }
    } catch (err) {
      console.log('⚠️ Could not parse participant metadata, using config voiceMode:', voiceMode)
    }

    // Sync to outer scope so DataReceived handler can use it
    currentVoiceMode = sessionVoiceMode
    currentProvider = sessionRealtimeProvider

    // Resume session ID — only set when resuming an existing session
    const resumeSessionId = preSelectedSessionId || undefined
    currentResumeSessionId = resumeSessionId
    if (resumeSessionId) {
      console.log(`🆔 Resuming session: ${resumeSessionId}`)
    } else {
      console.log(`🆔 New session (ID assigned by SDK)`)
    }

    // Ensure Claude is authenticated before creating voice session
    // In cloud deployments (Fly.io), this triggers OAuth flow on first boot:
    // captures login URL → sends to frontend → user clicks → gets code → pastes in frontend → auth completes
    try {
      const authResult = await ensureClaudeAuth((type, payload) => {
        sendToFrontend({ type, ...payload as object })
      })
      // If auth flow is running, store the submitCode handler for the DataReceived handler
      if (authResult.submitCode && authResult.done) {
        pendingAuthSubmitCode = authResult.submitCode
        await authResult.done
        pendingAuthSubmitCode = null
      }
    } catch (err: any) {
      console.error('❌ Claude authentication failed:', err?.message)
      sendToFrontend({ type: 'claude_auth_error', message: err?.message || 'Authentication failed' })
      pendingAuthSubmitCode = null
      // Continue anyway — the agent SDK will use ANTHROPIC_API_KEY if available
    }

    // Create session based on voice mode (from frontend or config)
    let session: voice.AgentSession
    let agent: voice.Agent

    if (sessionVoiceMode === 'realtime') {
      // Override the config provider with the frontend's selection
      const sessionRealtimeConfig = { ...realtimeConfig, provider: sessionRealtimeProvider }
      console.log(`🎙️ REALTIME MODE: ${sessionRealtimeConfig.provider} native speech-to-speech`)
      const result = await createRealtimeSession(sessionRealtimeConfig, resumeSessionId)
      session = result.session
      agent = result.agent
    } else if (sessionVoiceMode === 'pipeline') {
      console.log(`🎯 PIPELINE MODE: Claude SDK + parallel Gemini fast brain observer`)
      // Pipeline mode = direct mode underneath + parallel fast brain
      // Fast brain runs in PipelineDirectLLM.chat() — fires Gemini alongside Claude
      const { createPipelineDirectLLM } = await import('./pipeline-direct-llm.js')
      const pipelineLLM = createPipelineDirectLLM({
        workingDirectory: workingDir,
        sessionBaseDir,
        mcpServers,
        resumeSessionId,
        voiceMode: 'direct',
        skipTTSQueue: true,
        // PipelineDirectOptions extends ClaudeLLMOptions; passing this through
        // forwards it into the inner `new ClaudeLLM(opts)`. Without this,
        // pipeline mode silently drops every PreCompact/PostCompact event
        // — banner never appears, chat bubble never appears — because
        // createDirectSession's `createClaudeLLM(...)` call is skipped when
        // an llmOverride is supplied (which is exactly what pipeline mode does).
        onCompactionEvent: buildOnCompactionEvent(),
        getChatHistory: () => getChatHistory(20).map(t => ({ role: t.role, content: t.text })),
        getResearchContext: () => {
          if (activeResearch?.researchLog.length) {
            return `Research: "${lastTaskRequest}"\n${activeResearch.researchLog.slice(-15).join('\n')}`
          }
          if (lastCompletedResearch && Date.now() - lastCompletedResearch.completedAt < 600000) {
            return `[COMPLETED] "${lastCompletedResearch.task}"\n${lastCompletedResearch.researchLog.slice(-15).join('\n')}`
          }
        },
        getAndConsumeInterruptionContext,
        onFastBrainResult: (result) => {
          console.log(`🧠⚡ [FAST_BRAIN ${result.type.toUpperCase()} +${result.elapsedMs}ms]: "${result.answer.substring(0, 60)}"`)
          sendToFrontend({
            type: 'fast_brain_response',
            text: result.answer,
            responseType: result.type,
            elapsedMs: result.elapsedMs,
            question: result.question,
            toolsUsed: result.toolsUsed,
            agentRole: 'pipeline-fast-brain',
          })
        },
      })
      // Pass pipelineLLM to createDirectSession so it uses it instead of creating a new ClaudeLLM
      const result = await createDirectSession(resumeSessionId, pipelineLLM)
      session = result.session
      agent = result.agent
    } else {
      console.log(`🎯 DIRECT MODE: Claude Agent SDK with full coding capabilities`)
      const result = await createDirectSession(resumeSessionId)
      session = result.session
      agent = result.agent
    }
    currentSession = session
    currentAgent = agent  // Store for updateChatCtx() context injection

    // ============================================================
    // Session event wiring — extracted into function for auto-recovery
    // ============================================================
    let lastRecoveryTime = 0
    const MIN_RECOVERY_INTERVAL = 3000  // 3 seconds between recovery attempts

    function wireSessionEvents(sess: voice.AgentSession, agt: voice.Agent) {
      // Transcript dedup state (reset per wiring)
      let lastSentUserTranscript = ''
      let lastSentAgentTranscript = ''

      function sendUserTranscript(transcript: string, source: string) {
        if (!transcript || transcript.length < 3) return
        const normalized = transcript.trim().replace(/\s+/g, ' ')
        if (normalized === lastSentUserTranscript) return
        if (normalized === '<noise>' || normalized.toLowerCase() === 'thank you') return
        // Filter out voice injection content that appears as user transcript
        // (Gemini v1.0.51: userInput in generateReply creates a user conversation item)
        if (normalized.startsWith('[SCRIPT]') || normalized.startsWith('[PROACTIVE]') || normalized.startsWith('[NOTIFICATION]')) return

        console.log(`📝 User (${source}, ${transcript.length} chars): "${transcript}"`)
        sendToFrontend({ type: 'user_transcript', text: transcript })
        lastSentUserTranscript = normalized
      }

      function sendAgentTranscript(text: string, source: string) {
        if (!text || text.length < 3) return
        const normalized = text.trim().replace(/\s+/g, ' ')
        if (normalized === lastSentAgentTranscript) return

        console.log(`💬 Agent (${source}, ${text.length} chars): "${text}"`)
        sendToFrontend({ type: 'assistant_response', text })
        lastSentAgentTranscript = normalized
      }

      // PRIMARY: conversation_item_added is the authoritative source
      sess.on('conversation_item_added' as any, (ev: any) => {
        let text = ''
        if (Array.isArray(ev.item?.content)) {
          text = typeof ev.item.content[0] === 'string'
            ? ev.item.content.join('\n')
            : ev.item.content.map((c: any) => c.text).filter(Boolean).join('\n')
        } else if (typeof ev.item?.content === 'string') {
          text = ev.item.content
        } else if (ev.item?.text) {
          text = ev.item.text
        }

        if (ev.item?.role === 'user' && text) {
          sendUserTranscript(text, 'conv_item')
        } else if (ev.item?.role === 'assistant' && text) {
          sendAgentTranscript(text, 'conv_item')
        }
      })

      // FALLBACK: user_speech_committed
      sess.on('user_speech_committed' as any, (ev: any) => {
        const transcript = ev.transcript || ev.text || ''
        sendUserTranscript(transcript, 'committed')
      })

      // Agent state tracking
      sess.on('agent_state_changed' as any, (ev: any) => {
        agentState = ev.newState
        // Clear processing guard when model transitions to any new state
        isProcessingQueue = false
        console.log(`🤖 State: ${ev.newState}`)
        sendToFrontend({ type: 'agent_state', state: ev.newState })

        // When the model becomes available (listening), process any queued voice injections
        if (ev.newState === 'listening' && voiceQueue.length > 0) {
          setTimeout(() => processVoiceQueue(), 500)  // 500ms to let model settle
        }
      })

      // User state tracking — prevents queue from colliding with server-side VAD.
      // Also the PRIMARY interrupt trigger now that the over-eager ActiveSpeakersChanged
      // path is gone. Fires when Deepgram Flux STT classifies frames as speech (not noise)
      // and propagates via agent_activity.onStartOfSpeech → _updateUserState('speaking').
      // Latency ~100-300ms after mic onset, which is the cost of confidence-aware
      // detection — vs the prior ActiveSpeakers handler that fired at ~50ms on any audio
      // activity and tripped ~10-15% false interrupts on coughs, paper rustle, agent's
      // own TTS bleeding through the mic, etc.
      sess.on('user_state_changed' as any, (ev: any) => {
        const prev = userState
        userState = ev.newState
        console.log(`👤 User state: ${prev} → ${ev.newState} (agent: ${agentState})`)

        if (ev.newState === 'speaking' && agentState === 'speaking' && sessionVoiceMode !== 'realtime') {
          // 0.9.67: action commented out, condition + debug kept.
          //
          // Why removed: in @livekit/agents 1.4.x SpeechHandle.interrupt() calls
          //   replyAbortController.abort() → AbortSignal.any composes into the
          //   OpenAI TTS HTTP fetch → arrayBuffer() throws AbortError →
          //   APIUserAbortError (openai/client.mjs:364) → SDK marks the error
          //   recoverable:false → connOptions.maxUnrecoverableErrors counter trips
          //   → session collapses. In 1.2.1 the same call was a hard-kill that
          //   never reached an HTTP fetch — that's why it ran fine for ~1 month
          //   under the silently caret-resolved 1.4.5 (which had inherited the
          //   abort plumbing) until it crossed the unrecoverable-errors threshold.
          //
          // What handles interruption now: SDK 1.4.x's gated path —
          //   turnHandling.interruption.{minDuration:2500, minWords:4,
          //   falseInterruptionTimeout:4000, resumeFalseInterruption:true}
          //   pauses TTS via audioOutput.pause() (no abort) and either resumes
          //   on a false trigger or hard-interrupts on a confirmed barge-in.
          //
          // Debug: this block now ONLY observes — logs what we'd have interrupted
          //   on so we can compare against the SDK's own behavior. If the SDK
          //   under-reacts to real barge-ins we can re-enable selectively.
          try {
            const evKeys = ev && typeof ev === 'object' ? Object.keys(ev) : []
            const evShape = evKeys.reduce((acc: any, k) => {
              const v = (ev as any)[k]
              acc[k] = (v && typeof v === 'object') ? `<object:${Object.keys(v).join(',')}>` : v
              return acc
            }, {})
            console.log('🔎 [DEBUG] manual-interrupt WOULD HAVE FIRED — SDK gated path now owns it:', JSON.stringify({
              t: new Date().toISOString(),
              userPrev: prev,
              userNew: ev.newState,
              agentState,
              sessionVoiceMode,
              evKeys,
              evShape,
            }))
            // currentSession?.interrupt()  // ← 0.9.67 DISABLED: cascades to APIUserAbortError → recoverable:false → session collapse
          } catch (err) {
            console.warn('⚠️ user-state interrupt debug failed:', err instanceof Error ? err.message : err)
          }
        }

        // When user stops speaking, retry voice queue — items may be waiting
        if (ev.newState === 'listening' && voiceQueue.length > 0) {
          setTimeout(() => processVoiceQueue(), 500)
        }
      })

      // ============================================================
      // Interrupt-debug instrumentation (0.9.63) — log every SDK event
      // that touches the pause/resume + transcript path so we can correlate
      // a "TTS stream stalled" or visible cutoff to the exact transcript
      // text + timing that triggered it.
      //
      // The events below are emitted by AgentSession in @livekit/agents 1.4.6.
      // Each line prints with a wall-clock timestamp so it can be cross-referenced
      // against the WARN/ERROR lines from the SDK itself.
      // ============================================================

      // user_input_transcribed — the actual transcript Deepgram emitted.
      // Fires for BOTH interim and final transcripts. This is the smoking-gun
      // log for false interrupts: if echo bleeds through and Deepgram transcribes
      // a 1-2 word fragment, you'll see it here a fraction of a second before
      // user_state_changed=speaking or the SDK fires interruptByAudioActivity.
      sess.on('user_input_transcribed' as any, (ev: any) => {
        const t = ev.transcript ?? ''
        const isFinal = !!ev.isFinal
        const words = t.trim().split(/\s+/).filter(Boolean).length
        const tag = isFinal ? '📝 FINAL' : '✏️  interim'
        console.log(`${tag} transcript (${words}w, ${t.length}c) [${new Date().toISOString()}]: "${t.slice(0, 120)}${t.length > 120 ? '…' : ''}"`)
      })

      // overlapping_speech — SDK detected user audio while agent was speaking.
      // This is the moment the pause path fires (before any interrupt() call).
      sess.on('overlapping_speech' as any, (ev: any) => {
        console.log(`🔁 OVERLAPPING SPEECH detected [${new Date().toISOString()}]:`, JSON.stringify({
          type: ev.type,
          isInterruption: ev.isInterruption,
          interruptedAt: ev.interruptedAt,
          // Whatever else SDK provides — dump it all for now
          fields: Object.keys(ev),
        }))
      })

      // agent_false_interruption — the SDK's "actually that was a false alarm,
      // resuming TTS" event. Fires falseInterruptionTimeout after a pause.
      // resumed:true means the TTS audio was resumed cleanly; resumed:false
      // means resume was attempted but blocked (canPause check, etc.) — the
      // canonical signal for our deadlock scenario.
      sess.on('agent_false_interruption' as any, (ev: any) => {
        console.log(`✅ AGENT FALSE INTERRUPTION [${new Date().toISOString()}]:`, JSON.stringify({
          resumed: ev.resumed,
          createdAt: ev.createdAt,
        }))
      })

      // speech_created — every time TTS audio is queued. Lets us correlate
      // a speech-handle id back to the transcript that triggered it.
      sess.on('speech_created' as any, (ev: any) => {
        console.log(`🗣️  SPEECH CREATED [${new Date().toISOString()}]:`, JSON.stringify({
          speechId: ev.speechHandle?.id,
          source: ev.source,
          userInitiated: ev.userInitiated,
        }))
      })


      // FALLBACK: playout_completed
      sess.on('playout_completed' as any, (ev: any) => {
        const message = ev.message || ev.text || ev.content
        console.log(`🎧 PLAYOUT COMPLETED [${new Date().toISOString()}]:`, JSON.stringify({
          speechId: ev.speechHandle?.id ?? ev.speechId,
          interrupted: ev.interrupted,
          durationMs: ev.durationMs,
          messageLen: message ? message.length : 0,
        }))
        if (message && message.length > 0) {
          sendAgentTranscript(message, 'playout')
        }
      })

      // 0.9.71: metrics_collected — per-call latency for STT/TTS/LLM/VAD/EOU/Interruption.
      // SINGLE highest-signal event for diagnosing audio cutoffs.
      //   • TTSMetrics.ttfbMs / durationMs / audioDurationMs / cancelled → directly answers
      //     "did the OpenAI HTTP fetch hang or did it complete and the SDK aborted?"
      //   • STTMetrics.audioDurationMs / durationMs → Deepgram latency per utterance
      //   • LLMMetrics.ttftMs → cold-vs-warm Claude subprocess
      //   • EOUMetrics.endOfUtteranceDelayMs / transcriptionDelayMs → end-of-turn timing
      //   • InterruptionMetrics.{detectionDelay, numInterruptions, numBackchannels} →
      //     turn-detector signal at the source
      sess.on('metrics_collected' as any, (ev: any) => {
        const m = ev?.metrics
        if (!m) return
        const compact: any = { type: m.type, label: m.label, t: new Date().toISOString() }
        // Per-type subset — keep tight
        if (m.type === 'tts_metrics') {
          compact.ttfbMs = Math.round(m.ttfbMs ?? -1)
          compact.durationMs = Math.round(m.durationMs ?? -1)
          compact.audioDurationMs = Math.round(m.audioDurationMs ?? -1)
          compact.cancelled = !!m.cancelled
          compact.charactersCount = m.charactersCount
          compact.streamed = !!m.streamed
          compact.speechId = m.speechId
        } else if (m.type === 'stt_metrics') {
          compact.audioDurationMs = Math.round(m.audioDurationMs ?? -1)
          compact.durationMs = Math.round(m.durationMs ?? -1)
          compact.streamed = !!m.streamed
        } else if (m.type === 'llm_metrics') {
          compact.ttftMs = Math.round(m.ttftMs ?? -1)
          compact.durationMs = Math.round(m.durationMs ?? -1)
          compact.cancelled = !!m.cancelled
          compact.completionTokens = m.completionTokens
          compact.promptTokens = m.promptTokens
          compact.speechId = m.speechId
        } else if (m.type === 'vad_metrics') {
          compact.idleTimeMs = Math.round(m.idleTimeMs ?? -1)
          compact.inferenceCount = m.inferenceCount
        } else if (m.type === 'eou_metrics') {
          compact.endOfUtteranceDelayMs = Math.round(m.endOfUtteranceDelayMs ?? -1)
          compact.transcriptionDelayMs = Math.round(m.transcriptionDelayMs ?? -1)
          compact.onUserTurnCompletedDelayMs = Math.round(m.onUserTurnCompletedDelayMs ?? -1)
          compact.speechId = m.speechId
        } else if (m.type === 'interruption_metrics') {
          compact.detectionDelay = Math.round(m.detectionDelay ?? -1)
          compact.predictionDuration = Math.round(m.predictionDuration ?? -1)
          compact.numInterruptions = m.numInterruptions
          compact.numBackchannels = m.numBackchannels
          compact.numRequests = m.numRequests
        }
        console.log(`📈 [METRICS]`, JSON.stringify(compact))
      })

      // 0.9.71: function_tools_executed — when a tool batch completes inside the SDK.
      sess.on('function_tools_executed' as any, (ev: any) => {
        try {
          const calls = ev?.functionCalls?.length ?? 0
          const outputs = ev?.functionOutputs?.length ?? 0
          console.log(`🛠️ [TOOLS-EXECUTED] calls=${calls} outputs=${outputs} t=${new Date().toISOString()}`)
        } catch {}
      })

      // 0.9.68: mirror SDK's internal unrecoverable-error counters so we can
      // see EXACTLY how close we are to closeImpl() firing (default threshold 3).
      // Counter resets on each successful "speaking" transition (agent_session.js:740).
      let __ttsErrorCounter = 0
      let __llmErrorCounter = 0
      const __maxUnrecov = 3 // SDK default DEFAULT_SESSION_CONNECT_OPTIONS.maxUnrecoverableErrors

      // Error handler
      sess.on('error' as any, (ev: any) => {
        const msg = ev.error?.message || String(ev.error)
        const errType = ev.type || 'unknown'
        const recoverable = ev.recoverable

        // 0.9.68: counter mirror — increment for recoverable:false same as SDK does
        if (recoverable === false) {
          if (errType === 'tts_error') __ttsErrorCounter++
          else if (errType === 'llm_error') __llmErrorCounter++
        }
        const willCloseNext = (__ttsErrorCounter > __maxUnrecov || __llmErrorCounter > __maxUnrecov)
        console.log(`📊 [ERROR-COUNTER] type=${errType} recoverable=${recoverable} ttsErrorCount=${__ttsErrorCounter}/${__maxUnrecov} llmErrorCount=${__llmErrorCounter}/${__maxUnrecov} willCloseNext=${willCloseNext} t=${new Date().toISOString()}`)

        // OpenAI race: voice queue collided with server-side VAD auto-response
        if (msg.includes('conversation_already_has_active_response') || msg.includes('active_response')) {
          console.log('⚠️ OpenAI active response collision — queue will retry on next listening state')
          return
        }
        // TTS abort from user interruption is normal — not an error
        if (msg.includes('Request was aborted') || msg.includes('APIUserAbortError') || msg.includes('aborted')) {
          console.log('⚠️ LLM request aborted (user interrupted)')
          return
        }
        console.error('❌ Session error:', ev.error)
      })

      // 0.9.68: reset error counter mirror when SDK does (on speaking transition).
      // Reuses the existing agent_state_changed handler logic — fires AFTER.
      sess.on('agent_state_changed' as any, (ev: any) => {
        if (ev.newState === 'speaking' && (__ttsErrorCounter > 0 || __llmErrorCounter > 0)) {
          console.log(`📊 [COUNTER-RESET] speaking transition cleared ttsErrorCount=${__ttsErrorCounter}→0 llmErrorCount=${__llmErrorCounter}→0`)
          __ttsErrorCounter = 0
          __llmErrorCounter = 0
        }
      })

      // Capture voice mode at session creation — prevents state confusion
      // if currentVoiceMode changes between session start and crash recovery
      const sessionVoiceMode = currentVoiceMode

      // Close handler with auto-recovery for crashes (both realtime and direct modes)
      sess.on('close' as any, async (ev: any) => {
        console.log('🚪 Session closed:', ev.reason)

        // ORPHAN-BOT GUARD (fix 2026-08-01): an abrupt AgentSession close
        // (e.g. a driver tab killed → reason 'user_initiated', with NO clean
        // ParticipantDisconnected) must not leave the Recall bot stuck in-call
        // draining credits. Arm the meeting leave-grace so endMeeting() fires
        // (bot leaves + LLM released) once the room is genuinely empty. A rejoin
        // cancels it; error/disconnected closes still auto-recover below and the
        // grace is harmless there (recovery + rejoin cancels it).
        if (activeMeetingBotId) {
          console.log('📽️ Meeting active on session close — arming leave-grace (bot leaves if no user returns)')
          armMeetingLeaveGrace()
        }

        // TTS abort from user interruption — SDK already killed the session internally,
        // so we MUST recover (can't just reset state — STT pipeline is dead).
        // Log it distinctly so we know it's an interrupt recovery, not a real crash.
        const errorMsg = ev.error?.message || ev.error?.error?.message || ''
        const isTTSAbort = errorMsg.includes('aborted') || errorMsg.includes('APIUserAbortError')
        if (isTTSAbort) {
          console.log('⚠️ TTS abort from user interruption — recovering session (SDK killed it internally)')
        }

        // Auto-recover from crashes in direct/pipeline mode (includes TTS abort)
        if ((ev.reason === 'error' || ev.reason === 'disconnected') && (sessionVoiceMode === 'direct' || sessionVoiceMode === 'pipeline')) {
          const now = Date.now()
          if (now - lastRecoveryTime < MIN_RECOVERY_INTERVAL) {
            console.log(`⚠️ Recovery too frequent — scheduling retry in ${MIN_RECOVERY_INTERVAL}ms`)
            setTimeout(async () => {
              // Re-check: if session was already recovered or user left, skip
              if (currentSession || !activeRoom || !activeRoom.remoteParticipants.size) return
              console.log('🔄 Retrying direct mode recovery after guard interval...')
              // Trigger recovery by emitting a synthetic close
              sess.emit('close' as any, { reason: 'error' })
            }, MIN_RECOVERY_INTERVAL)
            return
          }
          lastRecoveryTime = now

          console.log(`🔄 Auto-recovering direct mode session (reason: ${ev.reason})...`)

          // Clean up dead session — match realtime recovery's thoroughness
          try { sess.removeAllListeners() } catch {}
          currentSession = null
          currentAgent = null

          // Clear stale state from crashed session
          voiceQueue.length = 0
          isProcessingQueue = false
          haikuInFlight = null
          if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
          stopProactiveLoop()
          if (activeResearch) { activeResearch.abortController.abort(); activeResearch.cleanup(); activeResearch = null }

          try {
            // Reuse existing session ID so Claude SDK resumes where it left off
            const recoverySessionId = currentLLM?.sessionId || resumeSessionId

            // Stop old index watcher if it exists
            if (currentLLM && 'stopIndexWatcher' in currentLLM) {
              (currentLLM as any).stopIndexWatcher()
            }

            let result
            if (sessionVoiceMode === 'pipeline') {
              // Pipeline mode: recreate PipelineDirectLLM wrapper with fast brain
              console.log('🔄 Rebuilding pipeline mode (PipelineDirectLLM + fast brain)...')
              const { createPipelineDirectLLM } = await import('./pipeline-direct-llm.js')
              const pipelineLLM = createPipelineDirectLLM({
                workingDirectory: workingDir,
                sessionBaseDir,
                mcpServers,
                resumeSessionId: recoverySessionId,
                voiceMode: 'direct',
                skipTTSQueue: true,
                getChatHistory: () => getChatHistory(20).map(t => ({ role: t.role, content: t.text })),
                getResearchContext: () => {
                  if (activeResearch?.researchLog.length) {
                    return `Research: "${lastTaskRequest}"\n${activeResearch.researchLog.slice(-15).join('\n')}`
                  }
                  if (lastCompletedResearch && Date.now() - lastCompletedResearch.completedAt < 600000) {
                    return `[COMPLETED] "${lastCompletedResearch.task}"\n${lastCompletedResearch.researchLog.slice(-15).join('\n')}`
                  }
                },
                getAndConsumeInterruptionContext,
                onFastBrainResult: (r) => {
                  console.log(`🧠⚡ [FAST_BRAIN ${r.type.toUpperCase()} +${r.elapsedMs}ms]: "${r.answer.substring(0, 60)}"`)
                  sendToFrontend({
                    type: 'fast_brain_response', text: r.answer, responseType: r.type,
                    elapsedMs: r.elapsedMs, question: r.question, toolsUsed: r.toolsUsed,
                    agentRole: 'pipeline-fast-brain',
                  })
                },
              })
              result = await createDirectSession(recoverySessionId, pipelineLLM)
            } else {
              result = await createDirectSession(recoverySessionId)
            }
            const newSession = result.session
            const newAgent = result.agent
            currentSession = newSession
            currentAgent = newAgent

            // Re-wire event listeners on the new session
            wireSessionEvents(newSession, newAgent)

            await newSession.start({ agent: newAgent, room: activeRoom! })

            // Sync state
            agentState = 'listening'
            sendToFrontend({ type: 'agent_state', state: 'listening' })

            // Resume Claude session if one was active
            if (currentLLM?.sessionId) {
              currentLLM.setContinueSession(true)
            }

            console.log('✅ Direct mode auto-recovery complete')

            // Notify user via TTS
            try {
              const recoveredId = currentLLM?.sessionId || recoverySessionId
              if (recoveredId) {
                const conversationHistory = await getConversationHistory(recoveredId, workingDir, 10)
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const script = await prepareRecoveryScript(historyForScript)
                // Direct mode: use session.say() for recovery notification
                newSession.say(script, { allowInterruptions: true })
              } else {
                newSession.say('Voice session was briefly interrupted but I\'m back. What were we working on?', { allowInterruptions: true })
              }
            } catch (err) {
              console.log('⚠️ Failed to generate recovery script:', err)
              try { newSession.say('I\'m back after a brief interruption. What were we working on?', { allowInterruptions: true }) } catch {}
            }
          } catch (err) {
            console.error('❌ Direct mode auto-recovery failed:', err)
            sendToFrontend({ type: 'agent_state', state: 'error' })
          }
          return
        }

        // Auto-recover from crashes in realtime mode
        if (ev.reason === 'error' && sessionVoiceMode === 'realtime') {
          const now = Date.now()
          if (now - lastRecoveryTime < MIN_RECOVERY_INTERVAL) {
            console.log('⚠️ Recovery too frequent — skipping to prevent loop')
            sendToFrontend({ type: 'agent_state', state: 'error' })
            return
          }
          lastRecoveryTime = now

          console.log('🔄 Auto-recovering from session crash...')

          // Clean up dead session
          try { sess.removeAllListeners() } catch {}
          currentSession = null
          currentAgent = null

          // Clear voice queue — stale injections from the crashed session
          voiceQueue.length = 0
          isProcessingQueue = false
      
          if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
          stopProactiveLoop()
                if (activeResearch) { activeResearch.abortController.abort(); activeResearch.cleanup(); activeResearch = null }

          try {
            const recoveryConfig = { ...realtimeConfig, provider: currentProvider as 'gemini' | 'openai' }
            // Reuse existing session ID for workspace continuity during recovery
            // Prefer real SDK session ID, fall back to original resume ID
            const recoverySessionId = currentLLM?.sessionId || resumeSessionId
            const result = await createRealtimeSession(recoveryConfig, recoverySessionId)
            const newSession = result.session
            const newAgent = result.agent
            currentSession = newSession
            currentAgent = newAgent

            // Re-wire event listeners on the new session
            wireSessionEvents(newSession, newAgent)

            await newSession.start({ agent: newAgent, room: activeRoom! })

            // Sync state
            agentState = 'listening'
            sendToFrontend({ type: 'agent_state', state: 'listening' })

            // Resume Claude session if one was active
            if (currentLLM?.sessionId) {
              currentLLM.setContinueSession(true)
            }

            // Generate recovery script via fast brain
            const recoveredSessionId = currentLLM?.sessionId || recoverySessionId
            if (recoveredSessionId) {
              try {
                const conversationHistory = await getConversationHistory(recoveredSessionId, workingDir, 10)
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const script = await prepareRecoveryScript(historyForScript)
                queueVoiceInjection(getScriptInjection(script))
                console.log('📋 Injected recovery script into recovered session')
              } catch (err) {
                console.log('⚠️ Failed to generate recovery script:', err)
                queueVoiceInjection(getNotificationInjection('Voice session was briefly interrupted but I\'m back. What were we working on?'))
              }
            } else {
              queueVoiceInjection(getNotificationInjection('Voice session was briefly interrupted but I\'m back. What were we working on?'))
            }

            console.log('✅ Auto-recovery complete')
          } catch (err) {
            console.error('❌ Auto-recovery failed:', err)
            sendToFrontend({ type: 'agent_state', state: 'error' })
          }
        }
      })
    }

    // Wire events on the initial session
    wireSessionEvents(session, agent)

    // Start voice session
    console.log('🎬 Starting voice session...')

    try {
      await session.start({ agent, room: activeRoom! })
      console.log('✅ Voice session started!')
      console.log('🎤 Ready - speak to begin!\n')

      // Workspace is created later in the session_id event handler (when SDK assigns real ID)

      // Send ready signal with persistent retry
      console.log('💓 Sending agent_ready signal...')
      let readySent = false
      const provider = sessionVoiceMode === 'realtime' ? realtimeConfig.provider : 'claude'

      // Fetch full session list for startup session browser (all Claude projects)
      const allSessions = await listAllClaudeSessions(50)
      const recentSessionId = allSessions.length > 0 ? allSessions[0].sessionId : null
      const hasRecentSession = allSessions.length > 0

      // Prepare sessions for frontend (up to 50)
      const sessionsForFrontend = allSessions.slice(0, 50).map(s => ({
        sessionId: s.sessionId,
        projectSlug: s.projectSlug,
        projectPath: s.projectPath,
        cwd: s.cwd,
        timestamp: s.timestamp.toISOString(),
        lastMessage: s.lastMessage,
        messageCount: s.messageCount,
        fileSize: s.fileSize,
      }))

      const sendReady = async () => {
        if (readySent) return
        await sendToFrontend({
          type: 'agent_ready',
          provider,
          voiceMode: sessionVoiceMode,
          hasRecentSession,
          recentSessionId,
          sessions: sessionsForFrontend,
          preSelectedSessionId,
          mcpServers: getMcpServerStatusList(config),
          enabledMcpServers: enabledMcpNames,
          workingDirectory: workingDir,
          skills: loadSkillsList(sessionBaseDir),
          namedAgents: Object.entries(NAMED_AGENTS).map(([name, a]: [string, any]) => ({
            name, description: a.description, model: a.model, tools: a.tools,
          })),
        })
      }
      const readyInterval = setInterval(sendReady, 2000)
      await sendReady()
      setTimeout(() => {
        clearInterval(readyInterval)
        console.log('✅ agent_ready retries complete')
      }, 20000)

      // Stop agent_ready retries on user speech
      session.on('input_speech_started' as any, () => {
        readySent = true
        clearInterval(readyInterval)
      })

      // Greet user via TTS (delayed if resume prompt will be shown)
      // For realtime mode: use generateReply() since there's no standalone TTS
      // For direct mode: use say() which goes through the configured TTS
      const greetViaVoice = async (text: string) => {
        if (sessionVoiceMode === 'realtime') {
          // Use instructions (not userInput) to avoid system text appearing as user transcript
          await session.generateReply({ instructions: getScriptInjection(text) })
        } else {
          await (session as any).say(text)
        }
      }

      if (preSelectedSessionId && sessionExists(preSelectedSessionId, workingDir)) {
        // User pre-selected a session from the session browser — auto-resume immediately
        console.log(`📂 Auto-resuming pre-selected session: ${preSelectedSessionId}`)
        if (currentLLM) {
          currentLLM.setResumeSessionId(preSelectedSessionId)
          console.log(`🔄 Session resume configured: ${preSelectedSessionId}`)

          // Fetch context and greet with it
          const summary = await getSessionSummary(preSelectedSessionId, workingDir)
          const conversationHistory = await getConversationHistory(preSelectedSessionId, workingDir, 30)

          await sendToFrontend({
            type: 'session_resume_set',
            sessionId: preSelectedSessionId,
            success: true,
          })

          // Send existing workspace artifacts to frontend (session-scoped)
          const preArtifacts = listWorkspaceArtifacts(workingDir, preSelectedSessionId!)
          if (preArtifacts.length > 0) {
            console.log(`📁 Sending ${preArtifacts.length} workspace artifacts to frontend`)
            await sendToFrontend({
              type: 'session_artifacts',
              sessionId: preSelectedSessionId,
              artifacts: preArtifacts.map(a => ({
                filePath: a.filePath,
                fileName: a.fileName,
                type: a.type,
                updatedAt: a.updatedAt,
              }))
            })
          }

          // Generate briefing script via fast brain
          if (summary) {
            loadSessionHistoryIntoChatCtx(currentAgent, conversationHistory, currentProvider)
            try {
              if (sessionVoiceMode === 'realtime') {
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const script = await prepareBriefingScript(workingDir, preSelectedSessionId, historyForScript)
                await session.generateReply({ instructions: getScriptInjection(script) })
              } else {
                await (session as any).say("Welcome back! Ready to continue our previous conversation.")
              }
            } catch (err) {
              console.log('⚠️ Pre-selected session greeting failed:', err)
            }
          }
        }
      } else if (!preSelectedSessionId && hasRecentSession) {
        // No pre-selected session but sessions exist — defer greeting for session gate
        console.log('⏳ Deferring greeting until session gate is completed')
      } else {
        // No sessions at all (or new session chosen) — greet as new user
        try {
          console.log('👋 Sending greeting...')
          await greetViaVoice("Hey! I'm Osborn, your AI research assistant. What are you working on today?")
          console.log('✅ Greeting sent')
        } catch (err) {
          console.log('⚠️ Greeting failed:', err)
        }
      }
    } catch (err) {
      console.error('❌ Failed to start session:', err)
    }
  }

  // ParticipantConnected is registered in wireRoomHandlers (delegates to
  // participantConnectedHandler above).

  const handleParticipantDisconnected = (participant: RemoteParticipant) => {
    console.log(`👋 User left: ${participant.identity}`)

    // Full cleanup — stop all background work to avoid accumulating API usage
    voiceQueue.length = 0
    isProcessingQueue = false
    currentSpeechHandle = null
    lastInterruption = null

    if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
    stopProactiveLoop()
    if (activeResearch) {
      activeResearch.abortController.abort()
      activeResearch.cleanup()
      activeResearch = null
    }

    if (currentSession) {
      const sessionToClose = currentSession
      currentSession = null
      // Track async close so new connections can wait for byte stream handler to be released
      pendingSessionClose = (async () => {
        try { await sessionToClose.close() } catch {}
        try { sessionToClose.removeAllListeners() } catch {}
        pendingSessionClose = null
      })()
    }
    currentAgent = null

    if (activeMeetingBotId) {
      // MEETING SURVIVES A VOICE-SESSION DROP (fix 2026-08-01). The bot's brain
      // is the persistent Claude LLM; killing it on every participant blip left
      // the Recall bot permanently DEAF mid-call ("Addressed" fired but never
      // "Flushed" — currentLLM was null; proven via synthetic transcript inject).
      // Keep currentLLM alive so meeting transcripts still flush + reply
      // (speakIntoMeeting is Recall-direct, needs no LiveKit session). The
      // leave-grace below owns teardown: if the user is truly gone at 75s,
      // endMeeting() releases the LLM (its !userPresent branch). A rejoin cancels
      // the grace. DO NOT arm the 20s fast-leave here — it would destroy the room
      // before the meeting grace and orphan the bot; the meeting grace is the
      // single teardown while a meeting is live.
      console.log('📽️ Meeting active — keeping currentLLM alive across the voice-session drop (leave-grace owns teardown)')
      armMeetingLeaveGrace()
    } else {
      // Kill the Claude SDK subprocess BEFORE dropping the reference, otherwise the
      // persistent session keeps running tools and pushing TTS into a dead session.
      killCurrentLLM('participant_disconnected')
      currentLLM = null
      clearFastBrainSession()
      clearPipelineFastBrainSession()

      // Auto-leave path for a NON-meeting session. 0.9.83: a real session just
      // ended → use the FAST leave (~20s), not the 3-min alone grace. Fires even
      // on an abrupt tab close; cancelled if a user rejoins within the grace.
      armMeetingLeaveGrace()   // no-op when no meeting, kept for symmetry
      armFastLeaveTimer()
    }

    // Tear down IDE if one is running — user has disconnected, no point keeping
    // code-server alive for a departed session.
    if (ideCodeServerProc) {
      stopIde()
    }

    console.log('⏳ Waiting for new user...\n')
  }

  const handleDataReceived = async (payload: Uint8Array, participant: RemoteParticipant | undefined, kind: unknown, topic: string | undefined) => {
    if (topic !== 'user-input') return

    try {
      const data = JSON.parse(new TextDecoder().decode(payload))
      console.log('📨 Data:', data.type)

      if (data.type === 'claude_auth_code' && pendingAuthSubmitCode) {
        console.log('🔑 Received auth code from frontend')
        sendToFrontend({ type: 'claude_auth_submitting', message: 'Submitting code to Claude CLI...' })
        pendingAuthSubmitCode(data.code)
      } else if (data.type === 'permission_response') {
        // Handle permission response for direct mode
        if (currentLLM && currentLLM.hasPendingPermission?.()) {
          const allow = data.response === 'allow' || data.response === 'always_allow'
          // Track always_allow paths for this session so future requests auto-approve
          if (data.response === 'always_allow' && data.filePath) {
            sessionAlwaysAllowPaths.add(String(data.filePath))
            console.log(`🔒 Always-allow added for session: ${data.filePath}`)
          }
          currentLLM.respondToPermission(allow)
          console.log(`✅ Permission: ${data.response}`)
        }
      } else if (data.type === 'user_text' && currentSession) {
        // Build message content — include attached files (URLs, text content)
        let fullContent = String(data.content || '')
        const files = data.files as Array<{ name: string; type: string; content?: string; url?: string }> | undefined
        if (files && files.length > 0) {
          for (const f of files) {
            if (f.url) {
              fullContent += `\n\n[${f.type === 'image' ? 'Image' : 'File'}: ${f.name}](${f.url})`
            } else if (f.type === 'text' && f.content) {
              fullContent += `\n\n[File: ${f.name}]\n${f.content}`
            } else if (f.type === 'image' && f.content) {
              fullContent += `\n\n[Image attached: ${f.name}]`
            }
          }
          console.log(`📝 Text + ${files.length} file(s) (${fullContent.length} chars): "${fullContent}"`)
        } else {
          console.log(`📝 Text (${fullContent.length} chars): "${fullContent}"`)
        }
        // Skip interrupt for Gemini — disrupts state machine (hangs in speaking state)
        if (currentProvider !== 'gemini') {
          currentSession.interrupt()
        }
        await currentSession.generateReply({ userInput: fullContent })
      }
      // ============================================================
      // SESSION MANAGEMENT HANDLERS
      // ============================================================
      else if (data.type === 'list_sessions') {
        // List available sessions across all Claude projects
        console.log('📋 Listing available sessions (all projects)...')
        try {
          const sessions = await listAllClaudeSessions(100)
          await sendToFrontend({
            type: 'sessions_list',
            // See `/sessions` HTTP handler — baseCwd is the agent's
            // workingDir, the base layer the dashboard groups against.
            // Sent here too so the in-chat session list grouping stays
            // consistent with the dashboard's grouping.
            baseCwd: workingDir,
            sessions: sessions.map(s => ({
              sessionId: s.sessionId,
              projectSlug: s.projectSlug,
              projectPath: s.projectPath,
              cwd: s.cwd,
              timestamp: s.timestamp.toISOString(),
              lastMessage: s.lastMessage,
              messageCount: s.messageCount,
              fileSize: s.fileSize,
            })),
            count: sessions.length,
          })
        } catch (err) {
          console.error('Failed to list sessions:', err)
          await sendToFrontend({
            type: 'sessions_list',
            sessions: [],
            count: 0,
            error: 'Failed to list sessions',
          })
        }
      }
      else if (data.type === 'resume_session' && currentLLM) {
        // Lightweight: set resume ID and send artifacts to frontend only
        // Context injection (generateReply) happens in session_selected handler
        // to avoid double generateReply calls that cause timeouts
        const sessionId = data.sessionId as string
        if (sessionId && sessionExists(sessionId, workingDir)) {
          currentLLM.setResumeSessionId(sessionId)
          currentResumeSessionId = sessionId
          console.log(`🔄 Will resume session: ${sessionId}`)

          await sendToFrontend({
            type: 'session_resume_set',
            sessionId,
            success: true,
          })

          // Send existing session artifacts to frontend (session-scoped)
          const artifacts = listWorkspaceArtifacts(workingDir, sessionId)
          if (artifacts.length > 0) {
            console.log(`📁 Sending ${artifacts.length} session artifacts to frontend`)
            await sendToFrontend({
              type: 'session_artifacts',
              sessionId,
              artifacts: artifacts.map(a => ({
                filePath: a.filePath,
                fileName: a.fileName,
                type: a.type,
                updatedAt: a.updatedAt,
              }))
            })
          }
        } else {
          // Try to find the session in any slug directory
          let found = false
          const projectsDir = join(homedir(), '.claude', 'projects')

          if (existsSync(projectsDir)) {
            const slugDirs = readdirSync(projectsDir)
            for (const slug of slugDirs) {
              const candidate = join(projectsDir, slug, `${sessionId}.jsonl`)
              if (existsSync(candidate)) {
                // Recover the original path from the slug
                const recoveredPath = slug.replace(/^-/, '/').replace(/--/g, '/.').replace(/-/g, '/')
                if (recoveredPath && recoveredPath !== '/') {
                  mkdirSync(recoveredPath, { recursive: true })
                  workingDir = recoveredPath
                  currentLLM.setWorkingDirectory(recoveredPath)
                  console.log(`🔄 Found session in slug ${slug}, using path: ${recoveredPath}`)
                  found = true

                  // Proceed with the same success path
                  currentLLM.setResumeSessionId(sessionId)
                  currentResumeSessionId = sessionId
                  console.log(`🔄 Will resume session: ${sessionId}`)

                  await sendToFrontend({
                    type: 'session_resume_set',
                    sessionId,
                    success: true,
                  })

                  const artifacts = listWorkspaceArtifacts(workingDir, sessionId)
                  if (artifacts.length > 0) {
                    console.log(`📁 Sending ${artifacts.length} session artifacts to frontend`)
                    await sendToFrontend({
                      type: 'session_artifacts',
                      sessionId,
                      artifacts: artifacts.map(a => ({
                        filePath: a.filePath,
                        fileName: a.fileName,
                        type: a.type,
                        updatedAt: a.updatedAt,
                      }))
                    })
                  }
                  break
                }
              }
            }
          }

          if (!found) {
            console.error(`❌ Session not found: ${sessionId}`)
            await sendToFrontend({
              type: 'session_resume_set',
              sessionId,
              success: false,
              error: 'Session not found',
            })
          }
        }
      }
      else if (data.type === 'continue_session' && currentLLM) {
        const recentId = await getMostRecentSessionId(workingDir)
        if (recentId) {
          currentLLM.setResumeSessionId(recentId)
          currentResumeSessionId = recentId
          console.log(`🔄 Continuing most recent session: ${recentId}`)

          const summary = await getSessionSummary(recentId, workingDir)
          const conversationHistory = await getConversationHistory(recentId, workingDir, 30)

          await sendToFrontend({
            type: 'session_resume_set',
            sessionId: recentId,
            success: true,
          })

          // Send existing session artifacts to frontend (session-scoped)
          const artifacts = listWorkspaceArtifacts(workingDir, recentId)
          if (artifacts.length > 0) {
            console.log(`📁 Sending ${artifacts.length} session artifacts to frontend`)
            await sendToFrontend({
              type: 'session_artifacts',
              sessionId: recentId,
              artifacts: artifacts.map(a => ({
                filePath: a.filePath,
                fileName: a.fileName,
                type: a.type,
                updatedAt: a.updatedAt,
              }))
            })
          }

          if (currentSession && summary) {
            loadSessionHistoryIntoChatCtx(currentAgent, conversationHistory, currentProvider)
            console.log('📋 Injecting session context into voice agent...')
            try {
              if (currentVoiceMode === 'realtime') {
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const script = await prepareBriefingScript(workingDir, recentId, historyForScript)
                await currentSession.generateReply({ instructions: getScriptInjection(script) })
              } else {
                await (currentSession as any).say("Continuing where we left off.")
              }
            } catch (err) {
              console.log('⚠️ Context injection failed:', err)
            }
          }
        } else {
          console.log('📋 No previous sessions found - starting fresh')
          await sendToFrontend({
            type: 'session_resume_set',
            sessionId: null,
            success: false,
            error: 'No previous sessions found',
          })
        }
      }
      else if (data.type === 'switch_session' && currentLLM) {
        // Switch to a different session mid-conversation
        const sessionId = data.sessionId as string

        if (sessionId && sessionExists(sessionId, workingDir)) {
          // Step 1: Get FULL context summary with conversation history
          const summary = await getSessionSummary(sessionId, workingDir)
          const conversationHistory = await getConversationHistory(sessionId, workingDir, 30)

          // Step 2: Reset LLM state and configure for new session
          currentLLM.resetForSessionSwitch()
          currentLLM.setResumeSessionId(sessionId)
          currentResumeSessionId = sessionId
          clearFastBrainSession()
    clearPipelineFastBrainSession()
          console.log(`🔄 Switched to session: ${sessionId}`)

          // Step 3: Send full context to frontend (including conversation history)
          await sendToFrontend({
            type: 'session_switched',
            sessionId,
            success: true,
            summary,
            conversationHistory,
          })

          // Step 3.5: Send existing session artifacts to frontend (session-scoped)
          const switchArtifacts = listWorkspaceArtifacts(workingDir, sessionId)
          if (switchArtifacts.length > 0) {
            console.log(`📁 Sending ${switchArtifacts.length} session artifacts to frontend`)
            await sendToFrontend({
              type: 'session_artifacts',
              sessionId,
              artifacts: switchArtifacts.map(a => ({
                filePath: a.filePath,
                fileName: a.fileName,
                type: a.type,
                updatedAt: a.updatedAt,
              }))
            })
          }

          // Step 4: Voice agent acknowledges context via fast brain
          if (currentSession && summary) {
            loadSessionHistoryIntoChatCtx(currentAgent, conversationHistory, currentProvider)
            try {
              if (currentVoiceMode === 'realtime') {
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const briefingScript = await prepareBriefingScript(workingDir, sessionId, historyForScript, 'switch')
                queueVoiceInjection(getScriptInjection(briefingScript))
              } else {
                const acknowledgment = summary.lastMessages.length > 0
                  ? `I've switched to your previous session. You were working on: ${summary.lastMessages[summary.lastMessages.length - 1]?.substring(0, 100)}`
                  : `Switched to previous session with ${summary.messageCount} messages. What would you like to continue with?`
                await (currentSession as any).say(acknowledgment)
              }
            } catch (err) {
              console.log('⚠️ Switch acknowledgment failed:', err)
            }
          }
        } else {
          await sendToFrontend({
            type: 'session_switched',
            sessionId,
            success: false,
            error: 'Session not found',
          })
        }
      }
      else if (data.type === 'get_current_session' && currentLLM) {
        // Get current session ID
        await sendToFrontend({
          type: 'current_session',
          sessionId: currentLLM.sessionId,
          isResumingSession: currentLLM.isResumingSession,
        })
      }
      else if (data.type === 'get_session_artifacts') {
        const sessionId = data.sessionId as string
        if (sessionId) {
          const artifacts = listWorkspaceArtifacts(workingDir, sessionId)
          console.log(`📁 Sending ${artifacts.length} session artifacts for ${sessionId.substring(0, 8)}`)
          await sendToFrontend({
            type: 'session_artifacts',
            sessionId,
            artifacts: artifacts.map(a => ({
              filePath: a.filePath,
              fileName: a.fileName,
              type: a.type,
              updatedAt: a.updatedAt,
            }))
          })
        }
      }
      // ============================================================
      // SESSION GATE HANDLER (initial session selection before voice)
      // ============================================================
      else if (data.type === 'get_plan_file') {
        const filePath = data.filePath as string
        if (filePath && filePath.includes('.claude/plans/')) {
          try {
            const fs = await import('fs')
            const content = fs.readFileSync(filePath, 'utf-8')
            await sendToFrontend({ type: 'plan_file_content', filePath, content, fileName: filePath.split('/').pop() })
          } catch (err) {
            await sendToFrontend({ type: 'plan_file_content', filePath, content: '', error: (err as Error).message })
          }
        }
      }
      else if (data.type === 'get_research_artifact') {
        const filePath = data.filePath as string
        if (filePath && (filePath.includes('/osb/') || filePath.includes('.osborn/sessions/') || filePath.includes('.osborn/research/'))) {
          try {
            const fs = await import('fs')
            const path = await import('path')
            const fileName = filePath.split('/').pop() || ''
            const ext = fileName.split('.').pop()?.toLowerCase() || ''
            const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)
            const mimeByExt: Record<string, string> = {
              png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
              gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
              html: 'text/html', md: 'text/markdown', txt: 'text/plain',
              json: 'application/json',
            }
            const mimeType = mimeByExt[ext] || 'application/octet-stream'

            // Strategy: upload the file to Supabase Storage via the frontend's
            // /api/upload route and send back just the URL. This mirrors the
            // existing frontend→agent attachment flow (where the browser uploads
            // user attachments to Supabase and passes URLs to the agent). For
            // the reverse direction we do the same: URLs are ~100 bytes, so
            // the LiveKit data channel stays healthy regardless of file size.
            //
            // Fallback to inline send if OSBORN_FRONTEND_URL isn't configured
            // OR the upload fails — with a small size cap so we don't kill the
            // publisher PC with a 480KB payload (see earlier career-ops bug).
            const FRONTEND_URL = process.env.OSBORN_FRONTEND_URL || process.env.NEXT_PUBLIC_FRONTEND_URL || ''
            const MAX_INLINE_BYTES = 30_000 // fallback-only cap

            let uploadedUrl: string | null = null
            if (FRONTEND_URL) {
              try {
                const buf = fs.readFileSync(filePath)
                const form = new FormData()
                form.append('file', new Blob([buf as any], { type: mimeType }), fileName)
                form.append('folder', 'artifacts')
                // Pass userId + sessionId so /api/upload can place the file
                // under `{userId}/{sessionId}/...` in Supabase Storage for
                // easy ownership queries and future RLS policies. Both are
                // optional — route falls back to `artifacts/...` if missing.
                if (currentUserId) form.append('userId', currentUserId)
                // Prefer the live resume session id (updated by session
                // switches), fall back to whatever SDK session id the LLM
                // reports, fall back to empty.
                const uploadSessionId = currentResumeSessionId
                  || (currentLLM as any)?.sessionId
                  || ''
                if (uploadSessionId) form.append('sessionId', uploadSessionId)
                const r = await fetch(`${FRONTEND_URL.replace(/\/$/, '')}/api/upload`, {
                  method: 'POST', body: form,
                  signal: AbortSignal.timeout(15_000),
                })
                if (r.ok) {
                  const j = await r.json() as { success?: boolean; url?: string; error?: string }
                  if (j.success && j.url) {
                    uploadedUrl = j.url
                    console.log(`☁️ Uploaded artifact to Supabase: ${fileName} (${(buf.length / 1024).toFixed(0)}KB) → ${j.url.substring(0, 80)}...`)
                  } else {
                    console.warn(`⚠️ Upload failed for ${fileName}: ${j.error || 'unknown'}`)
                  }
                } else {
                  console.warn(`⚠️ Upload HTTP ${r.status} for ${fileName}`)
                }
              } catch (err) {
                console.warn(`⚠️ Upload threw for ${fileName}:`, (err as Error).message)
              }
            }

            if (uploadedUrl) {
              // Success path — send URL, no inline content.
              await sendToFrontend({
                type: 'research_artifact_content',
                filePath, fileName, url: uploadedUrl,
                isImage, mimeType,
              })
            } else if (isImage) {
              // Fallback: inline image (with size cap)
              const stats = fs.statSync(filePath)
              const base64Size = Math.ceil(stats.size * 4 / 3)
              if (base64Size > MAX_INLINE_BYTES) {
                console.log(`⚠️ Artifact too large for inline fallback: ${fileName} (${(base64Size / 1024).toFixed(0)}KB base64) — sending truncation notice`)
                await sendToFrontend({ type: 'research_artifact_content', filePath, content: '', fileName, isImage: false, truncated: true, originalSize: stats.size })
              } else {
                const base64 = fs.readFileSync(filePath, 'base64')
                await sendToFrontend({ type: 'research_artifact_content', filePath, content: base64, fileName, isImage: true, mimeType })
              }
            } else {
              // Fallback: inline text (with size cap)
              const content = fs.readFileSync(filePath, 'utf-8')
              if (Buffer.byteLength(content, 'utf-8') > MAX_INLINE_BYTES) {
                const truncated = content.substring(0, 5_000)
                console.log(`⚠️ Artifact too large for inline fallback: ${fileName} (${(Buffer.byteLength(content, 'utf-8') / 1024).toFixed(0)}KB) — sending truncated preview`)
                await sendToFrontend({ type: 'research_artifact_content', filePath, content: truncated, fileName, isImage: false, truncated: true, originalSize: Buffer.byteLength(content, 'utf-8') })
              } else {
                await sendToFrontend({ type: 'research_artifact_content', filePath, content, fileName, isImage: false })
              }
            }
          } catch (err) {
            await sendToFrontend({ type: 'research_artifact_content', filePath, content: '', error: (err as Error).message })
          }
        }
      }
      // ============================================================
      // MCP SERVER TOGGLE HANDLERS
      // ============================================================
      else if (data.type === 'mcp_toggle' && currentLLM) {
        const serverKey = data.serverKey as string
        const enabled = data.enabled as boolean
        console.log(`🔌 MCP toggle: ${serverKey} → ${enabled ? 'ON' : 'OFF'}`)

        if (enabled) {
          try {
            // Check if this is a Smithery HTTP server — use proxy to bypass SDK bug
            const catalogEntry = MCP_CATALOG.find(e => e.serverKey === serverKey)
            const isSmitheryServer = catalogEntry?.url && isSmitheryUrl(catalogEntry.url)

            if (isSmitheryServer && catalogEntry?.url) {
              // Smithery cloud server: use in-process proxy (bypasses SDK HTTP bug #18296)
              const parsed = parseSmitheryUrl(catalogEntry.url)
              if (parsed) {
                const proxyConfig = await createSmitheryProxy({
                  name: serverKey,
                  namespace: parsed.namespace,
                  connectionId: parsed.connectionId,
                })
                currentLLM.enableMcpServer(serverKey, proxyConfig)
                await announceViaVoice(`${serverKey} tools enabled.`)
              } else {
                throw new Error(`Could not parse Smithery URL: ${catalogEntry.url}`)
              }
            } else {
              // Non-Smithery server: use standard config (stdio or direct http)
              const serverConfigs = buildMcpServersForKeys(config, [serverKey])
              const serverConfig = serverConfigs[serverKey]
              if (serverConfig) {
                currentLLM.enableMcpServer(serverKey, serverConfig)
                await announceViaVoice(`${serverKey} tools enabled.`)
              } else {
                throw new Error('Server configuration not found')
              }
            }
          } catch (err) {
            const errorMsg = err instanceof SmitheryAuthorizationError
              ? `OAuth required: ${err.authorizationUrl}`
              : (err as Error).message
            console.error(`❌ MCP toggle failed for ${serverKey}: ${errorMsg}`)
            await sendToFrontend({
              type: 'mcp_toggle_result',
              serverKey,
              success: false,
              error: errorMsg,
            })
          }
        } else {
          await destroySmitheryProxy(serverKey) // Clean up proxy if exists
          currentLLM.disableMcpServer(serverKey)
          await announceViaVoice(`${serverKey} tools disabled.`)
        }

        // Send updated status back
        await sendToFrontend({
          type: 'mcp_toggle_result',
          serverKey,
          enabled,
          success: true,
          mcpServers: getMcpServerStatusList(config),
          enabledKeys: currentLLM.getEnabledMcpServerKeys(),
        })
      }
      else if (data.type === 'get_mcp_status') {
        // Frontend requesting current MCP status
        const statusList = getMcpServerStatusList(config)
        const enabledKeys = currentLLM?.getEnabledMcpServerKeys() || []
        // Merge runtime enabled state into status list
        const mergedStatus = statusList.map(s => ({
          ...s,
          enabled: enabledKeys.includes(s.serverKey),
        }))
        await sendToFrontend({
          type: 'mcp_status',
          mcpServers: mergedStatus,
          enabledKeys,
        })
      }
      else if (data.type === 'get_skills') {
        await sendToFrontend({
          type: 'skills_status',
          skills: loadSkillsList(sessionBaseDir),
        })
      }
      else if (data.type === 'get_agents') {
        // Named sub-agents for the chat agents manager — built-ins (minus any
        // user-removed) merged with per-user DB-backed definitions.
        const effectiveBase: Record<string, any> = { ...NAMED_AGENTS }
        for (const r of userRemovedAgents) delete effectiveBase[r]
        const effective = { ...effectiveBase, ...(userNamedAgents || {}) }
        await sendToFrontend({
          type: 'agents_status',
          agents: Object.entries(effective).map(([name, a]: [string, any]) => ({
            name, description: a.description, model: a.model, tools: a.tools,
            custom: !!userNamedAgents && name in userNamedAgents,
          })),
        })
      }
      else if (data.type === 'set_agents') {
        // Per-user named agents from the DB (frontend fetches its user_agents
        // rows and sends them here after agent_ready, and again after edits).
        // Validated + merged over built-ins, applied via setAgents(). SDK
        // constraint: takes effect at the next query cold start — a live
        // subprocess keeps the agents it started with.
        const MODELS = new Set(['sonnet', 'opus', 'haiku', 'fable', 'inherit'])
        const rows = Array.isArray(data.agents) ? data.agents : []
        const validated: NonNullable<typeof userNamedAgents> = {}
        for (const r of rows) {
          const name = String(r?.name || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
          const description = String(r?.description || '').trim()
          const prompt = String(r?.prompt || '').trim()
          if (!name || !description || !prompt) continue
          if (prompt.length > 6000) { console.warn(`🤖 set_agents: '${name}' prompt >6KB — skipped`); continue }
          validated[name] = {
            description,
            prompt,
            ...(Array.isArray(r.tools) && r.tools.length ? { tools: r.tools.map(String) } : {}),
            ...(r.model && (MODELS.has(r.model) || /^claude-/.test(r.model)) ? { model: String(r.model) } : {}),
          }
        }
        userNamedAgents = Object.keys(validated).length ? validated : null
        // Removed built-ins (tombstones) — excluded from the effective set.
        userRemovedAgents = Array.isArray(data.removed) ? data.removed.map(String) : []
        const base: Record<string, any> = { ...NAMED_AGENTS }
        for (const r of userRemovedAgents) delete base[r]
        const merged = { ...base, ...(userNamedAgents || {}) }
        const customized = !!userNamedAgents || userRemovedAgents.length > 0
        ;(currentLLM as any)?.setAgents?.(customized ? merged : undefined)
        console.log(`🤖 set_agents: ${Object.keys(validated).length} user agent(s), ${userRemovedAgents.length} removed → effective [${Object.keys(merged).join(', ')}]`)
        await sendToFrontend({
          type: 'agents_status',
          agents: Object.entries(merged).map(([name, a]: [string, any]) => ({
            name, description: a.description, model: a.model, tools: a.tools,
            custom: !!userNamedAgents && name in userNamedAgents,
          })),
        })
      }
      else if (data.type === 'skill_add') {
        const skillName = (data.name as string || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
        const skillContent = (data.content as string || '').trim()
        if (!skillName || !skillContent) {
          await sendToFrontend({ type: 'skill_add_result', success: false, error: 'Name and content are required' })
        } else {
          try {
            const skillDir = join(sessionBaseDir, '.claude', 'skills', skillName)
            mkdirSync(skillDir, { recursive: true })
            writeFileSync(join(skillDir, 'SKILL.md'), skillContent, 'utf-8')
            console.log(`📚 Skill added: ${skillName}`)
            const skills = loadSkillsList(sessionBaseDir)
            await sendToFrontend({ type: 'skill_add_result', success: true, skills })
          } catch (err) {
            console.error('❌ Failed to add skill:', err)
            await sendToFrontend({ type: 'skill_add_result', success: false, error: String(err) })
          }
        }
      }
      else if (data.type === 'skill_get') {
        const folder = (data.name as string || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
        const p = join(sessionBaseDir, '.claude', 'skills', folder, 'SKILL.md')
        if (folder && existsSync(p)) {
          await sendToFrontend({ type: 'skill_content', name: folder, content: readFileSync(p, 'utf-8') })
        } else {
          await sendToFrontend({ type: 'skill_content', name: folder, error: 'skill not found' })
        }
      }
      else if (data.type === 'skill_remove') {
        const folder = (data.name as string || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
        const dir = join(sessionBaseDir, '.claude', 'skills', folder)
        if (!folder || !existsSync(dir)) {
          await sendToFrontend({ type: 'skill_remove_result', success: false, error: 'skill not found' })
        } else {
          try {
            rmSync(dir, { recursive: true, force: true })
            console.log(`🗑️ Skill removed: ${folder}`)
            await sendToFrontend({ type: 'skill_remove_result', success: true, skills: loadSkillsList(sessionBaseDir) })
          } catch (err) {
            await sendToFrontend({ type: 'skill_remove_result', success: false, error: String(err) })
          }
        }
      }
      // Feature B — per-flow stop (does NOT affect other running flows)
      else if (data.type === 'stop_dispatch' && currentLLM) {
        currentLLM.stopAgent?.(String(data.agentId))
      }
      else if (data.type === 'join_meeting') {
        const meetingUrl = data.url as string
        if (meetingUrl) {
          const recallJoin = getRecallClient()
          if (!recallJoin) {
            await sendToFrontend({ type: 'meeting_error', message: 'Recall.ai not configured — set RECALL_API_KEY in .env' })
          } else {
            try {
              const webhookBase = (data.webhookBase as string) ||
                (process.env.FLY_APP_NAME
                  ? `https://${process.env.FLY_APP_NAME}.fly.dev`
                  : `http://localhost:${apiPort}`)
              // Transcript: Recall captures meeting audio internally; we get it
              // live via the realtime webhook (+ REST poll backstop). Output:
              // the bot casts the meeting canvas as its camera+mic (below), so
              // it can show visuals and speak into the meeting on demand.
              await sendToFrontend({ type: 'meeting_joining', message: 'Osborn is joining your meeting...' })
              // CANVAS + AUDIO (2026-08-01, live-verified A/B): the canvas
              // webpage camera shows VISUALS (captions, screenshots, transcript
              // animation) AND Recall output_audio delivers the VOICE — the two
              // coexist (confirmed: output_audio audible while the canvas camera
              // was showing). speakIntoMeeting routes voice→output_audio +
              // caption→canvas (no audio), so no double-audio. The canvas page's
              // OWN Web Audio is NOT used for voice (it's suspended headless).
              const frontendUrl = (process.env.OSBORN_FRONTEND_URL || 'https://www.voice-native.com').replace(/\/$/, '')
              const canvasUrl = /^https:\/\//.test(webhookBase)
                ? `${frontendUrl}/meeting-canvas?agent=${encodeURIComponent(webhookBase)}`
                : undefined
              const castUrl = (data.castUrl as string) || process.env.OSBORN_MEETING_CAST_URL || canvasUrl
              const botId = await recallJoin.joinMeeting(meetingUrl, webhookBase, { castUrl })
              const sessionId = currentLLM?.sessionId || currentResumeSessionId || 'default'
              recallJoin.registerBot(botId, sessionId)
              activeMeetingBotId = botId
              await sendToFrontend({ type: 'meeting_joined', botId, message: 'Osborn has joined the meeting' })

              // Minimal awareness injection (user directive 2026-08-04): tell the
              // LLM it's in a meeting and how transcripts are tagged — nothing
              // more. NO "do NOT speak / silent observer" coaching (that fought
              // the goal of the reply being exactly the main agent's response).
              // The agent responds to meeting turns the same way it responds on
              // the website; note-taking is an optional background task, not a
              // replacement for responding.
              if (currentLLM) {
                try {
                  const sysCtx = new llm.ChatContext()
                  sysCtx.addMessage({
                    role: 'user',
                    content: `[SYSTEM] You are now in a meeting (Recall bot ID: ${botId}, URL: ${meetingUrl}). Live transcript arrives tagged \`[MEETING — ${botId}]:\`. Respond to what's said exactly as you naturally would — same as on the website, no special meeting phrasing. You may keep meeting-todos.md updated in the workspace in the background, but responding comes first.`,
                  })
                  currentLLM.chat({ chatCtx: sysCtx })
                  console.log('📓 Meeting awareness injection sent to LLM')
                } catch (sysErr) {
                  console.warn('⚠️ Meeting system injection failed:', (sysErr as Error).message)
                }
              }

              // Start polling the transcript every 30s. Each batch of new turns
              // is pushed to currentLLM.chat() tagged [MEETING — botId]: so the
              // skill kicks in. Poller dedups via first-word timestamp cursor.
              if (activeMeetingPoller) {
                activeMeetingPoller.stop()
                activeMeetingPoller = null
              }
              activeMeetingPoller = new MeetingTranscriptPoller({
                botId,
                recall: recallJoin,
                onTurns: async ({ formatted }) => {
                  if (!currentLLM) {
                    console.warn('📓 Meeting transcript arrived but currentLLM is null — dropping')
                    return
                  }
                  const tagged = `[MEETING — ${botId}]:\n${formatted}`
                  try {
                    const turnCtx = new llm.ChatContext()
                    turnCtx.addMessage({ role: 'user', content: tagged })
                    currentLLM.chat({ chatCtx: turnCtx })
                  } catch (err) {
                    console.warn(`⚠️ Failed to forward meeting transcript to LLM: ${(err as Error).message}`)
                  }
                },
                // Authoritative meeting-over signal: Recall's terminal bot status
                // (call_ended/done/fatal), checked on the same 30s tick. The bot
                // is already gone at that point, so don't re-issue leave.
                onMeetingEnd: (code) => { void endMeeting(`recall_status:${code}`, { leaveBot: false }) },
              })
              activeMeetingPoller.start()
              // LIVE path: buffer webhook finals + flush to the LLM every 20s.
              // (The poller above only lands data after the meeting ENDS.)
              startMeetingFlush(botId)
              // Billing backstop: a forgotten meeting can't hold the machine forever.
              armMeetingMaxTimer(botId)
            } catch (err: any) {
              console.error('❌ Recall.ai join error:', err)
              await sendToFrontend({ type: 'meeting_error', message: err.message })
            }
          }
        }
      }
      else if (data.type === 'leave_meeting') {
        // All teardown (flush, poller, max-timer, Recall leave, meeting_left,
        // orphan LLM release) is centralized in endMeeting().
        try {
          await endMeeting('user_leave_meeting')
        } catch (err: any) {
          console.error('❌ Recall.ai leave error:', err)
          await sendToFrontend({ type: 'meeting_error', message: err.message })
        }
      }
      // ── IDE (code-server) handlers ──────────────────────────────────────
      else if (data.type === 'start_ide') {
        try {
          await startCodeServer()
          // Build the /editor entry-point URL for the frontend to open.
          const flyAppHost = process.env.FLY_APP_NAME
            ? `${process.env.FLY_APP_NAME}.fly.dev`
            : (process.env.OSBORN_PUBLIC_HOST || `localhost:${apiPort}`)
          const ideUrl = process.env.FLY_APP_NAME
            ? `https://${flyAppHost}/editor`
            : `http://${flyAppHost}/editor`
          console.log(`✅ IDE proxy ready: ${ideUrl}`)
          await sendToFrontend({ type: 'ide_ready', url: ideUrl })
        } catch (err: any) {
          console.error('❌ start_ide error:', err)
          // Clean up any partial state.
          if (ideCodeServerProc) stopIde()
          await sendToFrontend({ type: 'ide_error', error: err.message || String(err) })
        }
      }
      else if (data.type === 'stop_ide') {
        stopIde()
      }
      // ───────────────────────────────────────────────────────────────────
      else if (data.type === 'session_selected') {
        const sessionId = data.sessionId as string | null
        console.log(`🚪 Session gate completed: ${sessionId ? `resume ${sessionId}` : 'fresh start'}`)

        if (sessionId && currentLLM && sessionExists(sessionId, workingDir)) {
          // Resume the selected session
          currentLLM.setResumeSessionId(sessionId)
          currentResumeSessionId = sessionId
          console.log(`🔄 Resuming session: ${sessionId}`)

          // Fetch context and greet with it
          const summary = await getSessionSummary(sessionId, workingDir)
          const conversationHistory = await getConversationHistory(sessionId, workingDir, 30)

          await sendToFrontend({
            type: 'session_resume_set',
            sessionId,
            success: true,
          })

          // Send existing session artifacts to frontend (session-scoped)
          const gateArtifacts = listWorkspaceArtifacts(workingDir, sessionId)
          if (gateArtifacts.length > 0) {
            console.log(`📁 Sending ${gateArtifacts.length} session artifacts to frontend`)
            await sendToFrontend({
              type: 'session_artifacts',
              sessionId,
              artifacts: gateArtifacts.map(a => ({
                filePath: a.filePath,
                fileName: a.fileName,
                type: a.type,
                updatedAt: a.updatedAt,
              }))
            })
          }

          // RESUME meeting-context fix (2026-08-05): a resumed session that
          // previously ran a meeting has NO live meeting — the in-memory bot +
          // poller reset on process/session start. But the LLM would infer
          // "still in a meeting" from the replayed [MEETING —] lines + notes and
          // refuse to leave (user hit exactly this: "why does it think we're in
          // the meeting?"). Detect meeting history in THIS session and tell the
          // LLM the meeting has ended so it behaves as a normal voice assistant.
          const hadMeeting = conversationHistory.some(e => /\[MEETING\b|now in a meeting|Recall bot ID/i.test(e.content || ''))
          if (hadMeeting && currentLLM) {
            try {
              const endedCtx = new llm.ChatContext()
              endedCtx.addMessage({ role: 'user', content: `[SYSTEM] Context note — do NOT respond out loud to this note: this conversation earlier included a LIVE meeting, but that meeting has ENDED. The Recall bot has left, you are NOT currently in a meeting, and you are NOT receiving any transcripts. Treat every earlier "[MEETING — …]" line and the meeting notes as PAST history. Respond to the user normally as a voice assistant. If they ask to "leave the meeting," tell them the meeting already ended and there is nothing active to leave.` })
              currentLLM.chat({ chatCtx: endedCtx })
              console.log('📓 Resume: injected meeting-ENDED clarification (session had meeting history)')
            } catch (e) { console.warn('⚠️ meeting-ended injection failed:', (e as Error).message) }
          }

          // Load full session history and greet with context via fast brain
          if (currentSession && summary) {
            loadSessionHistoryIntoChatCtx(currentAgent, conversationHistory, currentProvider)
            try {
              if (currentVoiceMode === 'realtime') {
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const briefingScript = await prepareBriefingScript(workingDir, sessionId, historyForScript, 'resume')
                queueVoiceInjection(getScriptInjection(briefingScript))
              } else {
                await (currentSession as any).say("Welcome back! Ready to continue our previous conversation.")
              }
            } catch (err) {
              console.log('⚠️ Session gate greeting failed:', err)
            }
          }
        } else {
          // Fresh start - greet via voice queue (not userInput, which creates a user transcript)
          currentResumeSessionId = undefined
          console.log('🆕 Starting fresh session')
          if (currentSession) {
            try {
              if (currentVoiceMode === 'realtime') {
                queueVoiceInjection(getScriptInjection("Hey! I'm Osborn, your AI research assistant. What are you working on today?"))
              } else {
                await (currentSession as any).say("Hey! I'm Osborn. What are you working on?")
              }
            } catch (err) {
              console.log('⚠️ Fresh session greeting failed:', err)
            }
          }
        }
      }
      // ============================================================
      // SLICE 1: HEADLESS BACKGROUND SESSION COMMANDS
      // spawn_background_session — boot a second Claude subprocess that
      //   resumes an existing session with NO voice involvement.
      // list_slots — return all live slots (focused + background) so the
      //   frontend can verify both are alive.
      // ============================================================
      else if (data.type === 'spawn_background_session') {
        const targetSessionId: string | undefined = data.sessionId as string | undefined
        const bgDir: string | undefined = data.workingDir as string | undefined

        let resolvedSessionId = targetSessionId
        if (!resolvedSessionId) {
          // Pick the most recently modified session, excluding the focused one.
          const allSess = await listAllClaudeSessions(50)
          const focusedId = currentLLM?.sessionId || currentResumeSessionId || null
          const candidate = allSess.find(s => s.sessionId !== focusedId)
          resolvedSessionId = candidate?.sessionId ?? undefined
        }

        if (!resolvedSessionId) {
          await sendToFrontend({
            type: 'background_session_error',
            slotId: null,
            error: 'No eligible session found to spawn as background slot',
          })
        } else if (slots.has(resolvedSessionId)) {
          await sendToFrontend({
            type: 'background_session_error',
            slotId: resolvedSessionId,
            error: `Session ${resolvedSessionId.substring(0, 8)} is already running as a background slot`,
          })
        } else {
          spawnBackgroundSession(resolvedSessionId, bgDir).catch((err) => {
            console.error('❌ spawnBackgroundSession failed:', err instanceof Error ? err.message : err)
            sendToFrontend({
              type: 'background_session_error',
              slotId: resolvedSessionId,
              error: err instanceof Error ? err.message : String(err),
            }).catch(() => {})
          })
        }
      }
      else if (data.type === 'list_slots') {
        // Return all live slots: the focused session + every background slot.
        const focusedId = currentLLM?.sessionId || currentResumeSessionId || null
        const focusedEntry = currentLLM
          ? [{
              id: focusedId || '(pending)',
              isFocused: true,
              workingDir,
              hasSession: currentLLM.hasSession?.() ?? false,
            }]
          : []
        const bgEntries = [...slots.values()].map(s => ({
          id: s.id,
          isFocused: s.isFocused,
          workingDir: s.workingDir,
          hasSession: s.llm.hasSession?.() ?? false,
        }))
        await sendToFrontend({
          type: 'slots_list',
          slots: [...focusedEntry, ...bgEntries],
        })
      }
      else if (data.type === 'list_processes') {
        // Read process list from /proc. Each numeric subdir is a PID.
        // We read /proc/<pid>/comm (process name) and VmRSS from /proc/<pid>/status.
        // Skips any PID that errors mid-scan (race: process may have exited).
        try {
          const procEntries = readdirSync('/proc')
          const processes: Array<{ pid: number; name: string; rssMb: number }> = []
          for (const entry of procEntries) {
            if (!/^\d+$/.test(entry)) continue
            const pid = parseInt(entry, 10)
            try {
              const comm = readFileSync(`/proc/${entry}/comm`, 'utf8').trim()
              const status = readFileSync(`/proc/${entry}/status`, 'utf8')
              const vmRssMatch = status.match(/^VmRSS:\s*(\d+)\s*kB/m)
              const rssMb = vmRssMatch ? Math.round(parseInt(vmRssMatch[1], 10) / 1024) : 0
              processes.push({ pid, name: comm, rssMb })
            } catch {
              // Process exited between readdir and read — skip it
            }
          }
          // Sort by resident memory descending, cap at 40 entries
          processes.sort((a, b) => b.rssMb - a.rssMb)
          const topProcesses = processes.slice(0, 40)

          // Reuse the existing os module memory totals (same source as /health endpoint)
          const totalMb = Math.round(totalmem() / 1024 / 1024)
          const freeMb  = Math.round(freemem()  / 1024 / 1024)
          const usedMb  = totalMb - freeMb

          await sendToFrontend({
            type: 'process_list',
            processes: topProcesses,
            memory: { usedMb, totalMb, freeMb },
          })
        } catch (err) {
          console.error('❌ list_processes: failed to read /proc:', err)
        }
      }
    } catch {}
  }

  // ============================================================
  // Room session lifecycle (0.9.83): fresh Room per user session
  // ============================================================

  // createRoomSession(roomName): mint a FRESH Room, wire ALL handlers onto it,
  // mint a room-scoped JWT, connect with a bounded retry, run the post-connect
  // setup + adopt-sweep, and mark status='connected'. The caller AWAITS this so
  // /connect-room can respond only once the agent is actually in the room.
  //
  // Bounded retry (3 attempts, backoff 5s→10s→20s): the caller is awaiting, so
  // we can't loop forever like the old boot-time connectWithRetry did. If all
  // attempts fail we surface status='failed' and rethrow so the caller sees it.
  // A single transient blip is absorbed; a persistent failure (quota/auth) is
  // reported promptly rather than hanging the connect flow.
  let creatingRoomSession = false
  const createRoomSession = async (targetRoomName: string): Promise<void> => {
    if (creatingRoomSession) {
      console.log('⏳ createRoomSession already in progress — skipping duplicate')
      return
    }
    creatingRoomSession = true
    try {
      // Discard any prior (dead/stale) instance without reuse.
      if (activeRoom) {
        console.warn('⚠️ createRoomSession called with an existing activeRoom — discarding it (no reuse)')
        activeRoom = null
      }
      const room = new Room()
      room.setMaxListeners(50)  // Prevent MaxListenersExceeded warnings
      wireRoomHandlers(room)

      const backoffSchedule = [5_000, 10_000, 20_000]
      let lastErr: unknown = null
      for (let attempt = 0; attempt < 3; attempt++) {
        livekitState.status = livekitState.attemptCount === 0 ? 'connecting' : 'retrying'
        livekitState.lastAttemptAt = Date.now()
        livekitState.attemptCount += 1
        try {
          const jwt = await mintAgentToken(targetRoomName)
          await room.connect(livekitUrl, jwt, {
            autoSubscribe: true,
            dynacast: true,
          })
          // Success — adopt this instance as the active room.
          activeRoom = room
          activeRoomName = targetRoomName
          currentRoomCode = targetRoomName  // legacy /room-code returns last-created NAME
          localParticipant = room.localParticipant
          livekitState.status = 'connected'
          livekitState.error = null
          livekitState.errorCode = null
          console.log('✅ Connected to room:', targetRoomName)

          // Post-connect setup (re-homed from the dead RoomEvent.Connected handler).
          postConnectSetup(room, targetRoomName)

          // Adopt-sweep: ParticipantConnected only fires for participants who join
          // AFTER us. Anyone already in the room at connect time is populated by
          // rtc-node from the connect callback (no event) — invoke the handler
          // directly so their voice session is created. Runs exactly once per
          // connect (replaces the old adopt-poll + connectRoomHook adopt loop).
          for (const p of room.remoteParticipants.values()) {
            console.log(`👥 Participant already in room at join: ${p.identity} — adopting (invoking handler directly)`)
            participantConnectedHandler?.(p).catch((e) => console.error('👥 adopt handler error:', e instanceof Error ? e.message : e))
          }
          console.log('\n⏳ Waiting for user to connect...')
          console.log(`   Room: ${targetRoomName}\n`)
          return
        } catch (err) {
          lastErr = err
          const msg = err instanceof Error ? err.message : String(err)
          // Categorize the error so the frontend can show specific guidance.
          let errorCode: string
          if (/429|connection minutes limit/i.test(msg)) errorCode = 'quota_exceeded'
          else if (/401|403|unauthorized|invalid/i.test(msg)) errorCode = 'auth'
          else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(msg)) errorCode = 'network'
          else errorCode = 'unknown'
          livekitState.status = 'failed'
          livekitState.error = msg
          livekitState.errorCode = errorCode
          console.error(`❌ LiveKit connect failed (${errorCode}, attempt ${attempt + 1}/3): ${msg.substring(0, 200)}`)
          if (attempt < 2) {
            const waitMs = backoffSchedule[attempt]
            console.error(`   Retrying in ${waitMs / 1000}s...`)
            await new Promise(r => setTimeout(r, waitMs))
          }
        }
      }
      // All attempts failed. Drop the dead instance; leave status='failed' so
      // /health surfaces it and the frontend can retry /connect-room.
      activeRoom = null
      activeRoomName = null
      console.error('❌ createRoomSession: all 3 connect attempts failed — giving up (status=failed)')
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
    } finally {
      creatingRoomSession = false
    }
  }

  // destroyRoomSession(reason): tear down the active room session and DISCARD
  // the Room instance (never reused). A hung rtc-node disconnect() (signal-less
  // waitFor at room.js:579) is made harmless by racing it against a 10s timeout:
  // on timeout we just log and drop the instance — nothing reuses it, so a
  // zombie WS at the Rust layer can't wedge the next session. Idempotent.
  let destroyingRoomSession = false
  const destroyRoomSession = async (reason: string): Promise<void> => {
    if (destroyingRoomSession) return
    if (!activeRoom) {
      // Already idle — still ensure billing backstop is armed.
      livekitState.status = 'idle'
      armIdleExitTimer(`destroyRoomSession(${reason}) — already idle`)
      return
    }
    destroyingRoomSession = true
    const room = activeRoom
    // Drop the reference immediately so nothing (handlers, sweeps) touches it.
    activeRoom = null
    activeRoomName = null
    if (aloneTimer) { clearTimeout(aloneTimer); aloneTimer = null }
    cancelFastLeaveTimer()
    intentionalLeave = true  // suppress the Disconnected handler's auto-rejoin
    console.log(`🚪 Destroying room session (${reason}) — disconnecting + discarding Room instance`)
    try {
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000))
      const result = await Promise.race([room.disconnect().then(() => 'ok' as const), timeout])
      if (result === 'timeout') {
        console.error('⚠️ room.disconnect() still pending after 10s (zombie WS) — abandoning the instance')
        try { (room as any).ffiHandle?.dispose?.() } catch {}
      }
    } catch (e) {
      console.error('destroyRoomSession room.disconnect failed:', e)
    }
    livekitState.status = 'idle'
    livekitState.error = null
    livekitState.errorCode = null
    armIdleExitTimer(`destroyRoomSession(${reason})`)
    destroyingRoomSession = false
  }

  // Wire the module-level HTTP control hooks now that the room-session lifecycle
  // functions exist. The /connect-room and /leave-room endpoints call these.
  //
  // NOTE (frontend migration): ChatSessionProvider should later call
  // POST /connect-room FIRST and mint its LiveKit token from the returned
  // { roomName } (which connectRoomHook resolves to). During rollout, the legacy
  // GET /room-code endpoint keeps returning the last-created room NAME so old
  // frontends still function.
  canvasTokenHook = async () => {
    if (!activeRoomName) return null
    const t = new AccessToken(apiKey, apiSecret, {
      identity: 'meeting-canvas',
      name: 'Meeting Canvas',
      metadata: JSON.stringify({ type: 'canvas' }),
    })
    t.addGrant({ roomJoin: true, room: activeRoomName, canPublish: false, canSubscribe: true, canPublishData: false })
    return { token: await t.toJwt(), url: process.env.LIVEKIT_URL || '', room: activeRoomName }
  }

  connectRoomHook = async (): Promise<string> => {
    intentionalLeave = false
    cancelIdleExitTimer()
    // Idempotency: an active session with a user present is reused (return its
    // room name). An active-but-empty session (agent joined, user never showed,
    // or a stale race) is torn down and replaced with a fresh one.
    if (activeRoom && activeRoomName) {
      if (activeRoom.remoteParticipants.size > 0) {
        console.log(`🔌 /connect-room — already connected with a user present, reusing ${activeRoomName}`)
        return activeRoomName
      }
      console.log('🔌 /connect-room — active room is empty; tearing down + creating fresh')
      await destroyRoomSession('connect-room replacing empty session')
    }
    const targetRoomName = buildRoomName()
    console.log(`🔌 /connect-room — creating fresh room session: ${targetRoomName}`)
    await createRoomSession(targetRoomName)
    return targetRoomName
  }
  leaveRoomHook = async (reason: string) => {
    if (aloneTimer) { clearTimeout(aloneTimer); aloneTimer = null }
    if (!activeRoom) return  // already out — no-op
    // Never abandon a user who is CURRENTLY in the room. Stale/racing
    // leave-room calls (a previous client's teardown landing after a new
    // client joined) were kicking the agent out mid-adopt, stranding the new
    // user on "Connecting..." (observed 2026-07-28). The alone-timer handles
    // the real departure when they actually leave.
    if (activeRoom.remoteParticipants.size > 0) {
      console.log(`🛑 /leave-room ignored (${reason}) — ${activeRoom.remoteParticipants.size} participant(s) still in room`)
      return
    }
    console.log(`🚪 /leave-room (${reason}) — destroying room session`)
    await destroyRoomSession(`explicit leave (${reason})`)
  }

  // bug-reporter skill hook — forwards a validated bug payload to the frontend
  // via the LiveKit data channel. Frontend (which holds the Supabase keys for
  // the existing log-upload flow) is responsible for the actual Supabase write.
  // Enriches with the agent-side facts the frontend doesn't already have on
  // hand (voice_mode + sandbox_id from FLY_MACHINE_ID — version it can read
  // from /health, session_id it tracks via preSelectedSessionId).
  bugReportHook = (reportId, payload) => {
    const sandboxId = process.env.FLY_MACHINE_ID || null
    let osbornVersion: string | undefined
    try {
      for (const rel of ['../package.json', '../../package.json']) {
        try {
          const pkg = JSON.parse(readFileSync(join(__dirname, rel), 'utf8'))
          if (pkg.name === 'osborn' && pkg.version) { osbornVersion = pkg.version; break }
        } catch { /* try next */ }
      }
    } catch { /* version optional */ }
    console.log(`🪲 Bug report ${reportId.slice(0, 8)} (${payload.type}/${payload.severity}): ${payload.title}`)
    sendToFrontend({
      type: 'bug_report',
      reportId,
      payload,
      context: {
        voice_mode: currentVoiceMode,
        sandbox_id: sandboxId,
        osborn_version: osbornVersion,
      },
    }).catch((e) => console.error('❌ bugReportHook sendToFrontend failed:', e))
  }

  // 0.9.83: boot IDLE — do NOT eager-connect to LiveKit at startup. Under the
  // fresh-Room-per-session model there is no persistent room to join at boot;
  // the agent only joins when a user arrives via POST /connect-room (which
  // awaits createRoomSession). This also removes the old boot-time
  // connectWithRetry() eager connect entirely. The idle-exit timer is armed so
  // a machine that boots but never receives a /connect-room still stops itself
  // (billing protection) instead of idling forever.
  livekitState.status = 'idle'
  console.log('🟢 Agent booted — idle, awaiting POST /connect-room to join LiveKit')
  armIdleExitTimer('boot idle (no session yet)')

  // Keep main() alive forever — without this the await chain ends and Node
  // exits 0, which Fly treats as a clean shutdown. The HTTP API server + timers
  // keep the process responsive.
  await new Promise(() => {})
}

// Run
main().catch(console.error)
