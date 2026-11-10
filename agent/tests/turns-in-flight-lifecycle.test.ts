// Lifecycle tests for ClaudeLLM's #turnsInFlight counter — the state that drives
// the deferred auth-restart gate shouldRestartForAuth() (fix for #90).
// Run: npx tsx tests/turns-in-flight-lifecycle.test.ts
//
// WHAT THIS COVERS (and auth-start-adversarial.test.ts does NOT):
//   auth-start-adversarial tests the PURE gate with fixed numbers. It never
//   exercises how the counter REACHES those numbers across a turn's life, so a
//   counter that leaks upward (never returns to 0) still passes there while the
//   gate is permanently wedged in production. This file exercises the COUNTER
//   LIFECYCLE: increment on push, decrement on a terminal `result`, and — the
//   #90 regression — the resets that stop it leaking when a turn ends via an
//   interrupt or a consumer-iterator error WITHOUT a terminal `result`.
//
// LIMITATION (documented): #turnsInFlight is a private field inside ClaudeLLM,
// whose pushMessage()/background consumer spawn a real `claude` CLI subprocess
// through the SDK query(). It cannot be driven in-process without a subprocess.
// So this test has two layers that together are faithful:
//   (1) a TurnCounter that models the EXACT production transitions, driven
//       through the REAL exported gate shouldRestartForAuth(), proving the gate
//       reopens the instant the counter returns to 0 (and stays blocked while a
//       genuine turn streams); and
//   (2) structural assertions against the real claude-llm.ts source proving
//       production performs those same resets at every turn-ending site, so the
//       model in (1) cannot silently drift from the shipped code. If someone
//       deletes a reset, layer (2) fails.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Importing claude-llm.ts runs ensureCompactionSettings() (writes ~/.claude), so
// point HOME/CLAUDE_CONFIG_DIR at a throwaway dir — same guard the auth test uses.
const fakeHome = mkdtempSync(join(tmpdir(), 'osb-tif-'))
process.env.HOME = fakeHome
process.env.CLAUDE_CONFIG_DIR = join(fakeHome, '.claude')

const L = await import('../src/claude-llm.js')
const { shouldRestartForAuth } = L

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('ok   ', name) } catch (e: any) { fail++; console.log('FAIL ', name, '-', e.message) }
}

// ── Layer 1: faithful model of the production counter transitions ────────────
// Each method mirrors exactly one production site (asserted by Layer 2 below):
//   onPush        → pushMessage():            this.#turnsInFlight++
//   onResult      → consumer `result` handler: if (>0) this.#turnsInFlight--
//   onInterrupt   → interruptQuery() success:  this.#turnsInFlight = 0
//   onConsumerExit→ consumer finally (owns fields): this.#turnsInFlight = 0
//   onCloseSession→ closeSession():            this.#turnsInFlight = 0
// STALE_GEN/CUR_GEN are fixed literals (like the adversarial test) so the test
// is independent of the module-global authEnvGeneration other tests mutate.
const STALE_GEN = 0, CUR_GEN = 1
class TurnCounter {
  n = 0
  onPush() { this.n++ }
  onResult() { if (this.n > 0) this.n-- }
  onInterrupt() { this.n = 0 }
  onConsumerExit() { this.n = 0 }
  onCloseSession() { this.n = 0 }
  // The live gate, evaluated against this counter. A stale spawn-gen means a
  // Claude sign-in happened mid-session; interruptPending defaults false (the
  // #pendingInterrupt window has its own gate coverage in the adversarial test).
  gateFires(interruptPending = false) {
    return shouldRestartForAuth(STALE_GEN, CUR_GEN, this.n, interruptPending)
  }
}

// THE #90 REGRESSION: a turn interrupted (barge-in) without a terminal `result`
// must still let a later auth-restart fire. Pre-fix the counter stuck at 1 here.
t('push → interrupt (no terminal result): counter returns to 0, gate can fire', () => {
  const c = new TurnCounter()
  c.onPush()
  assert.equal(c.n, 1)
  assert.equal(c.gateFires(), false, 'mid-turn: a live streaming turn must block the restart')
  c.onInterrupt()                       // barge-in; closeSession NOT called, subprocess alive
  assert.equal(c.n, 0, 'interrupt must reset the counter (subprocess is idle again)')
  assert.equal(c.gateFires(), true, 'after interrupt the deferred auth-restart MUST be able to fire')
})

t('push → consumer-iterator error (no terminal result): finally resets, gate can fire', () => {
  const c = new TurnCounter()
  c.onPush()
  assert.equal(c.n, 1)
  c.onConsumerExit()                    // iterator threw/ended mid-turn; finally owns the fields
  assert.equal(c.n, 0, 'consumer finally must reset the counter (subprocess is gone)')
  assert.equal(c.gateFires(), true)
})

