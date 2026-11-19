// Phone calls: the first voice actions (#367) and one dispatch for app commands.
// Run: npx tsx agent/tests/phone-voice-actions.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  matchVoiceAction,
  normalizeUtterance,
  phoneMayChangeMode,
  pickSession,
  howToAnswer,
  promptHeard,
  sayBlocked,
  saySwitchOutcome,
  sayModeChanged,
  sayOutputs,
  saySessions,
  sayStatus,
} from '../src/phone-voice-actions.js'
import { CONTROL_MESSAGE_TYPES, PHONE_ACTION_TYPES, READ_ONLY_MESSAGE_TYPES, phoneAnswerAllowed } from '../src/data-sender-auth.js'

let pass = 0
const asyncTests: Promise<void>[] = []
const t = (name: string, fn: () => unknown) => {
  const ok = () => { pass++; console.log('ok   ', name) }
  const fail = (e: any) => { console.log('FAIL ', name, '\n     ', String(e?.message ?? e).split('\n')[0]); process.exitCode = 1 }
  try {
    const r = fn()
    if (r && typeof (r as Promise<unknown>).then === 'function') asyncTests.push((r as Promise<unknown>).then(ok, fail))
    else ok()
  } catch (e: any) { fail(e) }
}
const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')
const idle = { permissionPending: false }
const pending = { permissionPending: true }

t('normalizeUtterance drops fillers, punctuation and a trailing please', () => {
  assert.equal(normalizeUtterance('Okay, Osborn — stop that, please!'), 'stop that')
  assert.equal(normalizeUtterance("What's pending?"), 'whats pending')
})

t('1. a yes/no answers a pending approval, and only while one is pending', () => {
  for (const s of ['Yes.', 'yeah', 'Allow it', 'OK, approve']) assert.deepEqual(matchVoiceAction(s, pending), { kind: 'answer', answer: 'allow' }, s)
  for (const s of ['No.', 'nope', 'deny', 'reject it']) assert.deepEqual(matchVoiceAction(s, pending), { kind: 'answer', answer: 'deny' }, s)
  assert.equal(matchVoiceAction('yes', idle), null, 'a plain yes is a normal turn when nothing is pending')
  assert.equal(matchVoiceAction('yes and also add a test for it', pending), null, 'not the whole utterance')
  for (const s of ['go ahead', 'sure', 'do it', "don't", 'do not do it']) assert.equal(matchVoiceAction(s, pending), null, `${s}: conversational, not an approval`)
})

t('2. approval mode by voice: no call-only mode', () => {
  assert.deepEqual(matchVoiceAction('Allow everything', idle), { kind: 'mode', mode: 'allow-all' })
  assert.deepEqual(matchVoiceAction('auto-review', idle), { kind: 'mode', mode: 'auto-review' })
  assert.deepEqual(matchVoiceAction('switch to auto review mode', idle), { kind: 'mode', mode: 'auto-review' }, 'mode wins over a session switch')
  assert.deepEqual(matchVoiceAction('ask me every time', idle), { kind: 'mode', mode: 'ask' })
  assert.deepEqual(matchVoiceAction('switch to ask me', idle), { kind: 'mode', mode: 'ask' })
  for (const s of ['allow everything for this call', 'auto review for the call', 'ask me first', 'ask me', 'allow all the tests to run']) {
    assert.equal(matchVoiceAction(s, idle), null, s)
  }
  assert.match(sayModeChanged('allow-all'), /saved/, 'the reply says the change is saved')
})

t('3. status', () => {
  for (const s of ['What are you doing?', "what's pending", 'are you busy', 'status update']) assert.deepEqual(matchVoiceAction(s, idle), { kind: 'status' }, s)
  for (const s of ["what's happening in this function", "what's going on", 'what are you up to with that refactor']) assert.equal(matchVoiceAction(s, idle), null, s)
})

