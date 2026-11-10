// Run: cd frontend && npx --yes tsx tests/connect-gate.test.ts
// Spec (issue #53): the chat connect watchdog arms only while the UI is
// genuinely waiting on the agent, disarms the moment the session connects /
// errors / needs Anthropic sign-in (so an account mid-OAuth is never cut off),
// and surfaces an auth-aware, actionable message. Also asserts the provider
// actually wires the watchdog + the Cancel abort guard.
import fs from 'node:fs'
import path from 'node:path'
import {
  CONNECT_WATCHDOG_MS,
  connectTimeoutMessage,
  isAwaitingAgent,
  type ConnectWaitState,
} from '../src/lib/connect-gate'

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(a === b, `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const base: ConnectWaitState = { connecting: false, connected: false, hasToken: false, error: false, authRequired: false }

t('armed while connecting pre-token', () => {
  eq(isAwaitingAgent({ ...base, connecting: true }), true, 'connecting→armed')
})

t('armed after token handoff but before agent_ready', () => {
  eq(isAwaitingAgent({ ...base, hasToken: true }), true, 'token+!connected→armed')
})

t('disarms once the session is connected', () => {
  eq(isAwaitingAgent({ ...base, hasToken: true, connected: true }), false, 'connected→disarmed')
})

t('disarms once an error is already shown', () => {
  eq(isAwaitingAgent({ ...base, connecting: true, error: true }), false, 'error→disarmed')
})

t('disarms while Anthropic sign-in is pending (OAuth modal is its own resolution)', () => {
  // This is the crux: a fresh account blocks on ensureClaudeAuth(), so
  // agent_ready never arrives — but we must NOT fire a timeout error at them
  // while the sign-in modal is up.
  eq(isAwaitingAgent({ ...base, hasToken: true, authRequired: true }), false, 'authRequired→disarmed')
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

// ── Wiring guards: cheap static checks so a refactor can't silently drop the fix.
const root = path.resolve(__dirname, '..')
const provider = fs.readFileSync(path.join(root, 'src/components/ChatSessionProvider.tsx'), 'utf8')
const voiceRoom = fs.readFileSync(path.join(root, 'src/components/VoiceRoom.tsx'), 'utf8')

t('provider arms the watchdog via isAwaitingAgent', () => {
  ok(provider.includes('isAwaitingAgent('), 'isAwaitingAgent used')
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
})

// ── Report ────────────────────────────────────────────────────────────────
let failed = 0
for (const [name, pass, err] of results) {
  console.log(`${pass ? '✅' : '❌'} ${name}${err ? ` — ${err}` : ''}`)
  if (!pass) failed++
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
