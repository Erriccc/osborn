// Run: cd frontend && npx tsx tests/update-recheck.test.ts
// Issue #525: a machine not running right after an update is rechecked, not failed.
import assert from 'node:assert'
import { recheckAfterUpdate } from '../src/lib/machines'

function clock() {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

async function main() {
  // Not running, then started on the target version: success.
  {
    const c = clock()
    const states = ['starting', 'starting', 'started']
    let i = 0
    const r = await recheckAfterUpdate('app', 'app', '0.9.301', {
      deps: {
        ...c,
        getMachine: async () => ({ state: states[Math.min(i++, 2)] }) as never,
        readHealth: async () => ({ version: '0.9.301' }),
      },
    })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(i, 3)
  }
  // Never running: fails and names the last state and event.
  {
    const c = clock()
    const r = await recheckAfterUpdate('app', 'app', '0.9.301', {
      timeoutMs: 20_000,
      deps: {
        ...c,
        getMachine: async () => ({ state: 'stopped', events: [{ type: 'exit', status: 'stopped', timestamp: 1 }] }) as never,
        readHealth: async () => ({ version: null }),
      },
    })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.state, 'stopped')
    assert.strictEqual(r.event, 'exit/stopped')
  }
  // Started but on an older version the whole time: fails.
  {
    const c = clock()
    const r = await recheckAfterUpdate('app', 'app', '0.9.301', {
      timeoutMs: 10_000,
      deps: { ...c, getMachine: async () => ({ state: 'started' }) as never, readHealth: async () => ({ version: '0.9.298' }) },
    })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.state, 'started')
  }
  console.log('update-recheck: ok')
}
main()
