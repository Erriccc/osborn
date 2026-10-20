/**
 * Meeting-mode contract (contract B) — pins the [MEETING paths BEFORE the
 * noise-gate feature touches them.
 *
 * Behavioral (ClaudeLLM.prototype patched so no SDK subprocess ever spawns):
 *   M1  a [MEETING chunk NEVER consumes the pending interruption context,
 *       NEVER fires interruptQuery, sets suppressMeetingTTS, passes the user
 *       text through UNMODIFIED, and NEVER fires the fast brain
 *   M2  a real user message consumes the context ONCE, fires interruptQuery
 *       once, rewrites the message with the [INTERRUPTED] template (truthful
 *       sub-agent wording), clears suppressMeetingTTS, and fires the fast brain
 *   M3  suppressed-only context → [CONTEXT] template, NO interruptQuery
 *
 * Anchored source checks:
 *   M4  claude-llm.ts steer-priority guard excludes '[MEETING' and '[SYSTEM'
 *       and is suppressed while permissionPending or compacting; priority 'now'
 *       stamped only when steerNow
 *   M5  index.ts tts_say handler gates on suppressMeetingTTS BEFORE the
 *       currentSession guard and returns without browser TTS when suppressed
 *
 * Run: npx tsx agent/tests/regression/meeting-mode.ts  (self-sandboxes HOME)
 */

// The noise-gate feature (noise-gate.ts) deliberately changes behavior when ON:
// meeting chunks auto-engage it and real turns get triaged. This suite pins the
// LEGACY (gate-off) contracts, so run with the gate kill switch — read lazily
// by the gate, so setting it here (after imports) still applies.
process.env.OSBORN_NOISE_GATE = 'off'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, finish, sandboxHome, sleep, readSource, anchoredSlice } from './_shared.js'

sandboxHome()
delete process.env.OPENROUTER_API_KEY // fast brain (if fired) returns instantly → detectable via onFastBrainResult
const { ClaudeLLM } = await import('../../src/claude-llm.js')
const { PipelineDirectLLM } = await import('../../src/pipeline-direct-llm.js')
const { llm } = await import('@livekit/agents')

// ── Patch the inner ClaudeLLM so chat() never spawns the SDK subprocess ─────
const SENTINEL_STREAM = { __regressionSentinel: true } as any
const innerChatCalls: any[] = []
let interruptCalls = 0
;(ClaudeLLM as any).prototype.chat = function (args: any) { innerChatCalls.push(args); return SENTINEL_STREAM }
;(ClaudeLLM as any).prototype.interruptQuery = async function () { interruptCalls++; return true }

const workingDir = mkdtempSync(join(tmpdir(), 'osborn-regress-meeting-'))

const lastUserText = (chatCtx: any): string => {
  for (let i = chatCtx.items.length - 1; i >= 0; i--) {
    const item = chatCtx.items[i] as any
    if (item.type === 'message' && item.role === 'user') {
      return Array.isArray(item.content)
        ? item.content.filter((c: any) => typeof c === 'string').join('\n')
        : String(item.content ?? '')
    }
  }
  return ''
}
const makeCtx = (text: string) => {
  const ctx = new llm.ChatContext()
  ctx.addMessage({ role: 'user', content: text })
  return ctx
}

// ── M1 + M2 on ONE instance (also pins suppressMeetingTTS clearing) ─────────
{
  let consumed = 0
  const fbResults: any[] = []
  const pendingCtx = { spokenText: 'the part you heard', recentMessages: 'recent assistant lines', suppressedText: 'unspoken tail' }
  const pd = new PipelineDirectLLM({
    workingDirectory: workingDir,
    getAndConsumeInterruptionContext: () => { consumed++; return { ...pendingCtx } },
    onFastBrainResult: (r: any) => { fbResults.push(r) },
  } as any)

  // M1 — meeting chunk
  const meetingText = '[MEETING — main] Alice: let us begin the standup'
  const ctx1 = makeCtx(meetingText)
  const ret1 = pd.chat({ chatCtx: ctx1 })
  check('M1a', ret1 === SENTINEL_STREAM, 'chat() returns the inner ClaudeLLM stream SYNCHRONOUSLY (no Promise wrapper)')
  check('M1b', pd.suppressMeetingTTS === true, 'meeting chunk sets suppressMeetingTTS = true')
  check('M1c', consumed === 0, `meeting chunk does NOT consume the interruption context (consumed=${consumed})`)
  check('M1d', interruptCalls === 0, `meeting chunk does NOT fire interruptQuery (calls=${interruptCalls})`)
  check('M1e', lastUserText(innerChatCalls.at(-1).chatCtx) === meetingText,
    'meeting chunk text passes through UNMODIFIED (no [INTERRUPTED]/[CONTEXT]/session-tail prefix)')
  // Fast-brain detection is sound: if it HAD fired, emitting session_id resolves its
  // wait and (with no OPENROUTER key) onFastBrainResult would land within ms.
  ;(pd as any).events.emit('session_id', { sessionId: 'sess-meeting' })
  await sleep(250)
  check('M1f', fbResults.length === 0, `meeting chunk never fires the fast brain (results=${fbResults.length})`)

  // M2 — real user message on the same instance
  const realText = 'wait, what changed in the auth layer?'
  const ctx2 = makeCtx(realText)
  pd.chat({ chatCtx: ctx2 })
  check('M2a', pd.suppressMeetingTTS === false, 'next real user turn clears suppressMeetingTTS')
  check('M2b', consumed === 1, `real message consumes the interruption context exactly once (consumed=${consumed})`)
  check('M2c', interruptCalls === 1, `real interrupted message fires interruptQuery exactly once (calls=${interruptCalls})`)
  const enriched = lastUserText(innerChatCalls.at(-1).chatCtx)
  check('M2d', enriched.startsWith('[INTERRUPTED]'), 'enrichment uses the [INTERRUPTED] template')
  check('M2e', enriched.includes(pendingCtx.spokenText) && enriched.includes(realText) && enriched.includes(pendingCtx.suppressedText),
    'enrichment carries spoken text, suppressed text and the new user message')
  check('M2f', /SUB-AGENT/i.test(enriched) && /do not re-?dispatch/i.test(enriched) && !/SEVERED/.test(enriched),
    'enrichment is truthful about surviving sub-agents (no SEVERED claim, no re-dispatch instruction)')
  ;(pd as any).events.emit('session_id', { sessionId: 'sess-real' })
  await sleep(300)
  check('M2g', fbResults.length === 1 && fbResults[0].question === realText,
    `real message fires the fast brain exactly once (results=${fbResults.length})`)
}

