// Unit tests for the #87 model/provider badge helpers.
// Run:  cd frontend && npx tsx src/lib/modelBadge.test.ts
//   (or, with Node 22+ type-stripping: node --experimental-strip-types src/lib/modelBadge.test.ts)

import assert from 'node:assert/strict'
import { providerLabel, normalizeVersion, resolveModelBadge, fastBrainLabel } from './modelBadge'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

// --- providerLabel -----------------------------------------------------------
check('providerLabel maps known keys (case-insensitive)', () => {
  assert.equal(providerLabel('claude'), 'Claude')
  assert.equal(providerLabel('Claude'), 'Claude')
  assert.equal(providerLabel('anthropic'), 'Claude')
  assert.equal(providerLabel('fireworks'), 'Fireworks')
  assert.equal(providerLabel('openrouter'), 'OpenRouter')
  assert.equal(providerLabel('z.ai'), 'z.ai GLM')
})
check('providerLabel returns raw value for unknown-but-present signal', () => {
  // Faithful to the data — surface what the server said, never a fabricated name.
  assert.equal(providerLabel('some-new-vendor'), 'some-new-vendor')
  assert.equal(providerLabel('  TrimMe  '), 'TrimMe')
})
check('providerLabel returns null for absent/blank/non-string', () => {
  assert.equal(providerLabel(''), null)
  assert.equal(providerLabel('   '), null)
  assert.equal(providerLabel(null), null)
  assert.equal(providerLabel(undefined), null)
  assert.equal(providerLabel(42), null)
})

// --- normalizeVersion --------------------------------------------------------
check('normalizeVersion trims and strips a leading v', () => {
  assert.equal(normalizeVersion('0.9.275'), '0.9.275')
  assert.equal(normalizeVersion('v0.9.275'), '0.9.275')
  assert.equal(normalizeVersion('  V1.2.3 '), '1.2.3')
})
check('normalizeVersion returns null for blank/non-string', () => {
  assert.equal(normalizeVersion(''), null)
  assert.equal(normalizeVersion('  '), null)
  assert.equal(normalizeVersion(undefined), null)
  assert.equal(normalizeVersion(123), null)
})

// --- resolveModelBadge -------------------------------------------------------
check('resolveModelBadge: known provider + version', () => {
  const b = resolveModelBadge({ mainProvider: 'claude', version: '0.9.275', connected: true })
  assert.equal(b.known, true)
  assert.equal(b.label, 'Claude')
  assert.equal(b.version, '0.9.275')
  assert.match(b.title, /Claude/)
  assert.match(b.title, /Osborn 0\.9\.275/)
  assert.match(b.title, /fast brain/)
})
check('resolveModelBadge: known provider, no version yet', () => {
  const b = resolveModelBadge({ mainProvider: 'claude', connected: true })
  assert.equal(b.known, true)
  assert.equal(b.label, 'Claude')
  assert.equal(b.version, null)
  assert.doesNotMatch(b.title, /Osborn/)
})
check('resolveModelBadge: neutral when no provider (connected)', () => {
  const b = resolveModelBadge({ connected: true })
  assert.equal(b.known, false)
  assert.equal(b.label, null)
  assert.match(b.title, /has not reported/)
})
check('resolveModelBadge: neutral when not connected', () => {
  const b = resolveModelBadge({ connected: false })
  assert.equal(b.known, false)
  assert.equal(b.label, null)
  assert.match(b.title, /Connecting/)
})
check('resolveModelBadge: version shows in neutral state too', () => {
  // /health can report a version before agent_ready declares the provider.
  const b = resolveModelBadge({ version: 'v0.9.275', connected: true })
  assert.equal(b.known, false)
  assert.equal(b.version, '0.9.275')
})

// --- fastBrainLabel ----------------------------------------------------------
check('fastBrainLabel: generic from agentRole (today — no provider on wire)', () => {
  assert.equal(fastBrainLabel({ agentRole: 'pipeline-fast-brain' }), '⚡ Fast brain')
})
check('fastBrainLabel: uses provider once the agent emits it (follow-up)', () => {
  assert.equal(fastBrainLabel({ provider: 'fireworks', agentRole: 'pipeline-fast-brain' }), '⚡ Fireworks')
  assert.equal(fastBrainLabel({ provider: 'z.ai' }), '⚡ z.ai GLM')
})
check('fastBrainLabel: falls back to Quick take with no identifying signal', () => {
  assert.equal(fastBrainLabel({}), '⚡ Quick take')
  assert.equal(fastBrainLabel({ agentRole: 'direct' }), '⚡ Quick take')
})

console.log(`\n${passed} test blocks passed`)
