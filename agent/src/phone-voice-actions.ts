/**
 * phone-voice-actions.ts — the first voice actions on a phone call (#367).
 *
 * A call has no buttons, so a short spoken command ("stop that", "what are
 * you doing?", "switch to my billing project") is matched here and run as the
 * app's own action (index.ts dispatchAction, PHONE_ACTION_TYPES) instead of
 * going to the model. Approvals are answered here too, never by the model.
 *
 * Pure: matching and the spoken replies. Conservative on purpose: only a short
 * utterance that is the whole command matches; anything else is a normal turn.
 */
import { approvalModeLabel, type ApprovalMode } from './approval-policy.js'

export type VoiceAction =
  | { kind: 'answer'; answer: 'allow' | 'deny' }
  | { kind: 'mode'; mode: ApprovalMode }
  /** A mode change or a session switch while a request waits: not done (the caller hears how to answer it). */
  | { kind: 'blocked'; what: 'mode' | 'switch' }
  | { kind: 'status' }
  | { kind: 'stop'; agent?: string }
  | { kind: 'sessions' }
  /** "switch to …" picked a session: ask "Switch to <title>?" and wait for a yes. */
  | { kind: 'switch'; query: string; target: SessionChoice }
  | { kind: 'confirm_switch' }
  | { kind: 'cancel_switch' }
  | { kind: 'outputs' }
  | { kind: 'keep_working' }

const MAX_WORDS = 10