// ── M3 — suppressed-only context → [CONTEXT], no interrupt ─────────────────
{
  const before = interruptCalls
  const pd = new PipelineDirectLLM({
    workingDirectory: workingDir,
    getAndConsumeInterruptionContext: () => ({ spokenText: '', recentMessages: '', suppressedText: 'queued words never played' }),
  } as any)
  const ctx = makeCtx('okay go on')
  pd.chat({ chatCtx: ctx })
  const enriched = lastUserText(innerChatCalls.at(-1).chatCtx)
  check('M3a', enriched.startsWith('[CONTEXT]'), 'suppressed-only enrichment uses the [CONTEXT] template (never claims an interrupt)')
  check('M3b', enriched.includes('queued words never played'), 'suppressed text is forwarded')
  check('M3c', interruptCalls === before, 'suppressed-only enrichment does NOT fire interruptQuery')
}

// ── M4 — steer-priority guard in claude-llm.ts (anchored) ──────────────────
{
  const llmSrc = readSource('agent/src/claude-llm.ts')
  const guard = anchoredSlice(llmSrc, 'const steerNow = ', { endAnchor: "steerNow ? { priority: 'now' } : undefined" })
  check('M4a', guard.includes("!userText.startsWith('[MEETING')"), "steer guard excludes '[MEETING' prefixed text")
  check('M4b', guard.includes("!userText.startsWith('[SYSTEM')"), "steer guard excludes '[SYSTEM' prefixed text")
  check('M4c', guard.includes('permissionPending'), 'steer guard suppressed while permissionPending')
  check('M4d', guard.includes('compacting'), 'steer guard suppressed while compacting')
  check('M4e', guard.includes("process.env.OSBORN_MSG_PRIORITY !== 'off'"), 'OSBORN_MSG_PRIORITY=off escape hatch kept')
  check('M4f', guard.includes("steerNow ? { priority: 'now' } : undefined"),
    "pushMessage gets priority 'now' only when steerNow — undefined otherwise")
  // the guard state must actually be maintained somewhere real:
  check('M4g', llmSrc.includes('permissionPending = true') && llmSrc.includes('permissionPending = false'),
    'permissionPending is set on pending dialog and cleared on resolution')
  check('M4h', llmSrc.includes("this.compacting = status === 'compacting'"),
    'compacting toggled from SDK status messages')
}

// ── M5 — index.ts tts_say gate (anchored) ───────────────────────────────────
{
  const indexSrc = readSource('agent/src/index.ts')
  const handler = anchoredSlice(indexSrc, "directLLM.events.on('tts_say'", { len: 3500 })
  const gateIdx = handler.indexOf('suppressMeetingTTS')
  const sessionGuardIdx = handler.indexOf('if (!currentSession)')
  check('M5a', gateIdx >= 0, 'tts_say handler reads suppressMeetingTTS')
  check('M5b', sessionGuardIdx > gateIdx && gateIdx >= 0,
    'meeting gate runs BEFORE the currentSession guard (meeting replies survive a voice-session drop)')
  const gateBlock = handler.slice(gateIdx, sessionGuardIdx)
  check('M5c', /return/.test(gateBlock), 'suppressed meeting turn returns without browser TTS')
  check('M5d', gateBlock.includes('speakIntoMeeting'), 'addressed meeting replies route to speakIntoMeeting (native meeting audio), not session.say')
}

finish('meeting-mode')
