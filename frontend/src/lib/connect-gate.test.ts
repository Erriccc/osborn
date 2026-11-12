// Unit tests for the #87 / #53 / #78 connect-gate helpers — the "Connecting…"
// watchdog state machine + the fresh-account Claude-auth prompt discipline.
// Run:  cd frontend && npx tsx src/lib/connect-gate.test.ts
//   (or, with Node 22+ type-stripping: node --experimental-strip-types src/lib/connect-gate.test.ts)

import assert from 'node:assert/strict'
import {
  isOAuthInProgress,
  nextAuthRequired,
  isAwaitingAgent,
  connectTimeoutMessage,
  isAuthGateTerminal,
  isAuthPromptMessage,
  shouldAutoOpenAuthModal,
  CONNECT_WATCHDOG_MS,
  type ConnectWaitState,
} from './connect-gate'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

// A fully-resolved baseline we mutate per-case.
const base: ConnectWaitState = {
  connecting: false,
  agentReady: false,
  hasToken: false,
  error: false,
  authRequired: false,
  authInProgress: false,
}

// --- isOAuthInProgress --------------------------------------------------------
check('isOAuthInProgress: active steps are in-progress', () => {
  for (const s of ['required', 'waiting', 'waiting_code', 'submitting'] as const) {
    assert.equal(isOAuthInProgress(s), true, s)
  }
})
check('isOAuthInProgress: none/complete/error are NOT in-progress', () => {
  for (const s of ['none', 'complete', 'error'] as const) {
    assert.equal(isOAuthInProgress(s), false, s)
  }
})

// --- nextAuthRequired ---------------------------------------------------------
check('nextAuthRequired: set on required/url, cleared on complete/error', () => {
  assert.equal(nextAuthRequired(false, 'claude_auth_required'), true)
  assert.equal(nextAuthRequired(false, 'claude_auth_url'), true)
  assert.equal(nextAuthRequired(true, 'claude_auth_complete'), false)
  assert.equal(nextAuthRequired(true, 'claude_auth_error'), false)
})
check('nextAuthRequired: unrelated message keeps previous', () => {
  assert.equal(nextAuthRequired(true, 'agent_ready'), true)
  assert.equal(nextAuthRequired(false, 'transcript'), false)
})

// --- isAwaitingAgent (the watchdog ARM decision) ------------------------------
check('isAwaitingAgent: connecting with nothing resolved → armed', () => {
  assert.equal(isAwaitingAgent({ ...base, connecting: true }), true)
})
check('isAwaitingAgent: token handed off but no agent_ready → still armed (#78)', () => {
  // The #78 core: a transport connection without agent_ready must NOT disarm —
  // otherwise a dismissed sign-in modal leaves the user on "Connecting…" forever.
  assert.equal(isAwaitingAgent({ ...base, hasToken: true }), true)
})
check('isAwaitingAgent: agent_ready disarms', () => {
  assert.equal(isAwaitingAgent({ ...base, connecting: true, agentReady: true }), false)
})
check('isAwaitingAgent: an existing error disarms', () => {
  assert.equal(isAwaitingAgent({ ...base, connecting: true, error: true }), false)
})
check('isAwaitingAgent: mid-OAuth (modal open) disarms — never cut off a sign-in', () => {
  assert.equal(isAwaitingAgent({ ...base, connecting: true, authInProgress: true }), false)
})
check('isAwaitingAgent: authRequired pending alone does NOT disarm (dismissed modal still bounded)', () => {
  // authRequired = the agent asked for sign-in, but the modal is NOT open on an
  // active step. The watchdog must stay armed so a dismissed prompt is bounded.
  assert.equal(isAwaitingAgent({ ...base, hasToken: true, authRequired: true, authInProgress: false }), true)
})
check('isAwaitingAgent: idle (not connecting, no token) → not armed', () => {
  assert.equal(isAwaitingAgent({ ...base }), false)
})

// --- connectTimeoutMessage ----------------------------------------------------
check('connectTimeoutMessage: auth-aware wording', () => {
  assert.match(connectTimeoutMessage(true), /sign-in/i)
  assert.match(connectTimeoutMessage(false), /connecting/i)
  assert.notEqual(connectTimeoutMessage(true), connectTimeoutMessage(false))
})

// --- CONNECT_WATCHDOG_MS ------------------------------------------------------
check('CONNECT_WATCHDOG_MS: bounded and generous (30s–5min)', () => {
  assert.equal(typeof CONNECT_WATCHDOG_MS, 'number')
  assert.ok(CONNECT_WATCHDOG_MS >= 30_000 && CONNECT_WATCHDOG_MS <= 300_000, String(CONNECT_WATCHDOG_MS))
})

// --- isAuthGateTerminal -------------------------------------------------------
check('isAuthGateTerminal: everRequired + modal closed → terminal banner', () => {
  assert.equal(isAuthGateTerminal(true, 'none'), true)
})
check('isAuthGateTerminal: modal still open → not terminal (modal is showing)', () => {
  assert.equal(isAuthGateTerminal(true, 'waiting'), false)
})
check('isAuthGateTerminal: never asked → no banner', () => {
  assert.equal(isAuthGateTerminal(false, 'none'), false)
})

// --- prompt discipline (#87 §6) ----------------------------------------------
check('isAuthPromptMessage: only the three opening messages', () => {
  assert.equal(isAuthPromptMessage('claude_auth_required'), true)
  assert.equal(isAuthPromptMessage('claude_auth_url'), true)
  assert.equal(isAuthPromptMessage('claude_auth_waiting_code'), true)
  assert.equal(isAuthPromptMessage('claude_auth_submitting'), false)
  assert.equal(isAuthPromptMessage('claude_auth_complete'), false)
  assert.equal(isAuthPromptMessage('agent_ready'), false)
})
check('shouldAutoOpenAuthModal: opens on a prompt message when not dismissed', () => {
  assert.equal(shouldAutoOpenAuthModal('claude_auth_required', false), true)
  assert.equal(shouldAutoOpenAuthModal('claude_auth_url', false), true)
})
check('shouldAutoOpenAuthModal: dismissed → never re-opens (the #87 §5 bug)', () => {
  assert.equal(shouldAutoOpenAuthModal('claude_auth_required', true), false)
  assert.equal(shouldAutoOpenAuthModal('claude_auth_url', true), false)
  assert.equal(shouldAutoOpenAuthModal('claude_auth_waiting_code', true), false)
})
check('shouldAutoOpenAuthModal: non-prompt message never opens', () => {
  assert.equal(shouldAutoOpenAuthModal('claude_auth_submitting', false), false)
  assert.equal(shouldAutoOpenAuthModal('agent_ready', false), false)
})

console.log(`\n${passed} passed`)