/** Lower case, no punctuation, without leading fillers ("ok", "hey osborn") or a trailing "please". */
export function normalizeUtterance(text: string): string {
  let s = String(text || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  for (let prev = ''; prev !== s;) {
    prev = s
    s = s.replace(/^(ok|okay|hey|hi|so|um|uh|please|osborn|alright|right|now)\s+/, '')
  }
  return s.replace(/\s+(please|thanks|thank you|now)$/, '').trim()
}

// Every pattern is a whole, short, unmistakable command; everyday speech that
// merely starts the same way ("go to the next step", "keep going", "stop the
// build") is a normal turn for the model.
// Yes/no count only while the request the caller heard read out is pending.
const ANSWER_ALLOW = /^(?:yes|yeah|yep|yup|allow|allow it|approve|approve it)$/
const ANSWER_DENY = /^(?:no|nope|deny|deny it|reject|reject it|dont allow it|do not allow it)$/
// A spoken mode change is saved (the app and later calls use it too); there is no call-only mode.
const MODE_PREFIX = '(?:switch to |use |turn on |set approvals to )?'
const MODE_PATTERNS: [RegExp, ApprovalMode][] = [
  [new RegExp(`^${MODE_PREFIX}(?:allow all|allow everything|approve everything)(?: mode)?$`), 'allow-all'],
  [new RegExp(`^${MODE_PREFIX}auto ?review(?: mode)?$`), 'auto-review'],
  [new RegExp(`^${MODE_PREFIX}ask me(?: first)? mode$`), 'ask'],
  [/^(?:switch to ask me|ask me before (?:each|every) action|ask me every time)$/, 'ask'],
]
const STATUS = /^(?:what are you (?:doing|working on)|whats pending|what is pending|are you (?:busy|still working)|status|status update|give me a status update)$/
const STOP_MAIN = /^(?:stop|stop that|stop it|stop everything|stop working|cancel that)$/
// A named agent: one of the built-in roles, or anything followed by "agent".
const AGENT_ROLES = '(?:researcher|reasoner|writer|steward|reviewer|tester|planner|reader)'
const STOP_AGENT = new RegExp(`^stop the (?:(${AGENT_ROLES})(?: agent)?|([a-z][a-z0-9 -]*?) (?:agent|sub agent|subagent))$`)
const SESSIONS = /^(?:what (?:were|are) my recent (?:sessions|conversations)|(?:list|read me) my (?:recent )?sessions|my recent sessions)$/
// Only an explicit session switch, with the noun said: "switch to the X
// session/project/conversation" or "switch session to X". Then the name must
// pick a session by its title, and the caller confirms with a yes.
const SWITCH = /^(?:switch to (?:my |the )?(.+?) (?:session|project|conversation)|switch session to (?:my |the )?(.+))$/
const CONFIRM_YES = /^(?:yes|yeah|yep|yup|yes please|do it|switch)$/
const CONFIRM_NO = /^(?:no|nope|cancel|dont|do not|stay|stay here)$/
const OUTPUTS = /^(?:what did you make(?: in this session)?|what files did you (?:make|create)(?: in this session)?|read me the session summary|what are (?:the|your) outputs)$/
const KEEP_WORKING = /^(?:keep working (?:after i hang up|when i hang up|in the background)|work in the background)$/

/**
 * The voice action a caller's utterance asks for, or null (a normal turn for
 * the model).
 * - `permissionPending` (the request the caller heard read out): a yes/no answers it.
 * - `anyPermissionPending`: while any request waits, a mode command and a
 *   switch (proposing or confirming one) are not done ('blocked'); "allow all"
 *   and a switch "yes" are never taken as an answer to it.
 * - `switchProposed`: the turn after "Switch to <title>?", a yes confirms and a
 *   no cancels; anything else is a normal turn (and drops the proposal).
 * - A switch is only proposed when `sessions` holds a session whose title the
 *   name picks (pickSession); otherwise the turn goes to the model.
 */
export function matchVoiceAction(
  text: string,
  ctx: { permissionPending: boolean; anyPermissionPending?: boolean; switchProposed?: boolean; sessions?: SessionChoice[] },
): VoiceAction | null {
  const s = normalizeUtterance(text)
  if (!s || s.split(' ').length > MAX_WORDS) return null
  if (ctx.permissionPending) {
    if (ANSWER_ALLOW.test(s)) return { kind: 'answer', answer: 'allow' }
    if (ANSWER_DENY.test(s)) return { kind: 'answer', answer: 'deny' }
  }
  const waiting = ctx.permissionPending || !!ctx.anyPermissionPending
  if (ctx.switchProposed) {
    if (CONFIRM_YES.test(s)) return waiting ? { kind: 'blocked', what: 'switch' } : { kind: 'confirm_switch' }
    if (CONFIRM_NO.test(s)) return { kind: 'cancel_switch' }
  }
  for (const [re, mode] of MODE_PATTERNS) {
    if (re.test(s)) return waiting ? { kind: 'blocked', what: 'mode' } : { kind: 'mode', mode }
  }
  if (STATUS.test(s)) return { kind: 'status' }
  if (STOP_MAIN.test(s)) return { kind: 'stop' }
  const agent = STOP_AGENT.exec(s)
  if (agent) return { kind: 'stop', agent: (agent[1] || agent[2]).trim() }
  if (SESSIONS.test(s)) return { kind: 'sessions' }
  if (OUTPUTS.test(s)) return { kind: 'outputs' }
  if (KEEP_WORKING.test(s)) return { kind: 'keep_working' }
  const sw = SWITCH.exec(s)
  const query = (sw?.[1] || sw?.[2] || '').trim()
  if (query) {
    const target = pickSession(query, ctx.sessions ?? [])
    if (target) return waiting ? { kind: 'blocked', what: 'switch' } : { kind: 'switch', query, target }
  }
  return null
}

const MODE_RANK: Record<ApprovalMode, number> = { 'ask': 0, 'auto-review': 1, 'allow-all': 2 }

/**
 * May a caller change the saved approval mode? The mode also applies to the
 * browser, so until the caller is confirmed by a second factor (keypad
 * approvals on, #362) a call may only make it stricter.
 */
export function phoneMayChangeMode(from: ApprovalMode, to: ApprovalMode, approvalsEnabled: boolean): boolean {
  return approvalsEnabled || MODE_RANK[to] <= MODE_RANK[from]
}

export interface SessionChoice { sessionId: string; title?: string; cwd?: string; projectPath?: string }

const STOP_WORDS = new Set(['my', 'the', 'a', 'an', 'session', 'project', 'conversation', 'chat', 'one', 'about', 'on', 'for', 'with'])
const words = (s: string) => normalizeUtterance(s).split(' ').filter((w) => w && !STOP_WORDS.has(w))

/**
 * The session a spoken name points at: the most words of the query in its
 * title or project folder name. It needs at least half the query's words
 * (rounded up), and at least 2 when the query has 2 or more, so a stray
 * shared word ("next") never picks a session. Ties go to the earlier (most
 * recent) entry; too few words in common → null.
 */
export function pickSession<T extends SessionChoice>(query: string, sessions: T[]): T | null {
  const q = [...new Set(words(query))]
  if (!q.length) return null
  const need = Math.max(Math.ceil(q.length / 2), q.length >= 2 ? 2 : 1)
  let best: T | null = null
  let bestScore = need - 1
  for (const s of sessions) {
    // The title only: a project folder name alone ("api", "web") is too common in speech.
    const hay = new Set(words(s.title || ''))
    const score = q.filter((w) => hay.has(w)).length
    if (score > bestScore) { best = s; bestScore = score }
  }
  return best
}

const list = (items: string[]) => items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
const short = (s: string, n = 60) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n).replace(/\s+\S*$/, '')}…` : t }

/** "What are you doing?" from busyState, the running tasks and the pending request. */
export function sayStatus(s: {
  turnInFlight: boolean; compacting?: boolean
  tasks: { subagentType?: string; description?: string }[]
  pending: string | null
  /** Keypad approvals on: the caller can allow from the phone. */
  keypad?: boolean
  /** The pending request is the one read out on this call (only then can the caller answer it). */
  heard?: boolean
}): string {
  const parts: string[] = []
  if (s.pending) parts.push(`I'm waiting for your OK to ${s.pending}. ${howToAnswer(!!s.heard, !!s.keypad)}`)
  if (s.tasks.length) {
    const named = s.tasks.slice(0, 3).map((t) => `the ${t.subagentType || 'helper'} agent${t.description ? ` on ${short(t.description, 50)}` : ''}`)
    parts.push(`${s.tasks.length === 1 ? 'One agent is' : `${s.tasks.length} agents are`} running: ${list(named)}.`)
  }
  if (s.turnInFlight && !s.tasks.length) parts.push("I'm working on your last request.")
  if (s.compacting) parts.push("I'm tidying up the conversation history.")
  return parts.length ? parts.join(' ') : "I'm not working on anything right now."
}

