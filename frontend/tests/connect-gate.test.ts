// Run: cd frontend && npx --yes tsx tests/connect-gate.test.ts
// Spec (issues #53, #78): the chat connect watchdog arms only while the UI is
// genuinely waiting on the agent, disarms the moment the session connects /
// errors / needs Anthropic sign-in (so an account mid-OAuth is never cut off),
// and surfaces an auth-aware, actionable message. Also asserts the provider
// actually wires the watchdog + the Cancel abort guard.
import fs from 'node:fs'
import path from 'node:path'
import {
  CONNECT_WATCHDOG_MS,
  SLOW_START_HINT_MS,
  connectProgressText,
  connectTimeoutMessage,
  isAuthGateTerminal,
  isAuthPromptMessage,
  isAwaitingAgent,
  isOAuthInProgress,
  nextAuthRequired,
  AGENT_IDENTITY,
  flushQueue,
  isAgentIdentity,
  rejoinMode,
  roomHasAgent,
  roomVerdict,
  sendOrQueue,
  shouldAutoOpenAuthModal,
  unsentNotice,
  type ConnectWaitState,
  type QueuedText,
  type RoomLivenessState,
} from '../src/lib/connect-gate'

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(a === b, `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const base: ConnectWaitState = { connecting: false, agentReady: false, hasToken: false, error: false, authRequired: false, authInProgress: false }

t('armed while connecting pre-token', () => {
  eq(isAwaitingAgent({ ...base, connecting: true }), true, 'connecting→armed')
})

t('armed after token handoff but before agent_ready', () => {
  eq(isAwaitingAgent({ ...base, hasToken: true }), true, 'token+!connected→armed')
})

t('disarms once agent_ready fired', () => {
  eq(isAwaitingAgent({ ...base, hasToken: true, agentReady: true }), false, 'agentReady→disarmed')
  // even with a stale auth flag around, a ready agent is never timed out
  eq(isAwaitingAgent({ ...base, hasToken: true, agentReady: true, authRequired: true }), false, 'agentReady+auth→disarmed')
})

t('disarms once an error is already shown', () => {
  eq(isAwaitingAgent({ ...base, connecting: true, error: true }), false, 'error→disarmed')
})

t('disarms while the sign-in modal is open (user mid-OAuth is never cut off)', () => {
  // A fresh account blocks on ensureClaudeAuth(), so agent_ready never
  // arrives — but we must NOT fire a timeout error at them mid-sign-in.
  eq(isAwaitingAgent({ ...base, hasToken: true, authRequired: true, authInProgress: true }), false, 'modal open→disarmed')
})

t('#78: modal dismissed + agent not ready → awaiting (watchdog fires)', () => {
  eq(isAwaitingAgent({ ...base, hasToken: true, authRequired: true, authInProgress: false }), true, 'dismissed→armed')
})

t('#78: auth error / transport-connected but agent not ready still awaits', () => {
  // auth pending cleared by claude_auth_error, modal dismissed, agent never readied
  eq(isAwaitingAgent({ ...base, hasToken: true, authRequired: false, authInProgress: false }), true, 'not ready→armed')
})

t('isOAuthInProgress: active steps vs dismissed/terminal', () => {
  for (const st of ['required', 'waiting', 'waiting_code', 'submitting'] as const) eq(isOAuthInProgress(st), true, st)
  for (const st of ['none', 'complete', 'error'] as const) eq(isOAuthInProgress(st), false, st)
})

t('nextAuthRequired: set on request, cleared on auth success and auth error', () => {
  eq(nextAuthRequired(false, 'claude_auth_required'), true, 'required sets')
  eq(nextAuthRequired(false, 'claude_auth_url'), true, 'url sets')
  eq(nextAuthRequired(true, 'claude_auth_complete'), false, 'success clears')
  eq(nextAuthRequired(true, 'claude_auth_error'), false, 'error clears')
  eq(nextAuthRequired(true, 'agent_ready'), true, 'unrelated keeps')
  // after success the watchdog no longer selects the auth message and a ready agent disarms it
  const after = { ...base, hasToken: true, authRequired: nextAuthRequired(true, 'claude_auth_complete') }
  eq(after.authRequired, false, 'cleared')
  eq(isAwaitingAgent({ ...after, agentReady: true }), false, 'ready after success→disarmed')
})

t('idle (nothing in flight) is not armed', () => {
  eq(isAwaitingAgent(base), false, 'idle→not armed')
})

t('timeout message is auth-aware and actionable', () => {
  const generic = connectTimeoutMessage(false)
  const auth = connectTimeoutMessage(true)
  ok(/retry|go back|open the session/i.test(generic), 'generic message is actionable')
  ok(/sign.?in/i.test(auth), 'auth message mentions sign-in')
  ok(generic !== auth, 'messages differ by auth state')
})

t('watchdog window is bounded and sane', () => {
  ok(CONNECT_WATCHDOG_MS > 30_000 && CONNECT_WATCHDOG_MS <= 120_000, 'bounded 30s–120s')
})

// ── #78: the auth gate is the TERMINAL state once sign-in was ever asked for ──
t('auth gate is terminal once required and the modal is closed', () => {
  eq(isAuthGateTerminal(true, 'none'), true, 'everRequired + modal closed → banner (terminal)')
})

t('auth gate is NOT terminal while the sign-in modal is open', () => {
  // mid-OAuth: the modal is the resolution, not the banner.
  eq(isAuthGateTerminal(true, 'waiting'), false, 'modal open → not banner')
  eq(isAuthGateTerminal(true, 'required'), false, 'preparing → not banner')
  eq(isAuthGateTerminal(true, 'waiting_code'), false, 'awaiting code → not banner')
})

t('auth gate is not terminal before sign-in was ever required', () => {
  eq(isAuthGateTerminal(false, 'none'), false, 'never required → no banner')
})

// ── #87 §5/§6 prompt discipline (merged in from the former src/lib copy) ──
t('isAuthPromptMessage: only the three opening messages', () => {
  for (const m of ['claude_auth_required', 'claude_auth_url', 'claude_auth_waiting_code']) eq(isAuthPromptMessage(m), true, m)
  for (const m of ['claude_auth_submitting', 'claude_auth_complete', 'agent_ready']) eq(isAuthPromptMessage(m), false, m)
})

t('shouldAutoOpenAuthModal: opens on a prompt message, never after a dismissal', () => {
  eq(shouldAutoOpenAuthModal('claude_auth_required', false), true, 'required opens')
  eq(shouldAutoOpenAuthModal('claude_auth_url', false), true, 'url opens')
  // The #87 §5 bug: a dismissed modal must not re-open on the next prompt.
  for (const m of ['claude_auth_required', 'claude_auth_url', 'claude_auth_waiting_code']) eq(shouldAutoOpenAuthModal(m, true), false, `dismissed: ${m}`)
  for (const m of ['claude_auth_submitting', 'agent_ready']) eq(shouldAutoOpenAuthModal(m, false), false, `non-prompt: ${m}`)
})

// ── Wiring guards: cheap static checks so a refactor can't silently drop the fix.
const root = path.resolve(__dirname, '..')
const provider = fs.readFileSync(path.join(root, 'src/components/ChatSessionProvider.tsx'), 'utf8')
const voiceRoom = fs.readFileSync(path.join(root, 'src/components/VoiceRoom.tsx'), 'utf8')

t('provider arms the watchdog via isAwaitingAgent', () => {
  ok(provider.includes('isAwaitingAgent('), 'isAwaitingAgent used')
  ok(/isAwaitingAgent\(\{[^}]*agentReady[^}]*authInProgress/.test(provider), 'keyed on agentReady + authInProgress (#78)')
  ok(provider.includes('connectTimeoutMessage('), 'connectTimeoutMessage used')
  ok(/setTimeout\([^]*CONNECT_WATCHDOG_MS/.test(provider), 'timer uses CONNECT_WATCHDOG_MS')
})

t('provider guards Cancel with a connect generation', () => {
  ok(provider.includes('connectGenRef'), 'connectGenRef present')
  ok(provider.includes('const isCurrent'), 'connect() captures its generation')
  // disconnect bumps the generation so a stale connect() can\'t re-show the overlay.
  ok(/connectGenRef\.current\+\+/.test(provider), 'disconnect bumps the generation')
})

t('VoiceRoom surfaces the persistent sign-in gate', () => {
  ok(voiceRoom.includes('claudeAuthEverRequired'), 'sticky auth flag present')
  ok(/Anthropic sign-in required/.test(voiceRoom), 'banner copy present')
  ok(voiceRoom.includes('isAuthGateTerminal('), 'banner gated by the terminal-state helper')
})

t('#78: any auth-gate message surfaces the terminal state (not only claude_auth_required)', () => {
  // The sign-in banner must be reachable even if the agent emits the URL first
  // (or claude_auth_required is dropped) — otherwise connected stays false, the
  // watchdog is disarmed on authRequired, and "Connecting…" spins forever.
  const urlHandler = voiceRoom.slice(
    voiceRoom.indexOf("data.type === 'claude_auth_url'"),
    voiceRoom.indexOf("data.type === 'claude_auth_submitting'"),
  )
  ok(/onAuthRequired\?\.\(\)/.test(urlHandler), 'claude_auth_url / waiting_code call onAuthRequired')
})

t('#79: the sign-in banner is in normal flow, not fixed over the header', () => {
  // The old `fixed inset-x-0 top-0 z-[60]` banner covered the Rooms header
  // controls + hid the status line (same bug the sound banner had before #68).
  ok(!voiceRoom.includes('fixed inset-x-0 top-0 z-[60]'), 'no fixed top-0 z-[60] overlay remains')
  // The in-flow banner is the div gated by isAuthGateTerminal, carrying the
  // amber bar classes in normal flow (w-full shrink-0) at the top of the column.
  const start = voiceRoom.indexOf('isAuthGateTerminal(claudeAuthEverRequired || claudeAuthOptional, claudeAuthStatus) && (')
  ok(start > 0, 'banner gate found')
  const banner = voiceRoom.slice(start, voiceRoom.indexOf('Anthropic sign-in required', start))
  ok(/w-full shrink-0[^]*bg-amber-500\/95/.test(banner), 'banner renders in-flow (w-full shrink-0 amber bar)')
})

t('VoiceRoom reports modal state + auth resolution to the provider (#78)', () => {
  ok(voiceRoom.includes('isOAuthInProgress(claudeAuthStatus)'), 'modal state reported')
  ok(voiceRoom.includes('onAuthInProgress={markAuthInProgress}'), 'onAuthInProgress wired')
  ok(voiceRoom.includes('onAuthResolved={markAuthResolved}'), 'onAuthResolved wired')
  ok(voiceRoom.includes("onAuthResolved?.('claude_auth_complete')"), 'resolved on complete')
  ok(voiceRoom.includes("onAuthResolved?.('claude_auth_error')"), 'resolved on error')
  ok(provider.includes('nextAuthRequired(prev, messageType)'), 'provider clears via nextAuthRequired')
})

t('a reconnect after the idle stop clears idleStopped so the room can mount', () => {
  const body = provider.slice(provider.indexOf('const connect = useCallback'), provider.indexOf('const res = await fetch(url)'))
  ok(body.includes('setIdleStopped(false)'), 'connect() clears idleStopped')
  ok(provider.includes('token && roomCode && !idleStopped'), 'the room is gated on idleStopped')
})

t('the idle stop cancels an in-flight connect and leaves the paused screen', () => {
  const body = provider.slice(provider.indexOf('if (idleMs > IDLE_MS)'), provider.indexOf('setIdleStopped(true)'))
  ok(body.includes('cancelConnect()'), 'idle stop cancels the in-flight connect')
  const cancel = provider.slice(provider.indexOf('const cancelConnect = useCallback'), provider.indexOf('}, [])', provider.indexOf('const cancelConnect = useCallback')))
  ok(cancel.includes('connectGenRef.current++'), 'cancelConnect bumps the connect generation')
  ok(cancel.includes('setConnecting(false)'), 'cancelConnect clears connecting (a bailed connect leaves it set)')
})

// ── #144: progress text, Retry from a clean slate, mic released, optional sign-in ──
t('progress text names the step', () => {
  eq(connectProgressText('starting', null, 0), 'Starting your machine…', 'starting')
  eq(connectProgressText('resuming', null, 0), 'Waking your machine…', 'resuming')
  eq(connectProgressText('agent', null, 0), 'Connecting to your agent…', 'agent, not probed yet')
  eq(connectProgressText('agent', { reachable: false }, 0), 'Starting your agent…', 'agent unreachable')
  eq(connectProgressText('agent', { reachable: true, livekitStatus: 'connected' }, 0), 'Connecting to your agent…', 'agent up')
  eq(connectProgressText('agent', { reachable: true, livekitStatus: 'connecting' }, 0), 'Connecting to your agent…', 'livekit connecting')
  eq(connectProgressText('agent', { reachable: true, livekitStatus: 'retrying' }, 0), 'Your agent is still reaching the voice service…', 'livekit retrying')
  eq(connectProgressText('agent', { reachable: true, livekitStatus: 'failed' }, 0), 'Your agent is still reaching the voice service…', 'livekit failed')
  eq(connectProgressText('agent', { reachable: true }, 0), 'Connecting to your agent…', 'old agent without livekit field')
  eq(connectProgressText('joining', null, 0), 'Joining your agent…', 'joining')
})

t('a slow machine/agent step says the first start is slow; joining does not', () => {
  ok(!/minute/.test(connectProgressText('starting', null, SLOW_START_HINT_MS - 1)), 'no hint before the threshold')
  ok(/first start can take a minute or two/.test(connectProgressText('starting', null, SLOW_START_HINT_MS)), 'hint at the threshold')
  ok(/first start/.test(connectProgressText('agent', { reachable: false }, 60_000)), 'hint on the agent step')
  eq(connectProgressText('joining', null, 120_000), 'Joining your agent…', 'joining has no hint')
})

t('the auth timeout tells the user Retry reopens the sign-in', () => {
  ok(/retry/i.test(connectTimeoutMessage(true)), 'auth message names Retry')
})

t('provider: a failed connect drops the room; Retry starts clean', () => {
  const watchdog = provider.slice(provider.indexOf('setError(connectTimeoutMessage(authRequired))'), provider.indexOf('CONNECT_WATCHDOG_MS)', provider.indexOf('setError(connectTimeoutMessage(authRequired))')))
  ok(watchdog.includes('dropRoom()'), 'watchdog drops the room (releases the mic)')
  const drop = provider.slice(provider.indexOf('const dropRoom = useCallback'), provider.indexOf('}, [])', provider.indexOf('const dropRoom = useCallback')))
  ok(drop.includes('setToken(null)') && drop.includes('setConnected(false)'), 'dropRoom clears the token and connected')
  const retry = provider.slice(provider.indexOf('const retry = useCallback'), provider.indexOf('}, [dropRoom, connect])'))
  ok(/dropRoom\(\)[^]*connect\(\)/.test(retry), 'retry drops the room, then connects')
  ok(provider.includes('reconnect: retry,'), 'Retry/Reconnect use retry')
  ok(provider.includes('connectProgressText('), 'connect() shows progress text')
})

t('VoiceRoom: claude_auth_optional makes sign-in optional and startable', () => {
  ok(voiceRoom.includes("data.type === 'claude_auth_optional'"), 'optional handled')
  ok(voiceRoom.includes("{claudeAuthOptional ? 'Not now' : 'Close'}"), 'labelled way out')
  ok(voiceRoom.includes("sendJson({ type: 'claude_auth_start' })"), 'Connect Claude starts sign-in on demand')
  ok(voiceRoom.includes('relyingOnFallback={claudeAuthEverRequired || claudeAuthOptional}'), 'health notice knows about the fallback')

  ok(/if \(!authOptionalRef\.current\) \{\s*setClaudeAuthEverRequired\(true\)/.test(voiceRoom), 'an optional sign-in URL never marks the session as blocked')
})

// ── Rejoin on return (tab suspended, agent left the room) ────────────────
const live: RoomLivenessState = {
  tabActive: true, everConnected: true, idleStopped: false, connecting: false, agentReady: true,
  roomState: 'connected', agentInRoom: true, attempts: 0, maxAttempts: 3,
}

t('agent presence is by identity, not by any remote participant', () => {
  eq(AGENT_IDENTITY, 'osborn-agent', 'the identity agent/src/index.ts mints')
  eq(isAgentIdentity('osborn-agent'), true, 'the agent')
  eq(isAgentIdentity('meeting-canvas'), false, 'the meeting canvas is not the agent')
  eq(isAgentIdentity('user-123'), false, 'a user')
  eq(isAgentIdentity(undefined), false, 'nothing')
  eq(roomHasAgent('connected', true), true, 'connected with the agent')
  eq(roomHasAgent('connected', false), false, 'connected, only the meeting canvas left')
  eq(roomHasAgent('reconnecting', true), false, 'reconnecting')
  eq(roomHasAgent(null, false), false, 'no room')
})

t('roomVerdict: the incident — back from suspension to a room without the agent rejoins', () => {
  // `connected` / agentReady still true from before the suspension.
  eq(roomVerdict({ ...live, agentInRoom: false }), 'rejoin', 'connected room the agent left')
  eq(roomVerdict({ ...live, roomState: 'disconnected', agentInRoom: false }), 'rejoin', 'room disconnected while hidden')
})

t('roomVerdict: a healthy session stays put', () => {
  eq(roomVerdict(live), 'live', 'agent present')
})

t('roomVerdict: a LiveKit full reconnect is not the agent leaving', () => {
  // handleRestarting drops every remote participant, then sets 'reconnecting';
  // the deferred check sees the new state and waits.
  eq(roomVerdict({ ...live, roomState: 'reconnecting', agentInRoom: false }), 'wait', 'reconnecting')
  eq(roomVerdict({ ...live, roomState: 'signalReconnecting', agentInRoom: false }), 'wait', 'signal reconnecting')
  eq(roomVerdict({ ...live, roomState: 'connecting', agentInRoom: false }), 'wait', 'connecting')
})

t('roomVerdict: waits while a connect is in flight or a join awaits agent_ready', () => {
  eq(roomVerdict({ ...live, connecting: true, agentInRoom: false }), 'wait', 'connect() in flight')
  eq(roomVerdict({ ...live, agentReady: false, agentInRoom: false }), 'wait', 'join under way (watchdog bounds it)')
})

t('roomVerdict: never acts for a standby, cold, or idle-stopped tab', () => {
  eq(roomVerdict({ ...live, tabActive: false, agentInRoom: false }), 'wait', 'another tab controls the session')
  eq(roomVerdict({ ...live, everConnected: false, roomState: null, agentInRoom: false }), 'wait', 'never connected')
  eq(roomVerdict({ ...live, idleStopped: true, roomState: null, agentInRoom: false }), 'wait', 'idle stopped')
})

t('roomVerdict: no room mounted after a live session rejoins; a spent budget is lost', () => {
  eq(roomVerdict({ ...live, roomState: null, agentInRoom: false, agentReady: false }), 'rejoin', 'room dropped')
  eq(roomVerdict({ ...live, agentInRoom: false, attempts: 3 }), 'lost', 'budget spent')
})

t('rejoinMode: a still-connected room is remounted; a disconnected one takes the token in place', () => {
  eq(rejoinMode('connected'), 'remount', 'connected rooms ignore a new token and connect-room hands out a new room')
  eq(rejoinMode('reconnecting'), 'remount', 'not disconnected')
  eq(rejoinMode('disconnected'), 'in-place', 'network drop keeps the chat mounted')
  eq(rejoinMode(null), 'in-place', 'no room: just connect')
})

t('queue: typed text waits for the agent, survives a remount, and goes out in order', () => {
  const m = (text: string): QueuedText<string> => ({ text, payload: `p:${text}` })
  let r = sendOrQueue<string>([], m('a'), true)
  eq(r.send.length, 1, 'live + empty queue sends at once'); eq(r.queued, false, 'not queued')
  r = sendOrQueue<string>([], m('a'), false)
  eq(r.queued, true, 'no agent: queued'); eq(r.queue.length, 1, 'one waiting')
  // The queue is a value the provider keeps; the chat remounting changes nothing.
  const kept = r.queue
  r = sendOrQueue<string>(kept, m('b'), true)
  eq(r.send.length, 0, 'a new message never jumps ahead of queued ones'); eq(r.queue.map((q) => q.text).join(), 'a,b', 'order kept')
  const notYet = flushQueue(r.queue, false)
  eq(notYet.send.length, 0, 'no flush without a sender'); eq(notYet.queue.length, 2, 'still kept')
  const f = flushQueue(notYet.queue, true)
  eq(f.send.map((q) => q.payload).join(), 'p:a,p:b', 'flushed in order through the new sender'); eq(f.queue.length, 0, 'emptied')
})

t('queue: giving up is never silent', () => {
  eq(unsentNotice([]), null, 'nothing queued, nothing to say')
  ok(/not sent/.test(unsentNotice([{ text: 'hi', payload: 1 }]) || ''), 'one message: not sent')
  ok(/2 messages were not sent/.test(unsentNotice([{ text: 'a', payload: 1 }, { text: 'b', payload: 2 }]) || ''), 'counts them')
})

t('provider: rejoin, queue and foreground are wired', () => {
  const check = provider.slice(provider.indexOf('const checkRoom = useCallback'), provider.indexOf('}, [rejoin, dropRoom, flushQueuedText, giveUpQueuedText])'))
  ok(check.includes('roomVerdict(') && check.includes('agentInRoom(room)'), 'checkRoom asks roomVerdict with identity-based presence')
  ok(!/connectedRef\.current/.test(provider), 'no gate on the provider `connected` flag')
  ok(provider.includes("checkRoom(chatRef.current?.room ?? null, '[foreground]"), 'foreground asks checkRoom')
  ok(!provider.includes('RoomHandle') && !provider.includes('liveRoom'), 'no second room handle in the provider')
  const rejoin = provider.slice(provider.indexOf('const rejoin = useCallback'), provider.indexOf('}, [connect, dropRoom])'))
  ok(/mode === 'remount'\) dropRoom\(\)/.test(rejoin) && rejoin.includes('setRejoining(true)') && rejoin.includes('connect()'), 'remount drops the room; in place keeps the chat')
  ok(!rejoin.includes('setConnected(false)'), 'an in-place rejoin keeps the chat (and the draft) mounted')
  ok(/rejoin\('disconnected', `Network disconnect/.test(provider), 'the network-drop path rejoins in place')
  const ready = provider.slice(provider.indexOf('const markAgentReady = useCallback'), provider.indexOf('}, [flushQueuedText])'))
  ok(ready.includes('setRejoining(false)') && ready.includes('flushQueuedText()'), 'agent_ready ends the rejoin and sends the queue')
  ok((provider.match(/giveUpQueuedText\(\)/g) || []).length >= 3, 'watchdog, idle stop and a spent budget report unsent text')
})