t('interrupt then a LATE result cannot drive the counter negative or re-wedge it', () => {
  const c = new TurnCounter()
  c.onPush()
  c.onInterrupt()                       // → 0
  c.onResult()                          // guarded `if (>0)` → stays 0, never -1
  assert.equal(c.n, 0)
  assert.equal(c.gateFires(), true)
})

t('repeated interrupts never leak the counter upward', () => {
  const c = new TurnCounter()
  for (let i = 0; i < 25; i++) { c.onPush(); c.onInterrupt() }
  assert.equal(c.n, 0)
  assert.equal(c.gateFires(), true)
})

// NEGATIVE CONTROL: the normal authed flow must still block a mid-turn restart.
t('normal turn still blocks a mid-turn restart, then reopens on its terminal result', () => {
  const c = new TurnCounter()
  c.onPush()                            // real in-flight turn streaming
  assert.equal(c.gateFires(), false, 'a genuinely in-flight turn must NOT be restarted mid-stream')
  c.onResult()                          // turn completes normally
  assert.equal(c.n, 0)
  assert.equal(c.gateFires(), true, 'once the turn ends, the stale-gen restart fires on the next push')
})

t('two overlapping turns: gate stays blocked until BOTH settle (counter is a depth)', () => {
  const c = new TurnCounter()
  c.onPush(); c.onPush()                // two pushed turns, no results yet
  assert.equal(c.gateFires(), false)
  c.onResult()
  assert.equal(c.gateFires(), false, 'still one turn in flight')
  c.onResult()
  assert.equal(c.gateFires(), true)
})

t('closeSession resets the counter to idle', () => {
  const c = new TurnCounter()
  c.onPush(); c.onPush()
  c.onCloseSession()
  assert.equal(c.n, 0)
  assert.equal(c.gateFires(), true)
})

// The real gate's contract (re-asserted here so the model above is anchored to
// the shipped pure function, not a private copy).
t('shouldRestartForAuth: fires only when idle (0) + stale gen + no interrupt', () => {
  assert.equal(shouldRestartForAuth(0, 1, 0, false), true)
  assert.equal(shouldRestartForAuth(0, 1, 1, false), false) // in flight → blocked
  assert.equal(shouldRestartForAuth(0, 1, 0, true), false)  // interrupt settling → blocked
  assert.equal(shouldRestartForAuth(1, 1, 0, false), false) // same gen → nothing to do
})

// ── Layer 2: structural proof the production code drives the counter back to 0
// at every turn-ending site, so the Layer-1 model cannot drift from shipped code.
const src = readFileSync(new URL('../src/claude-llm.ts', import.meta.url), 'utf8')

t('[source] #turnsInFlight is incremented in exactly ONE place (pushMessage)', () => {
  const incs = (src.match(/#turnsInFlight\+\+/g) || []).length
  assert.equal(incs, 1, `expected a single increment site, found ${incs}`)
})

t('[source] the result-handler decrement stays clamped at > 0 (no negatives)', () => {
  assert.ok(/if \(this\.#turnsInFlight > 0\) this\.#turnsInFlight--/.test(src),
    'guarded decrement in the consumer `result` handler missing')
})

t('[source] interruptQuery() resets the counter after a successful interrupt', () => {
  const start = src.indexOf('async interruptQuery(')
  assert.ok(start > 0, 'interruptQuery not found')
  const seg = src.slice(start, src.indexOf('return true', start) + 'return true'.length)
  assert.ok(/this\.#turnsInFlight = 0/.test(seg),
    'interrupt path must reset #turnsInFlight (else an interrupted turn leaks it)')
})

t('[source] the consumer finally resets the counter when it still owns the fields', () => {
  const guard = src.indexOf('if (this.#persistentQuery === pq) {')
  assert.ok(guard > 0, 'consumer ownership guard not found')
  const seg = src.slice(guard, guard + 800)
  assert.ok(/this\.#turnsInFlight = 0/.test(seg),
    'consumer finally must reset #turnsInFlight under the ownership guard')
})

t('[source] closeSession() still resets the counter', () => {
  const start = src.indexOf('closeSession(): void {')
  assert.ok(start > 0, 'closeSession not found')
  const seg = src.slice(start, src.indexOf('Persistent session closed', start))
  assert.ok(/this\.#turnsInFlight = 0/.test(seg), 'closeSession reset missing')
})

t('[source] every reset site is accounted for (interrupt + finally + closeSession)', () => {
  const resets = (src.match(/this\.#turnsInFlight = 0/g) || []).length
  assert.equal(resets, 3, `expected 3 \`this.#turnsInFlight = 0\` reset sites, found ${resets}`)
})

t('[source] the gate reads the live counter at the push boundary', () => {
  assert.ok(/shouldRestartForAuth\(this\.#spawnAuthGen, authEnvGeneration, this\.#turnsInFlight, !!this\.#pendingInterrupt\)/.test(src),
    'pushMessage must evaluate shouldRestartForAuth with the live counter')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