/** "What were my recent sessions?" from a sessions_list reply. */
export function saySessions(sessions: SessionChoice[], max = 5): string {
  const named = sessions.map((s) => short(s.title || '', 50)).filter(Boolean).slice(0, max)
  if (!named.length) return "I couldn't find any sessions."
  return `Your recent sessions: ${named.map((t, i) => `${i + 1}, ${t}`).join('. ')}. Say "switch to" and a name to open one.`
}

/** "What did you make?" from a session_artifacts reply. */
export function sayOutputs(artifacts: { fileName?: string }[], max = 5): string {
  const names = artifacts.map((a) => String(a.fileName || '')).filter(Boolean)
  if (!names.length) return "This session hasn't made any files yet."
  const more = names.length > max ? `, and ${names.length - max} more` : ''
  return `This session made ${names.length === 1 ? 'one file' : `${names.length} files`}: ${list(names.slice(0, max))}${more}. They are in the app under Outputs.`
}

/** A mode command while a request waits: nothing changed; how to answer the request instead. */
export function sayBlocked(blocked: 'mode' | 'switch', pending: string | null, keypad: boolean, heard: boolean): string {
  const didnt = blocked === 'mode' ? "didn't change the approval mode" : "didn't switch sessions"
  const what = pending ? `Osborn wants to ${pending}. ` : ''
  return `There's a request waiting, so I ${didnt}. ${what}${howToAnswer(heard, keypad)}`
}

/**
 * Whether the caller heard a spoken prompt in full: its playout finished and
 * was not interrupted (talking over it does not count). No handle → not heard.
 */
export async function promptHeard(handle: { waitForPlayout?(): Promise<unknown>; interrupted?: boolean } | null | undefined): Promise<boolean> {
  if (!handle?.waitForPlayout) return false
  await handle.waitForPlayout()
  return !handle.interrupted
}

/**
 * How the caller can answer a pending request. Only the request read out on
 * this call (phonePromptedRequestId, set after its prompt played in full) can
 * be answered by phone; any other is answered in the app.
 */
export function howToAnswer(heard: boolean, keypad: boolean): string {
  if (!heard) return 'Approve or deny it in the app.'
  return keypad ? 'Press 1 to allow or 2 to deny.' : 'Say no to deny it, or approve it in the app.'
}

/**
 * What a confirmed switch actually did, from the switch_session replies
 * (session_switched / session_switch_pending, as the app receives them).
 */
export function saySwitchOutcome(replies: { type?: string; success?: boolean; reason?: string }[], name: string): string {
  if (replies.some((r) => r.type === 'session_switch_cancelled' && r.reason === 'already_live')) return `You're already in ${name}.`
  if (replies.some((r) => r.type === 'session_switch_pending')) return `I'll switch to ${name} as soon as I finish the current step.`
  const done = replies.find((r) => r.type === 'session_switched')
  if (done?.success) return `Switched to ${name}.`
  switch (done?.reason) {
    case 'needs_you': return `I can't switch yet: a request is waiting for your answer. Answer it first, then ask again.`
    case 'meeting_active': return `I can't switch while I'm in a meeting.`
    case 'not_found': return `I couldn't open ${name}; it may have been moved or deleted.`
    case 'target_busy_in_background': return `${name} is busy in the background right now. Try again in a moment.`
  }
  return done ? `I couldn't switch to ${name}.` : `I asked to switch to ${name}; it hasn't confirmed yet.`
}

/** The spoken confirmation of a mode change. */
export function sayModeChanged(mode: ApprovalMode): string {
  return `${approvalModeLabel(mode)} is on. That's saved, so it stays on in the app and on later calls until you change it.`
}