t('VoiceRoom: typed messages go through the provider; room events ask it', () => {
  const send = voiceRoom.slice(voiceRoom.indexOf('const handleSendText = useCallback'), voiceRoom.indexOf('}, [sendUserText])'))
  ok(!send.includes('sendToAgent('), 'user_text never goes straight to the data channel')
  ok((send.match(/sendUserText\?\.\(text, /g) || []).length === 3, 'all three user_text sends go through the provider')
  ok(voiceRoom.includes("onRoomCheckRef.current?.(room, 'room reconnected')"), 'Reconnected asks the provider')
  ok(/if \(isAgentIdentity\(p\.identity\)\) setTimeout\(/.test(voiceRoom), 'only the agent leaving counts, checked after LiveKit settles')
  ok(voiceRoom.includes('registerChat?.({'), 'registers the room and sender')
  ok(voiceRoom.includes('draft={composerDraft}'), 'the composer keeps its text across a remount')
})

t('page: the rejoin overlay covers the call controls without unmounting the chat', () => {
  const page = fs.readFileSync(path.join(root, 'src/app/chat/page.tsx'), 'utf8')
  ok(page.includes('<VoiceRoom waitingMode={!connected} />') && page.includes('(!connected || rejoining) && ('), 'overlay on rejoining, waitingMode only on !connected')
})

t('remount: the seed is sent once and the chat mounts into the live session', () => {
  ok(/const seedSent = useRef\(false\)/.test(provider) && provider.includes('    seedSent,'), 'seed-sent lives in the provider')
  ok(/const seedSentRef = seedSent \?\? localSeedSent/.test(voiceRoom) && voiceRoom.includes('seedSent={seedSent}'), 'VoiceRoom uses the provider flag')
  const getter = provider.slice(provider.indexOf('const liveSessionId = useCallback'), provider.indexOf('}, [preSelectedSessionId])', provider.indexOf('const liveSessionId = useCallback')))
  ok(getter.includes('sessionParamsFromSearch(window.location.search).sessionId') && getter.includes('live || preSelectedSessionId'), 'live URL session, else the launch value')
  ok(provider.includes('const connectSessionId = liveSessionId()'), 'connect() resumes the same session')
  ok(voiceRoom.includes('const [preSelectedSessionId] = useState(liveSessionId)'), 'each chat mount reads the live session once')
  ok(!/useChatSession\(\)[^;]*\bpreSelectedSessionId\b/.test(voiceRoom.slice(voiceRoom.indexOf('export default function VoiceRoom'))), 'not the launch value')
})

t('a sign-in prompt during a rejoin is not hidden by the overlay', () => {
  const auth = provider.slice(provider.indexOf('const markAuthRequired = useCallback'), provider.indexOf('}, [])', provider.indexOf('const markAuthRequired = useCallback')))
  ok(auth.includes('setRejoining(false)'), 'markAuthRequired clears rejoining')
})

// ── Report ────────────────────────────────────────────────────────────────
let failed = 0
for (const [name, pass, err] of results) {
  console.log(`${pass ? '✅' : '❌'} ${name}${err ? ` — ${err}` : ''}`)
  if (!pass) failed++
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
