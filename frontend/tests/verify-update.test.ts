// Run:  cd frontend && npx tsx tests/verify-update.test.ts
import assert from 'node:assert/strict'
import { pollVerifyUpdate } from '../src/lib/verify-update'

function run(responses: any[], target: string | null) {
  let t = 0, i = 0
  return pollVerifyUpdate('s', target, {
    fetchFn: async () => { const d = responses[Math.min(i++, responses.length - 1)]; return { ok: true, json: async () => d } },
    now: () => t,
    sleep: async (ms) => { t += ms },
    pollMs: 10_000,
  }).then((r) => ({ r, t }))
}

async function main() {
  // stale stored error loses to a live running machine on the target
  let o = await run([{ machineState: 'running', installedVersion: '1.2.3', lastUpdate: { status: 'error', targetVersion: '1.2.3', error: 'did not come back healthy' } }], '1.2.3')
  assert.deepEqual(o.r, { success: true, version: '1.2.3' })

  // a real error still shows when the machine is not on the target
  o = await run([{ machineState: 'running', installedVersion: '1.2.2', lastUpdate: { status: 'error', targetVersion: '1.2.3', error: 'boom' } }], '1.2.3')
  assert.deepEqual(o.r, { success: false, error: 'boom' })

  // not running: the stored error stands
  o = await run([{ machineState: 'stopped', installedVersion: '1.2.3', lastUpdate: { status: 'error', targetVersion: '1.2.3', error: 'boom' } }], '1.2.3')
  assert.equal(o.r.success, false)

  // a failed or destroyed machine (status 'error') reports the stored error at once
  o = await run([{ machineState: 'error', installedVersion: null, lastUpdate: { status: 'error', targetVersion: '1.2.3', error: 'boom' } }], '1.2.3')
  assert.deepEqual(o.r, { success: false, error: 'boom' })
  assert.equal(o.t, 0)

  // timeout with no version observed is never success, even with a null target
  o = await run([{ machineState: 'started', installedVersion: null, lastUpdate: null }], null)
  assert.equal(o.r.success, false)

  // null target, update stuck in progress: an observed (old) version is not success
  o = await run([{ machineState: 'running', installedVersion: '1.2.2', lastUpdate: { status: 'in-progress', targetVersion: null } }], null)
  assert.equal(o.r.success, false)

  // stored error while the machine is still coming up does not win; later poll converges
  o = await run([
    { machineState: 'starting', installedVersion: null, lastUpdate: { status: 'error', targetVersion: '1.2.3', error: 'boom' } },
    { machineState: 'running', installedVersion: '1.2.3', lastUpdate: { status: 'error', targetVersion: '1.2.3', error: 'boom' } },
  ], '1.2.3')
  assert.deepEqual(o.r, { success: true, version: '1.2.3' })

  // never converges: the stored error is reported at the deadline
  o = await run([{ machineState: 'starting', installedVersion: null, lastUpdate: { status: 'error', targetVersion: '1.2.3', error: 'boom' } }], '1.2.3')
  assert.deepEqual(o.r, { success: false, error: 'boom' })

  // no in-progress: gives up at 3 min
  o = await run([{ machineState: 'started', installedVersion: null, lastUpdate: null }], '1.2.3')
  assert.equal(o.r.success, false)
  assert.match((o.r as any).error, /after 3 min \(machine=started, installed=unknown\)/)
  assert.ok(o.t >= 180_000 && o.t < 200_000)

  // a stored success for another target is not this update's success
  o = await run([{ machineState: 'running', installedVersion: '1.2.2', lastUpdate: { status: 'success', targetVersion: '1.2.2', installedVersion: '1.2.2' } }], '1.2.3')
  assert.equal(o.r.success, false)

  // no target ("latest"): the stored success stands
  o = await run([{ machineState: 'running', installedVersion: '1.2.4', lastUpdate: { status: 'success', targetVersion: '1.2.4', installedVersion: '1.2.4' } }], null)
  assert.deepEqual(o.r, { success: true, version: '1.2.4' })

  // in-progress keeps polling, then the real failure appears
  const prog = { machineState: 'running', installedVersion: '1.2.2', lastUpdate: { status: 'in-progress', targetVersion: '1.2.3' } }
  o = await run([...Array(30).fill(prog), { ...prog, lastUpdate: { status: 'error', targetVersion: '1.2.3', error: 'real cause' } }], '1.2.3')
  assert.deepEqual(o.r, { success: false, error: 'real cause' })
  assert.ok(o.t > 180_000)

  // in-progress forever: capped at 10 min
  o = await run([prog], '1.2.3')
  assert.match((o.r as any).error, /after 10 min/)
  assert.ok(o.t >= 600_000 && o.t < 620_000)
  console.log('verify-update tests passed')
}
main()
