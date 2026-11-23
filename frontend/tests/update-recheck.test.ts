// Run: cd frontend && npx tsx tests/update-recheck.test.ts
// Issue #525: an image update whose start call fails but whose machine comes up
// on the target version reports success; a real failure names Fly's state.
// Drives updateOsborn end to end against a stubbed fetch (no Fly calls).
import assert from 'node:assert'
import { updateOsborn } from '../src/lib/machines'

const results: [string, boolean, string?][] = []
async function t(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push([name, true]) } catch (e) { results.push([name, false, (e as Error).message.slice(0, 400)]) }
}

process.env.FLY_API_TOKEN = 'test-token'
// waitForHealth / waitForReplacementComplete sleep between polls; run them at once.
globalThis.setTimeout = ((fn: () => void) => { queueMicrotask(fn); return 0 }) as unknown as typeof setTimeout

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A machine that settles stopped after the config POST and refuses /start (412). */
function stubFly(health: () => Response | null) {
  const calls: string[] = []
  const machine = {
    id: 'm1', state: 'stopped', created_at: 'x', config: { env: {} },
    events: [{ type: 'launch', status: 'created', timestamp: 1 }, { type: 'exit', status: 'stopped', timestamp: 3 }, { type: 'update', status: 'replaced', timestamp: 2 }],
  }
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url}`)
    if (url.endsWith('/health')) {
      const r = health()
      if (!r) throw new Error('connect refused')
      return r
    }
    if (url.endsWith('/start')) return new Response('machine getting replaced, refusing to start', { status: 412 })
    if (url.includes('/wait?')) return json({ ok: true })
    if (url.endsWith('/machines')) return json([machine])
    return json(method === 'GET' ? machine : { ok: true })
  }) as typeof fetch
  return calls
}

async function main() {
  await t('start call fails but the machine answers on the target version: success', async () => {
    const calls = stubFly(() => json({ version: '0.9.301' }))
    const r = await updateOsborn('app-a', 'user-1', '0.9.301')
    assert.deepStrictEqual(r.success, true, r.log)
    assert.strictEqual(r.version, '0.9.301')
    // Only the update's own Fly writes: exec cleanup, stop, config, start.
    const posts = calls.filter((c) => c.startsWith('POST'))
    assert.strictEqual(posts.length, 4, posts.join('\n'))
  })

  await t('never answers /health: fails and names the state and newest event', async () => {
    stubFly(() => null)
    const r = await updateOsborn('app-b', 'user-1', '0.9.301')
    assert.strictEqual(r.success, false)
    assert.strictEqual(r.log, 'Machine did not come back healthy after image update (state stopped, last event exit/stopped)')
  })

  await t('comes up on an older version: the version check reports it, not "not healthy"', async () => {
    stubFly(() => json({ version: '0.9.298' }))
    const r = await updateOsborn('app-c', 'user-1', '0.9.301')
    assert.strictEqual(r.success, false)
    assert.strictEqual(r.version, '0.9.298')
    assert.match(r.log, /running on v0\.9\.298 but expected v0\.9\.301/)
  })

  let fail = 0
  for (const [n, p, m] of results) { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? '\n      ' + m : ''}`); if (!p) fail++ }
  console.log(`\n${results.length - fail}/${results.length} passed`)
  process.exit(fail ? 1 : 0)
}
main()
