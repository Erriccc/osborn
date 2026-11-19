/**
 * Unit tests for the pure journey-store logic (#120).
 *   npx tsx --test lib/journey-store.test.ts
 *
 * Covers the two pieces of pure logic the fix hangs on:
 *  - run-id continuity: a journey survives the run-id change across a restart,
 *    carrying previousRun so old → new is explicit (and a second restart chains).
 *  - the transient-502 retry discriminator: an empty gateway 502 (process died)
 *    is retryable; the engine's structured speak_failed/no_mic is NOT.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildJourneyState,
  continuesRecovered,
  decideRecovery,
  isTransientSayFailure,
  retryDelayMs,
  DEFAULT_RECOVERY_MAX_AGE_MS,
  type JourneyStateFile,
  type PersistedJourney,
} from './journey-store.ts'

const j: PersistedJourney = { name: 'break-the-ui', goal: 'exercise voice', owner: 'tester', startUrl: 'https://www.voice-native.com/chat', startedAt: 1_000 }
const active = (updatedAt: number, run = '2026-11-10T16-26-43'): JourneyStateFile =>
  buildJourneyState(run, 'active', j, 3, 3, updatedAt)

test('decideRecovery: no persisted state → no recovery', () => {
  assert.equal(decideRecovery(null, { now: 10_000, currentRun: 'r2' }).recover, false)
  assert.equal(decideRecovery(undefined, { now: 10_000, currentRun: 'r2' }).recover, false)
})

test('decideRecovery: an already-ended journey is not resurrected', () => {
  const ended = buildJourneyState('r1', 'ended', j, 3, 3, 9_000)
  const d = decideRecovery(ended, { now: 10_000, currentRun: 'r2' })
  assert.equal(d.recover, false)
  assert.match(d.reason, /ended/)
})

test('run-id continuity: an active journey is adopted across a run-id change', () => {
  const state = active(9_000, '2026-11-10T16-26-43')      // old process run id
  const d = decideRecovery(state, { now: 10_000, currentRun: '2026-11-10T16-30-39' })
  assert.equal(d.recover, true)
  assert.equal(d.journey?.name, 'break-the-ui')
  // previousRun links the new run back to the one that died mid-journey.
  assert.equal(d.previousRun, '2026-11-10T16-26-43')
})

test('run-id continuity: re-homing chains a second restart to the latest run', () => {
  // First restart adopts under the new run and RE-SAVES with currentRun.
  const first = decideRecovery(active(9_000, 'runA'), { now: 10_000, currentRun: 'runB' })
  assert.equal(first.previousRun, 'runA')
  const resaved = buildJourneyState('runB', 'active', first.journey!, 3, 3, 11_000)
  assert.equal(resaved.run, 'runB')
  // Second restart recovers from runB (one hop back), not the stale runA.
  const second = decideRecovery(resaved, { now: 12_000, currentRun: 'runC' })
  assert.equal(second.recover, true)
  assert.equal(second.previousRun, 'runB')
})

test('decideRecovery: a journey older than the mission cap is dropped', () => {
  const old = active(0)
  const d = decideRecovery(old, { now: DEFAULT_RECOVERY_MAX_AGE_MS + 1, currentRun: 'r2' })
  assert.equal(d.recover, false)
  assert.match(d.reason, /stale/)
})

test('decideRecovery: within the cap is kept, right at the boundary too', () => {
  assert.equal(decideRecovery(active(0), { now: DEFAULT_RECOVERY_MAX_AGE_MS, currentRun: 'r2' }).recover, true)
})

test('decideRecovery: corrupt (future) timestamp is adopted, not dropped', () => {
  const d = decideRecovery(active(10_000), { now: 1_000, currentRun: 'r2' })
  assert.equal(d.recover, true)
  assert.equal(d.ageMs, 0)
})

test('isTransientSayFailure: empty-body gateway 502 (restart) is retryable', () => {
  assert.equal(isTransientSayFailure(502, ''), true)
  assert.equal(isTransientSayFailure(502, null), true)
  assert.equal(isTransientSayFailure(502, {}), true)
  assert.equal(isTransientSayFailure(503, '   '), true)
  assert.equal(isTransientSayFailure(504, undefined), true)
})

test('isTransientSayFailure: a non-JSON gateway page is retryable', () => {
  assert.equal(isTransientSayFailure(502, '<html>502 Bad Gateway</html>'), true)
})

test('isTransientSayFailure: no HTTP status (socket reset) is retryable', () => {
  assert.equal(isTransientSayFailure(0, ''), true)
  assert.equal(isTransientSayFailure(undefined, null), true)
  assert.equal(isTransientSayFailure(NaN, null), true)
})

test('isTransientSayFailure: the engine structured speak_failed 502 is NOT retried', () => {
  assert.equal(isTransientSayFailure(502, { ok: false, code: 'speak_failed', error: 'could not speak' }), false)
  assert.equal(isTransientSayFailure(502, JSON.stringify({ ok: false, code: 'speak_failed' })), false)
})

test('isTransientSayFailure: no_mic (422) and success (200) are NOT retried', () => {
  assert.equal(isTransientSayFailure(422, { ok: false, code: 'no_mic' }), false)
  assert.equal(isTransientSayFailure(200, { ok: true }), false)
  assert.equal(isTransientSayFailure(400, { error: 'bad' }), false)
})

test('retryDelayMs: bounded exponential backoff', () => {
  assert.equal(retryDelayMs(1), 1000)
  assert.equal(retryDelayMs(2), 2000)
  assert.equal(retryDelayMs(3), 4000)
  assert.equal(retryDelayMs(10), 8000)   // capped
  assert.ok(retryDelayMs(2) >= retryDelayMs(1))
})

test('#171: steps persisted before a restart survive the file round trip and the recovered slice', () => {
  const steps = [{ kind: 'tab', value: 'open https://example.com' }, { kind: 'eval', value: '1+1' }, { kind: 'say', value: 'hello' }]
  const onDisk = JSON.parse(JSON.stringify(buildJourneyState('runA', 'active', { ...j, steps }, 2, 2, 9_000))) as JourneyStateFile
  const d = decideRecovery(onDisk, { now: 10_000, currentRun: 'runB' })
  // The engine's adoption: startStep is the length BEFORE the carried steps are pushed.
  const scenarioSteps: Array<{ kind: string; value: string }> = [{ kind: 'eval', value: 'boot-time step' }]
  const startStep = scenarioSteps.length
  scenarioSteps.push(...(d.journey!.steps ?? []))
  assert.deepEqual(scenarioSteps.slice(startStep), steps)
})

test('#171: a start naming the recovered journey continues it; anything else does not', () => {
  const recovered = { name: 'pr156-retest', recovered: true }
  assert.equal(continuesRecovered(recovered, 'pr156-retest'), true)
  assert.equal(continuesRecovered(recovered, 'another'), false)
  assert.equal(continuesRecovered({ ...recovered, owner: 'alice' }, 'pr156-retest'), false)  // already re-claimed
  assert.equal(continuesRecovered({ name: 'pr156-retest', owner: 'alice' }, 'pr156-retest'), false)  // a live journey
  assert.equal(continuesRecovered(null, 'pr156-retest'), false)
})