t('4. stop the main turn or a named agent', () => {
  for (const s of ['Stop.', 'stop that', 'cancel that', 'Stop everything']) assert.deepEqual(matchVoiceAction(s, idle), { kind: 'stop' }, s)
  assert.deepEqual(matchVoiceAction('stop the researcher', idle), { kind: 'stop', agent: 'researcher' })
  assert.deepEqual(matchVoiceAction('Stop the writer agent.', idle), { kind: 'stop', agent: 'writer' })
  assert.deepEqual(matchVoiceAction('stop the docs helper agent', idle), { kind: 'stop', agent: 'docs helper' })
  for (const s of ['stop the build', 'stop the server', 'stop the bleeding', 'stop this', 'stop using tabs in the config file and use spaces instead', "don't stop"]) {
    assert.equal(matchVoiceAction(s, idle), null, s)
  }
})

const SESSIONS = [
  { sessionId: 'n', title: 'Next.js setup', cwd: '/w/site' },
  { sessionId: 'l', title: 'Login page redesign', cwd: '/w/web' },
  { sessionId: 'b', title: 'Fix the billing webhook', cwd: '/w/billing-service' },
  { sessionId: 'p', title: 'Landing page copy', cwd: '/w/site' },
  { sessionId: 'd', title: 'Dark mode toggle', cwd: '/w/ui' },
  { sessionId: 'a', title: 'Rate limits', cwd: '/w/api' },
]
const withSessions = { permissionPending: false, sessions: SESSIONS }
const target = (s: string, ctx: any = withSessions) => (matchVoiceAction(s, ctx) as any)?.target?.sessionId ?? null

