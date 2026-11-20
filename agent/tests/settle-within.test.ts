// settleWithin: a join can never hang on a session close that never settles.
// Run with `npx tsx agent/tests/settle-within.test.ts`.
import assert from 'node:assert'
import { settleWithin, closeSessionBounded } from '../src/lib/settle-within.js'

const run = async () => {
  let unhandled = 0
  process.on('unhandledRejection', () => { unhandled++ })

  const t0 = Date.now()
  assert.equal(await settleWithin(new Promise(() => {}), 50), false, 'never-settling promise is released')
  assert.ok(Date.now() - t0 < 1000)

  const t1 = Date.now()
  assert.equal(await settleWithin(Promise.resolve(), 5000), true)
  assert.equal(await settleWithin(new Promise((r) => setTimeout(r, 10)), 5000), true)
  assert.ok(Date.now() - t1 < 1000, 'fast promise does not wait for the timer')

  assert.equal(await settleWithin(Promise.reject(new Error('boom')), 50), true, 'rejection is swallowed')
  // a rejection arriving after the timeout must not go unhandled
  const late = new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 80))
  assert.equal(await settleWithin(late, 20), false)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(unhandled, 0, 'no unhandled rejection')
  const t2 = Date.now()
  await closeSessionBounded({ close: () => new Promise(() => {}) }, { closeMs: 50 })
  assert.ok(Date.now() - t2 < 1000, 'a close that never settles is released after the bound')
  console.log('settle-within: ok')
}
run().catch((e) => { console.error(e); process.exit(1) })
