// Unit tests for the #87 gap-3 agent-health helpers (version floor + key health).
// Run:  cd frontend && npx tsx src/lib/agent-health.test.ts
//   (or, with Node 22+ type-stripping: node --experimental-strip-types src/lib/agent-health.test.ts)

import assert from 'node:assert/strict'
import {
  compareSemver,
  isBelowFallbackFloor,
  resolveAgentHealth,
  FALLBACK_VERSION_FLOOR,
  type KeyHealthEntry,
} from './agent-health'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

// --- compareSemver ------------------------------------------------------------
check('compareSemver: orders patch/minor/major', () => {
  assert.equal(compareSemver('0.9.268', '0.9.269'), -1)
  assert.equal(compareSemver('0.9.269', '0.9.268'), 1)
  assert.equal(compareSemver('0.9.269', '0.9.269'), 0)
  assert.equal(compareSemver('0.10.0', '0.9.999'), 1) // numeric, not lexical
  assert.equal(compareSemver('1.0.0', '0.9.999'), 1)
})
check('compareSemver: tolerates leading v and short forms', () => {
  assert.equal(compareSemver('v0.9.269', '0.9.269'), 0)
  assert.equal(compareSemver('0.9', '0.9.0'), 0)
  assert.equal(compareSemver('0.9.1', '0.9'), 1)
})
check('compareSemver: unknown/blank/garbage → 0 (never a false order)', () => {
  assert.equal(compareSemver('', '0.9.269'), 0)
  assert.equal(compareSemver('latest', '0.9.269'), 0)
  assert.equal(compareSemver('0.9.269', 'unknown'), 0)
})

// --- isBelowFallbackFloor -----------------------------------------------------
check('isBelowFallbackFloor: the observed 0.9.268 test-account case is below floor', () => {
  assert.equal(isBelowFallbackFloor('0.9.268'), true)
})
check('isBelowFallbackFloor: the floor itself and newer are NOT below', () => {
  assert.equal(isBelowFallbackFloor('0.9.269'), false)
  assert.equal(isBelowFallbackFloor('0.9.276'), false)
  assert.equal(isBelowFallbackFloor('1.0.0'), false)
})
check('isBelowFallbackFloor: unknown version never trips the floor', () => {
  assert.equal(isBelowFallbackFloor(null), false)
  assert.equal(isBelowFallbackFloor(undefined), false)
  assert.equal(isBelowFallbackFloor(''), false)
  assert.equal(isBelowFallbackFloor('latest'), false)
})
check('FALLBACK_VERSION_FLOOR is the documented 0.9.269', () => {
  assert.equal(FALLBACK_VERSION_FLOOR, '0.9.269')
})

// --- resolveAgentHealth: gating on relyingOnFallback --------------------------
check('resolveAgentHealth: Claude-connected session never shows a notice', () => {
  // Below floor, but the user has Claude → the demo tier's health is irrelevant.
  const v = resolveAgentHealth({ version: '0.9.268', relyingOnFallback: false })
  assert.equal(v.show, false)
  assert.equal(v.level, 'ok')
})
check('resolveAgentHealth: default (relying unset) is treated as not relying', () => {
  assert.equal(resolveAgentHealth({ version: '0.9.268' }).show, false)
})

// --- resolveAgentHealth: version floor ---------------------------------------
check('resolveAgentHealth: no-Claude session on a pre-floor agent → version-floor notice', () => {
  const v = resolveAgentHealth({ version: '0.9.268', relyingOnFallback: true })
  assert.equal(v.level, 'version-floor')
  assert.equal(v.show, true)
  assert.equal(v.label, 'Update needed')
  assert.match(v.title, /0\.9\.268/)
  assert.match(v.title, /0\.9\.269/)
})
check('resolveAgentHealth: no-Claude session on a current agent, no key data → ok', () => {
  const v = resolveAgentHealth({ version: '0.9.276', relyingOnFallback: true })
  assert.equal(v.show, false)
  assert.equal(v.level, 'ok')
})
check('resolveAgentHealth: unknown version does not fabricate a floor warning', () => {
  const v = resolveAgentHealth({ version: null, relyingOnFallback: true })
  assert.equal(v.show, false)
})

// --- resolveAgentHealth: key health (agent-emitted shape) --------------------
check('resolveAgentHealth: all keys failed/expired → No working model', () => {
  const keyHealth: KeyHealthEntry[] = [
    { provider: 'zai', status: 'failed' },
    { provider: 'openrouter', status: 'expired' },
  ]
  const v = resolveAgentHealth({ version: '0.9.276', relyingOnFallback: true, keyHealth })
  assert.equal(v.level, 'keys-failed')
  assert.equal(v.label, 'No working model')
  assert.match(v.title, /zai \(failed\)/)
  assert.match(v.title, /openrouter \(expired\)/)
})
check('resolveAgentHealth: at least one key OK → no key notice', () => {
  const keyHealth: KeyHealthEntry[] = [
    { provider: 'zai', status: 'failed' },
    { provider: 'openrouter', status: 'ok' },
  ]
  assert.equal(resolveAgentHealth({ version: '0.9.276', relyingOnFallback: true, keyHealth }).show, false)
})
check('resolveAgentHealth: version floor outranks key health', () => {
  const keyHealth: KeyHealthEntry[] = [{ provider: 'zai', status: 'ok' }]
  const v = resolveAgentHealth({ version: '0.9.268', relyingOnFallback: true, keyHealth })
  assert.equal(v.level, 'version-floor')
})
check('resolveAgentHealth: empty key list is not "all failed"', () => {
  assert.equal(resolveAgentHealth({ version: '0.9.276', relyingOnFallback: true, keyHealth: [] }).show, false)
})

// --- resolveAgentHealth: mainProvider gating (house tier in, Claude out) -----
const DEAD: KeyHealthEntry[] = [{ provider: 'zai', status: 'expired' }]
check('resolveAgentHealth: house-tier provider alone shows the notice (no auth modal)', () => {
  assert.equal(resolveAgentHealth({ version: '0.9.278', mainProvider: 'zai', keyHealth: DEAD }).level, 'keys-failed')
  assert.equal(resolveAgentHealth({ version: '0.9.278', mainProvider: 'openrouter', keyHealth: DEAD }).level, 'keys-failed')
})
check('resolveAgentHealth: a Claude provider overrules the sticky fallback flag', () => {
  // Mid-session sign-in: claudeAuthEverRequired stays true forever, but the
  // session now answers on Claude — the dead z.ai verdict must not be shown.
  assert.equal(resolveAgentHealth({ version: '0.9.278', relyingOnFallback: true, mainProvider: 'claude', keyHealth: DEAD }).show, false)
  assert.equal(resolveAgentHealth({ version: '0.9.268', relyingOnFallback: true, mainProvider: 'claude' }).show, false)
})
check("resolveAgentHealth: a user's own anthropic key is not a demo-tier concern", () => {
  assert.equal(resolveAgentHealth({ version: '0.9.278', relyingOnFallback: true, mainProvider: 'ANTHROPIC', keyHealth: DEAD }).show, false)
})
check('resolveAgentHealth: unknown provider leaves the sticky flag in charge', () => {
  assert.equal(resolveAgentHealth({ version: '0.9.278', mainProvider: null, keyHealth: DEAD }).show, false)
  assert.equal(resolveAgentHealth({ version: '0.9.278', relyingOnFallback: true, mainProvider: null, keyHealth: DEAD }).level, 'keys-failed')
})

console.log(`\n${passed} passed`)