t('6. switch: only "switch to the X session/project/conversation" or "switch session to X", matched by title', () => {
  assert.equal(target('Switch to my billing project'), 'b')
  assert.equal(target('switch to the billing webhook session'), 'b')
  assert.equal(target('switch session to the landing page'), 'p')
  assert.equal(target('switch to the login page redesign conversation'), 'l')
  // Everyday speech never switches, whatever sessions exist.
  for (const s of [
    'go back to the login page', 'go back to the login page redesign', 'go back to my api', 'switch to dark mode',
    'switch to the dark mode', 'go to the next step', 'move to the login page', 'go to the login page',
    'change to the next step', 'switch to the next step', 'switch to the login page',
  ]) {
    assert.equal(matchVoiceAction(s, withSessions), null, s)
  }
  // The folder name alone never picks a session.
  assert.equal(target('switch to the api project'), null, '"api" is only the folder of "Rate limits"')
  assert.equal(target('switch to the billing service project'), null, '"service" only in the folder: 1 of 2 title words')
  // No session picked → null, so the turn reaches the model (nothing spoken).
  assert.equal(matchVoiceAction('switch to the kubernetes project', withSessions), null)
  assert.equal(matchVoiceAction('switch to the billing project', idle), null, 'no session list → model')
  assert.doesNotMatch(src, /couldn't find a session/, 'the runner never speaks a miss')
})

t('6. a matched switch only asks; a yes in the next turn switches, a no or anything else does not', () => {
  const proposed = { permissionPending: false, switchProposed: true, sessions: SESSIONS }
  for (const s of ['yes', 'Yes please', 'yeah', 'do it']) assert.deepEqual(matchVoiceAction(s, proposed), { kind: 'confirm_switch' }, s)
  for (const s of ['no', 'cancel', 'stay here']) assert.deepEqual(matchVoiceAction(s, proposed), { kind: 'cancel_switch' }, s)
  assert.equal(matchVoiceAction('yes', withSessions), null, 'a yes with nothing proposed is a normal turn')
  assert.equal(matchVoiceAction('tell me about the webhook first', proposed), null, 'anything else goes to the model')
  // A heard approval request takes the yes first.
  assert.deepEqual(matchVoiceAction('yes', { ...proposed, permissionPending: true }), { kind: 'answer', answer: 'allow' })
  // The runner: "switch" only proposes; only "confirm_switch" runs switch_session; any other turn drops the proposal.
  const run = src.slice(src.indexOf("case 'switch': {"), src.indexOf("case 'outputs': {"))
  assert.match(run, /case 'switch': \{[\s\S]*?phoneSwitchProposal = \{ target, expires: Date\.now\(\) \+ 60_000 \}\s+return `Switch to \$\{name\}\?`/)
  assert.equal((run.match(/type: 'switch_session'/g) || []).length, 1)
  assert.ok(run.indexOf("type: 'switch_session'") > run.indexOf("case 'confirm_switch'"), 'switch_session only after a yes')
  assert.match(src, /if \(action\?\.kind !== 'confirm_switch' && action\?\.kind !== 'switch'\) phoneSwitchProposal = null/)
})

t('2. a mode command while a request is pending changes nothing and says how to answer', () => {
  for (const ctx of [{ permissionPending: true }, { permissionPending: false, anyPermissionPending: true }]) {
    assert.deepEqual(matchVoiceAction('allow all', ctx), { kind: 'blocked', what: 'mode' })
    assert.deepEqual(matchVoiceAction('switch to auto review', ctx), { kind: 'blocked', what: 'mode' })
    assert.notEqual((matchVoiceAction('allow everything', ctx) as any)?.kind, 'answer', '"allow everything" is never an answer')
  }
  assert.match(sayBlocked('mode', 'run the command npm test', false, true), /request waiting, so I didn't change the approval mode\. Osborn wants to run the command npm test\. Say no to deny it, or approve it in the app\./)
  assert.match(sayBlocked('mode', null, true, true), /Press 1 to allow or 2 to deny\./)
  const run = src.slice(src.indexOf("case 'blocked': {"), src.indexOf("case 'blocked': {") + 400)
  assert.doesNotMatch(run, /set_approval_mode|switch_session/)
  assert.match(src, /anyPermissionPending: !!pendingPermissionHolder\(\)/)
})

t('1. no switch is proposed or confirmed while a request is pending; its "yes" never settles the request', () => {
  const waiting = { permissionPending: false, anyPermissionPending: true, sessions: SESSIONS }
  assert.deepEqual(matchVoiceAction('switch to the billing project', waiting), { kind: 'blocked', what: 'switch' }, 'no proposal while a request waits')
  // A proposal made before the request arrived: its yes is blocked, not a confirm and not an answer.
  assert.deepEqual(matchVoiceAction('yes', { ...waiting, switchProposed: true }), { kind: 'blocked', what: 'switch' })
  assert.deepEqual(matchVoiceAction('no', { ...waiting, switchProposed: true }), { kind: 'cancel_switch' })
  assert.match(sayBlocked('switch', 'search the web', false, true), /^There's a request waiting, so I didn't switch sessions\. Osborn wants to search the web\./)
  // Reading a request out drops any switch proposal, and the blocked branch drops it too.
  const prompt = src.slice(src.indexOf('// The keypad and a spoken yes/no answer it only once'), src.indexOf('// The keypad and a spoken yes/no answer it only once') + 900)
  assert.match(prompt, /phoneSwitchProposal = null/)
  assert.match(src, /case 'blocked': \{\s+if \(action\.what === 'switch'\) phoneSwitchProposal = null/)
})

t('4. the keypad and a spoken yes/no answer a request only after its prompt has finished playing', () => {
  const prompt = src.slice(src.indexOf('// The keypad and a spoken yes/no answer it only once'), src.indexOf('// The keypad and a spoken yes/no answer it only once') + 900)
  assert.match(prompt, /phonePromptedRequestId = null[\s\S]*?\.say\?\.\(phoneApprovalPrompt\(toolName, input\)\)\)\s+\.then\(\(handle: any\) => promptHeard\(handle\)\)\s+\.then\(\(heard\) => \{[\s\S]{0,120}if \(heard && pendingPermissionHolder\(\)\?\.getPendingPermission\?\.\(\)\?\.requestId === requestId\) phonePromptedRequestId = requestId/)
  assert.equal((src.match(/phonePromptedRequestId = requestId/g) || []).length, 1, 'set in one place, after playout')
})

t('1. a prompt the caller talked over (interrupted) is not heard', async () => {
  const handle = (interrupted: boolean) => {
    let played = false
    return { get interrupted() { return played && interrupted }, waitForPlayout: async () => { played = true } }
  }
  assert.equal(await promptHeard(handle(false)), true, 'played in full')
  assert.equal(await promptHeard(handle(true)), false, 'interrupted: waitForPlayout resolved, but not heard')
  assert.equal(await promptHeard(null), false, 'no speech handle')
  assert.equal(await promptHeard({}), false, 'no playout to wait for')
})

t('2. the "how to answer" line is offered only for the request read out on the call', () => {
  assert.equal(howToAnswer(false, true), 'Approve or deny it in the app.')
  assert.equal(howToAnswer(false, false), 'Approve or deny it in the app.')
  assert.equal(howToAnswer(true, true), 'Press 1 to allow or 2 to deny.')
  assert.equal(howToAnswer(true, false), 'Say no to deny it, or approve it in the app.')
  const unheard = sayStatus({ turnInFlight: false, tasks: [], pending: 'search the web', keypad: true, heard: false })
  assert.equal(unheard, "I'm waiting for your OK to search the web. Approve or deny it in the app.")
  assert.doesNotMatch(unheard, /Press 1|say no/i)
  assert.doesNotMatch(sayBlocked('mode', 'search the web', true, false), /Press 1|say no/i)
  assert.match(sayBlocked('switch', 'search the web', false, false), /Approve or deny it in the app\.$/)
  // index.ts decides "heard" from phonePromptedRequestId, in both places.
  assert.equal((src.match(/heard: !!pending && pending\.requestId === phonePromptedRequestId/g) || []).length, 1, 'status')
  assert.match(src, /const heard = !!pending && pending\.requestId === phonePromptedRequestId\s+return sayBlocked\(action\.what, [^\n]+, heard\)/)
})

t('3. a voice switch to the already-live session (with another switch pending) speaks "already in"', () => {
  assert.match(src, /function cancelPendingSwitch\(reason: string, notify = true, reply: typeof sendToFrontend = publishToRoom\): void \{[\s\S]{0,300}if \(notify\) void reply\(\{ type: 'session_switch_cancelled'/)
  assert.match(src, /if \(pendingSwitch\) cancelPendingSwitch\('already_live', true, sendToFrontend\)/)
  assert.match(src, /replies\.filter\(\(r\) => r\?\.sessionId === target\.sessionId \|\| \(r\?\.type === 'session_switch_cancelled' && r\?\.reason === 'already_live'\)\)/)
  // The pending switch was to another session; its cancel still tells the caller the target was already live.
  assert.equal(saySwitchOutcome([{ type: 'session_switch_cancelled', reason: 'already_live', sessionId: 'other' } as any], 'Billing'), "You're already in Billing.")
})

t('2 (confirmed switch). the spoken outcome is what switch_session really did', () => {
  assert.equal(saySwitchOutcome([{ type: 'session_switched', success: true }], 'Billing'), 'Switched to Billing.')
  assert.match(saySwitchOutcome([{ type: 'session_switch_pending' }], 'Billing'), /as soon as I finish the current step/)
  assert.match(saySwitchOutcome([{ type: 'session_switched', success: false, reason: 'needs_you' }], 'Billing'), /request is waiting for your answer/)
  assert.match(saySwitchOutcome([{ type: 'session_switched', success: false, reason: 'meeting_active' }], 'Billing'), /in a meeting/)
  assert.match(saySwitchOutcome([{ type: 'session_switched', success: false, reason: 'not_found' }], 'Billing'), /couldn't open Billing/)
  assert.match(saySwitchOutcome([{ type: 'session_switched', success: false, reason: 'target_busy_in_background' }], 'Billing'), /busy in the background/)
  assert.match(saySwitchOutcome([{ type: 'session_switched', success: false, reason: 'switch_in_progress' }], 'Billing'), /^I couldn't switch to Billing\.$/)
  assert.equal(saySwitchOutcome([{ type: 'session_switch_cancelled', reason: 'already_live' }], 'Billing'), "You're already in Billing.")
  // The runner reads switch_session's real replies: requestSessionSwitch and performSessionSwitch reply through the caller's `reply`.
  assert.match(src, /const replies = await runAppAction\(\{ type: 'switch_session', sessionId: target\.sessionId, workingDirectory: target\.cwd \}\)[\s\S]{0,200}return saySwitchOutcome\(/)
  assert.match(src, /origin: 'switch_session', reply: sendToFrontend \}\)/)
  assert.match(src, /opts: \{ force\?: boolean; origin: string; reply\?: typeof sendToFrontend \},[\s\S]{0,200}const sendToFrontend = opts\.reply \?\? publishToRoom/)
  assert.match(src, /await performSessionSwitch\(target, cwd, plan, opts\.origin, opts\.reply\)/)
})

t('5. a refused set_approval_mode tells that tab the mode that is really on', () => {
  const start = src.indexOf('const handleDataReceived = async')
  const body = src.slice(start, src.indexOf('const dispatchAction = async'))
  assert.match(body, /if \(data\.type === 'set_approval_mode' && participant\?\.identity\) \{\s+await sendToFrontend\(\{ type: 'approval_mode', mode: approvalMode, error: [^}]+\}, participant\.identity\)/)
  const vr = readFileSync(join(here, '..', '..', 'frontend', 'src', 'components', 'VoiceRoom.tsx'), 'utf8')
  const setter = vr.slice(vr.indexOf('const setApprovalMode = useCallback'), vr.indexOf('const setApprovalMode = useCallback') + 300)
  assert.doesNotMatch(setter, /setApprovalModeState/, 'no optimistic update: the picker waits for the echo')
})


t('pickSession: title words only; at least half (rounded up), and at least 2 for a 2+ word name', () => {
  assert.equal(pickSession('billing', SESSIONS)?.sessionId, 'b', 'one word, one match')
  assert.equal(pickSession('billing service', SESSIONS), null, '"service" is only in the folder name')
  assert.equal(pickSession('api', SESSIONS), null, 'folder name alone')
  assert.equal(pickSession('landing page', SESSIONS)?.sessionId, 'p')
  assert.equal(pickSession('next step', SESSIONS), null, '1 of 2 words is not enough')
  assert.equal(pickSession('login page', SESSIONS)?.sessionId, 'l')
  assert.equal(pickSession('new login flow page', SESSIONS)?.sessionId, 'l', '2 of 4')
  assert.equal(pickSession('new login flow for mobile', SESSIONS), null, '1 of 4')
  assert.equal(pickSession('kubernetes', SESSIONS), null)
  assert.equal(pickSession('my project', SESSIONS), null, 'filler only')
  const tie = [{ sessionId: 'x', title: 'Billing export' }, { sessionId: 'y', title: 'Billing webhook' }]
  assert.equal(pickSession('billing', tie)?.sessionId, 'x', 'tie → most recent')
})


t('5, 7, 8. sessions, outputs, keep working', () => {
  assert.deepEqual(matchVoiceAction('What were my recent sessions?', idle), { kind: 'sessions' })
  assert.deepEqual(matchVoiceAction('What did you make?', idle), { kind: 'outputs' })
  assert.deepEqual(matchVoiceAction('read me the session summary', idle), { kind: 'outputs' })
  assert.deepEqual(matchVoiceAction('Keep working after I hang up', idle), { kind: 'keep_working' })
  for (const s of ['keep going', 'keep working', 'keep working on it', 'read me the summary', 'what did you make of the error', 'recent conversations with the client']) {
    assert.equal(matchVoiceAction(s, idle), null, s)
  }
})

t('ordinary requests stay with the model', () => {
  for (const s of ['run the test suite', 'what is the capital of France', 'switch the button colour to blue in the header component please now', 'tell me about my billing code', '']) {
    assert.equal(matchVoiceAction(s, idle), null, s)
  }
})

t('a call may only answer deny, and only make the mode stricter, until keypad approvals are on', () => {
  assert.equal(phoneAnswerAllowed('deny'), true)
  assert.equal(phoneAnswerAllowed('allow'), false)
  assert.equal(phoneAnswerAllowed('always_allow'), false)
  assert.equal(phoneAnswerAllowed('allow', true), true)
  assert.equal(phoneMayChangeMode('allow-all', 'ask', false), true)
  assert.equal(phoneMayChangeMode('allow-all', 'auto-review', false), true)
  assert.equal(phoneMayChangeMode('ask', 'auto-review', false), false)
  assert.equal(phoneMayChangeMode('auto-review', 'allow-all', false), false)
  assert.equal(phoneMayChangeMode('ask', 'allow-all', true), true)
})



t('spoken replies', () => {
  assert.equal(sayStatus({ turnInFlight: false, tasks: [], pending: null }), "I'm not working on anything right now.")
  assert.match(sayStatus({ turnInFlight: true, tasks: [{ subagentType: 'researcher', description: 'compare SIP providers' }], pending: 'run the command npm test', keypad: false, heard: true }),
    /^I'm waiting for your OK to run the command npm test\. Say no to deny it, or approve it in the app\. One agent is running: the researcher agent on compare SIP providers\.$/)
  assert.match(sayStatus({ turnInFlight: false, tasks: [], pending: 'search the web', keypad: true, heard: true }), /Press 1 to allow or 2 to deny/)
  assert.equal(saySessions([]), "I couldn't find any sessions.")
  assert.match(saySessions([{ sessionId: 'a', title: 'One' }, { sessionId: 'b', title: 'Two' }]), /^Your recent sessions: 1, One\. 2, Two\. /)
  assert.equal(sayOutputs([]), "This session hasn't made any files yet.")
  assert.match(sayOutputs(['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md'].map((fileName) => ({ fileName }))), /6 files: a\.md, b\.md, c\.md, d\.md and e\.md, and 1 more\./)
  assert.match(sayModeChanged('auto-review'), /^Auto-review is on\./)
})

t('PHONE_ACTION_TYPES are app commands the gate already classifies', () => {
  for (const ty of PHONE_ACTION_TYPES) assert.ok(CONTROL_MESSAGE_TYPES.has(ty) || READ_ONLY_MESSAGE_TYPES.has(ty), ty)
  assert.deepEqual([...PHONE_ACTION_TYPES].sort(), ['get_busy', 'get_session_artifacts', 'keep_working', 'list_sessions', 'permission_response', 'set_approval_mode', 'stop_dispatch', 'switch_session'])
  const body = src.slice(src.indexOf('const dispatchAction = async'))
  for (const ty of PHONE_ACTION_TYPES) assert.match(body, new RegExp(`data\\.type === '${ty}'`), `dispatchAction handles ${ty}`)
})

t('index.ts: handleDataReceived checks the sender, then runs the one dispatch', () => {
  const start = src.indexOf('const handleDataReceived = async')
  const body = src.slice(start, src.indexOf('const dispatchAction = async'))
  const check = body.indexOf('checkControlSender(')
  const run = body.indexOf('await dispatchAction(data, { sender: participant?.identity })')
  assert.ok(check > 0 && run > check)
  assert.doesNotMatch(body, /data\.type === 'permission_response'/, 'no handlers left outside dispatchAction')
})

t('the agent cannot loosen its mode or answer an approval over HTTP: there is no /action route', () => {
  assert.doesNotMatch(src, /pathname === '\/action'/, 'no POST /action')
  assert.doesNotMatch(src, /actionHook/, 'nothing outside main() can reach runAppAction')
  assert.doesNotMatch(src, /'\/action'/, 'not an agent route prefix')
  // runAppAction is called only by the phone voice-action runner.
  const calls = [...src.matchAll(/runAppAction\(/g)].map((m) => m.index!)
  const runner = src.indexOf('async function runPhoneVoiceAction')
  const end = src.indexOf('\n  }\n', runner)
  const outside = calls.filter((i) => i < runner || i > end).filter((i) => !src.slice(i - 40, i).includes('const '))
  assert.deepEqual(outside, [], 'runAppAction is used only by runPhoneVoiceAction')
  // set_approval_mode and permission_response reach dispatchAction only from the owner's data channel or the caller's voice.
  assert.match(src, /function takePhoneVoiceAction\(text: string\): boolean \{\s+if \(!inPhoneRoom\(\)\) return false/)
})
t('index.ts: a spoken yes/no and the keypad answer only the request the caller heard', () => {
  assert.match(src, /const heard = !!phonePromptedRequestId && pendingPermissionHolder\(\)\?\.getPendingPermission\?\.\(\)\?\.requestId === phonePromptedRequestId/)
  assert.match(src, /permissionPending: heard, anyPermissionPending: !!pendingPermissionHolder\(\), switchProposed, sessions: phoneSessions,/)
  assert.match(src, /if \(inPhoneRoom\(\)\) \{\s+phonePromptedRequestId = null/, "a new prompt first un-hears the previous request")
})
t('index.ts: voice actions go through runAppAction and its allow-list', () => {
  assert.match(src, /const runAppAction = async[\s\S]{0,200}if \(!PHONE_ACTION_TYPES\.has\(String\(data\?\.type\)\)\) throw/)
  const voice = src.slice(src.indexOf('async function runPhoneVoiceAction'), src.indexOf('async function runPhoneVoiceAction') + 6000)
  assert.match(voice, /phoneAnswerAllowed\(action\.answer\)[\s\S]{0,400}runAppAction\(\{ type: 'permission_response', response: action\.answer, requestId \}\)/)
  assert.match(voice, /phoneMayChangeMode\(approvalMode, action\.mode, PHONE_KEYPAD_APPROVALS_ENABLED\)/)
  assert.match(voice, /runAppAction\(\{ type: 'switch_session'/)
  assert.match(voice, /runAppAction\(\{ type: 'stop_dispatch'/)
  assert.match(voice, /if \(!PHONE_TOOLS_ENABLED\) return/)
  assert.match(src, /function takePhoneVoiceAction\(text: string\): boolean \{\s+if \(!inPhoneRoom\(\)\) return false/)
  assert.equal((src.match(/takeVoiceAction: takePhoneVoiceAction/g) || []).length, 2, 'both pipeline builds')
})

t('pipeline-direct-llm: a handled voice action stops before any enrichment or model call', () => {
  const p = readFileSync(join(here, '..', 'src', 'pipeline-direct-llm.ts'), 'utf8')
  const gate = p.indexOf('noiseGate.shouldGate(userText)')
  const take = p.indexOf('this.#opts.takeVoiceAction?.(userText)')
  const interrupt = p.indexOf('getAndConsumeInterruptionContext?.()')
  assert.ok(gate > 0 && take > gate && interrupt > take)
})

t('prompts: no tool called respond_permission is referenced', () => {
  const prompts = readFileSync(join(here, '..', 'src', 'prompts.ts'), 'utf8')
  assert.doesNotMatch(prompts, /respond_permission/)
})

void Promise.all(asyncTests).then(() => console.log(`\n${pass} passed${process.exitCode ? ", some FAILED" : ""}`))
