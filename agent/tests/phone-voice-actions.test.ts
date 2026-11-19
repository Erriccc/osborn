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
  sayModeChanged,
  sayOutputs,
  saySessions,
  sayStatus,
} from '../src/phone-voice-actions.js'
import { CONTROL_MESSAGE_TYPES, PHONE_ACTION_TYPES, READ_ONLY_MESSAGE_TYPES, phoneAnswerAllowed } from '../src/data-sender-auth.js'

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
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
  for (const s of ['Yes.', 'yeah', 'Allow it', 'go ahead', 'OK, approve']) assert.deepEqual(matchVoiceAction(s, pending), { kind: 'answer', answer: 'allow' }, s)
  for (const s of ['No.', 'nope', 'deny', "Don't", 'reject it']) assert.deepEqual(matchVoiceAction(s, pending), { kind: 'answer', answer: 'deny' }, s)
  assert.equal(matchVoiceAction('yes', idle), null, 'a plain yes is a normal turn when nothing is pending')
  assert.equal(matchVoiceAction('yes and also add a test for it', pending), null, 'not the whole utterance')
})

t('2. approval mode by voice', () => {
  assert.deepEqual(matchVoiceAction('Allow everything for this call', idle), { kind: 'mode', mode: 'allow-all' })
  assert.deepEqual(matchVoiceAction('auto-review', idle), { kind: 'mode', mode: 'auto-review' })
  assert.deepEqual(matchVoiceAction('switch to auto review mode', idle), { kind: 'mode', mode: 'auto-review' }, 'mode wins over a session switch')
  assert.deepEqual(matchVoiceAction('ask me first', idle), { kind: 'mode', mode: 'ask' })
})

t('3. status', () => {
  for (const s of ['What are you doing?', "what's pending", 'are you busy', 'status update']) assert.deepEqual(matchVoiceAction(s, idle), { kind: 'status' }, s)
})

t('4. stop the main turn or one agent', () => {
  for (const s of ['Stop.', 'stop that', 'cancel that', 'Stop everything']) assert.deepEqual(matchVoiceAction(s, idle), { kind: 'stop' }, s)
  assert.deepEqual(matchVoiceAction('stop the researcher', idle), { kind: 'stop', agent: 'researcher' })
  assert.deepEqual(matchVoiceAction('Stop the writer agent.', idle), { kind: 'stop', agent: 'writer' })
  assert.equal(matchVoiceAction('stop using tabs in the config file and use spaces instead', idle), null)
  assert.equal(matchVoiceAction("don't stop", idle), null)
})

t('5-8. sessions, switch, outputs, keep working', () => {
  assert.deepEqual(matchVoiceAction('What were my recent sessions?', idle), { kind: 'sessions' })
  assert.deepEqual(matchVoiceAction('Switch to my billing project', idle), { kind: 'switch', query: 'billing' })
  assert.deepEqual(matchVoiceAction('go back to the landing page session', idle), { kind: 'switch', query: 'landing page' })
  assert.deepEqual(matchVoiceAction('What did you make?', idle), { kind: 'outputs' })
  assert.deepEqual(matchVoiceAction('read me the summary', idle), { kind: 'outputs' })
  assert.deepEqual(matchVoiceAction('Keep working after I hang up', idle), { kind: 'keep_working' })
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

t('pickSession: most words of the spoken name, ties to the most recent', () => {
  const sessions = [
    { sessionId: 'a', title: 'Fix the billing webhook', cwd: '/w/api' },
    { sessionId: 'b', title: 'Landing page copy', cwd: '/w/site' },
    { sessionId: 'c', title: 'Billing export to CSV', cwd: '/w/billing-service' },
  ]
  assert.equal(pickSession('billing', sessions)?.sessionId, 'a', 'tie → most recent')
  assert.equal(pickSession('billing service', sessions)?.sessionId, 'c', 'project folder counts')
  assert.equal(pickSession('landing page', sessions)?.sessionId, 'b')
  assert.equal(pickSession('kubernetes', sessions), null)
  assert.equal(pickSession('my project', sessions), null, 'filler only')
})

t('spoken replies', () => {
  assert.equal(sayStatus({ turnInFlight: false, tasks: [], pending: null }), "I'm not working on anything right now.")
  assert.match(sayStatus({ turnInFlight: true, tasks: [{ subagentType: 'researcher', description: 'compare SIP providers' }], pending: 'run the command npm test', keypad: false }),
    /^I'm waiting for your OK to run the command npm test\. Approve it in the app, or say no to deny it\. One agent is running: the researcher agent on compare SIP providers\.$/)
  assert.match(sayStatus({ turnInFlight: false, tasks: [], pending: 'search the web', keypad: true }), /Press 1 to allow or 2 to deny/)
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
  assert.match(src, /const heard = !!phonePromptedRequestId && pendingPermissionHolder\(\)\?\.getPendingPermission\?\.\(\)\?\.requestId === phonePromptedRequestId\s+const action = matchVoiceAction\(text, \{ permissionPending: heard \}\)/)
  assert.match(src, /if \(inPhoneRoom\(\)\) \{\s+phonePromptedRequestId = requestId/)
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

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`)
