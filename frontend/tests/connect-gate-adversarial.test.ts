import assert from 'node:assert'
import { isAwaitingAgent, isOAuthInProgress, nextAuthRequired, connectTimeoutMessage, type ConnectWaitState, type ClaudeAuthStatus } from '../src/lib/connect-gate'
const base: ConnectWaitState = { connecting: false, agentReady: false, hasToken: false, error: false, authRequired: false, authInProgress: false }
let pass = 0, fail = 0
function t(n: string, f: () => void) { try { f(); pass++; console.log('PASS', n) } catch (e: any) { fail++; console.log('FAIL', n, e.message) } }
t('unknown status strings not in progress', () => { for (const s of ['', 'REQUIRED', 'Waiting', 'foo', 'undefined', ' required']) assert.equal(isOAuthInProgress(s as ClaudeAuthStatus), false) })
t('null/undefined status not in progress', () => { assert.equal(isOAuthInProgress(undefined as any), false); assert.equal(isOAuthInProgress(null as any), false) })
t('active steps true', () => { for (const s of ['required','waiting','waiting_code','submitting']) assert.equal(isOAuthInProgress(s as any), true) })
t('terminal/none false', () => { for (const s of ['none','complete','error']) assert.equal(isOAuthInProgress(s as any), false) })
t('(a) modal open holds watchdog', () => { assert.equal(isAwaitingAgent({ ...base, hasToken: true, authRequired: true, authInProgress: true }), false); assert.equal(isAwaitingAgent({ ...base, connecting: true, authInProgress: true }), false) })
t('(b) dismissed, not ready -> awaiting + auth msg', () => { assert.equal(isAwaitingAgent({ ...base, hasToken: true, authRequired: true }), true); assert.match(connectTimeoutMessage(true), /sign-in/i); assert.ok(connectTimeoutMessage(true) !== connectTimeoutMessage(false)) })
t('(c) agentReady never awaiting even w/ auth flagged', () => { for (const c of [true,false]) for (const h of [true,false]) for (const a of [true,false]) assert.equal(isAwaitingAgent({ ...base, agentReady: true, connecting: c, hasToken: h, authRequired: true, authInProgress: a }), false) })
t('token present but not connecting -> awaiting', () => { assert.equal(isAwaitingAgent({ ...base, hasToken: true }), true) })
t('idle not awaiting', () => { assert.equal(isAwaitingAgent(base), false) })
t('connecting without token awaiting', () => { assert.equal(isAwaitingAgent({ ...base, connecting: true }), true) })
t('error and agentReady both -> false', () => { assert.equal(isAwaitingAgent({ ...base, error: true, agentReady: true, hasToken: true, connecting: true }), false) })
t('error alone disarms even with token', () => { assert.equal(isAwaitingAgent({ ...base, error: true, hasToken: true, authRequired: true }), false) })
t('(d) complete/error clear flag', () => { assert.equal(nextAuthRequired(true, 'claude_auth_complete'), false); assert.equal(nextAuthRequired(true, 'claude_auth_error'), false) })
t('(d) after error, not ready -> still awaiting', () => { const a = nextAuthRequired(true, 'claude_auth_error'); assert.equal(isAwaitingAgent({ ...base, hasToken: true, authRequired: a }), true); assert.equal(connectTimeoutMessage(a), connectTimeoutMessage(false)) })
t('set on required/url; unrelated keeps prev', () => { assert.equal(nextAuthRequired(false,'claude_auth_required'), true); assert.equal(nextAuthRequired(false,'claude_auth_url'), true); assert.equal(nextAuthRequired(true,'agent_ready'), true); assert.equal(nextAuthRequired(false,'agent_ready'), false); assert.equal(nextAuthRequired(true,''), true) })
t('reopen after dismiss: re-holds, then re-arms', () => {
  let s: ConnectWaitState = { ...base, hasToken: true, authRequired: true }
  assert.equal(isAwaitingAgent(s), true)
  s = { ...s, authInProgress: isOAuthInProgress('waiting') }; assert.equal(isAwaitingAgent(s), false)
  s = { ...s, authInProgress: isOAuthInProgress('none') }; assert.equal(isAwaitingAgent(s), true)
  s = { ...s, authInProgress: isOAuthInProgress('required') }; assert.equal(isAwaitingAgent(s), false)
})
t('(e) normal path', () => { assert.equal(isAwaitingAgent({ ...base, connecting: true }), true); assert.equal(isAwaitingAgent({ ...base, hasToken: true }), true); assert.equal(isAwaitingAgent({ ...base, hasToken: true, agentReady: true }), false); assert.match(connectTimeoutMessage(false), /Retry/) })
console.log(`${pass}/${pass+fail} passed`); process.exit(fail ? 1 : 0)
