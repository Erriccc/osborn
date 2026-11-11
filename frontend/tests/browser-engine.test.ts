// Run: cd frontend && npx --yes tsx tests/browser-engine.test.ts
// Spec (issue #51): the engine proxy only targets allowlisted endpoints (so the
// panel can't reach dangerous ones like `eval`), builds control/stream URLs
// correctly, and appends the stream key without leaking it into control URLs.
process.env.BROWSER_ENGINE_CONTROL_URL = 'https://eng.example:8781'
process.env.BROWSER_ENGINE_STREAM_URL = 'https://eng.example'
process.env.OSBORN_STREAM_TOKEN = 'streamsecret'

import {
  buildControlTarget,
  buildStreamTarget,
  engineTokenConfigured,
  engineControlReachable,
  engineMachineState,
  GET_ALLOW,
  POST_ALLOW,
} from '../src/lib/browser-engine'

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 300)]) }
}
async function at(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 300)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(a === b, `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

// Swap global.fetch for a URL-routed mock for the duration of one async test.
type FetchLike = (url: any, init?: any) => Promise<any>
async function withFetch(mock: FetchLike, fn: () => Promise<void>) {
  const saved = global.fetch
  ;(global as any).fetch = mock
  try { await fn() } finally { (global as any).fetch = saved }
}
const isMgmt = (url: any) => String(url).includes('api.machines.dev')
const isStatus = (url: any) => String(url).includes('eng.example:8781/status')

t('GET allowlist builds the control URL', () => {
  eq(buildControlTarget('GET', 'status'), 'https://eng.example:8781/status', 'status')
  eq(buildControlTarget('GET', 'tasks', '?n=2'), 'https://eng.example:8781/tasks?n=2', 'tasks w/ qs')
})

t('POST allowlist builds the control URL', () => {
  eq(buildControlTarget('POST', 'act'), 'https://eng.example:8781/act', 'act')
  eq(buildControlTarget('POST', 'end'), 'https://eng.example:8781/end', 'end')
})

t('non-allowlisted / wrong-method actions are rejected', () => {
  eq(buildControlTarget('GET', 'eval'), null, 'eval blocked (arbitrary JS)')
  eq(buildControlTarget('GET', 'brain'), null, 'brain blocked')
  eq(buildControlTarget('POST', 'status'), null, 'status is GET-only')
  eq(buildControlTarget('GET', 'act'), null, 'act is POST-only')
  eq(buildControlTarget('GET', '../secret'), null, 'path traversal blocked')
})

t('allowlists exclude the dangerous endpoints', () => {
  for (const bad of ['eval', 'brain', 'journey']) {
    ok(!GET_ALLOW.has(bad) && !POST_ALLOW.has(bad), `${bad} must not be proxyable`)
  }
})

t('stream URL appends the key; control URLs never carry it', () => {
  eq(buildStreamTarget(''), 'https://eng.example/stream?key=streamsecret', 'stream w/ key')
  ok(buildStreamTarget('?t=5').includes('t=5'), 'stream preserves caller qs')
  ok(buildStreamTarget('?t=5').includes('key=streamsecret'), 'stream still has key')
  ok(!String(buildControlTarget('GET', 'status')).includes('streamsecret'), 'control URL has no stream key')
})

t('engineTokenConfigured reflects whether the engine token is set (#63)', () => {
  const saved = process.env.OSBORN_ENGINE_TOKEN
  delete process.env.OSBORN_ENGINE_TOKEN
  eq(engineTokenConfigured(), false, 'unset → false')
  process.env.OSBORN_ENGINE_TOKEN = '   '
  eq(engineTokenConfigured(), false, 'whitespace-only → false')
  process.env.OSBORN_ENGINE_TOKEN = 'enginesecret'
  eq(engineTokenConfigured(), true, 'set → true')
  if (saved === undefined) delete process.env.OSBORN_ENGINE_TOKEN
  else process.env.OSBORN_ENGINE_TOKEN = saved
})

// #115: a HEALTHY engine must NOT read as unreachable just because the Fly
// Machines *management* API can't be read (wrong app name / mis-scoped token /
// outage). engineMachineState() must confirm against the engine's own /status.
async function reachabilityTests() {
  const savedFly = process.env.FLY_API_TOKEN
  process.env.FLY_API_TOKEN = 'flytok' // management read is attempted only with a token

  await at('#115: mgmt-API failure + engine /status up ⇒ reachable (not unreachable)', async () => {
    await withFetch(async (url) => {
      if (isMgmt(url)) return { ok: false, status: 404 } // wrong app/org/token scope
      if (isStatus(url)) return { ok: true, status: 200 } // engine answers directly
      throw new Error(`unexpected url ${url}`)
    }, async () => {
      const s = await engineMachineState()
      eq(s.configured, true, 'configured')
      eq(s.unreachable, false, 'healthy engine must read reachable')
      eq(s.state, 'started', 'demonstrably-up engine reads started')
    })
  })

  await at('#115: mgmt-API failure + engine /status down ⇒ genuinely unreachable', async () => {
    await withFetch(async (url) => {
      if (isMgmt(url)) return { ok: false, status: 404 }
      if (isStatus(url)) throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } })
      throw new Error(`unexpected url ${url}`)
    }, async () => {
      const s = await engineMachineState()
      eq(s.unreachable, true, 'genuine-down engine stays flagged unreachable')
      eq(s.state, null, 'no state when the engine is down')
    })
  })

  await at('#115: healthy mgmt read ⇒ state used verbatim, no engine wake', async () => {
    let statusProbed = false
    await withFetch(async (url) => {
      if (isMgmt(url)) return { ok: true, status: 200, json: async () => [{ id: 'm1', state: 'stopped' }] }
      if (isStatus(url)) { statusProbed = true; return { ok: true, status: 200 } }
      throw new Error(`unexpected url ${url}`)
    }, async () => {
      const s = await engineMachineState()
      eq(s.state, 'stopped', 'management state reported as-is')
      eq(s.unreachable, false, 'readable state is never unreachable')
      eq(statusProbed, false, 'no-wake: a readable stopped machine is NOT probed')
    })
  })

  await at('engineControlReachable: any HTTP reply (even 401) ⇒ reachable', async () => {
    await withFetch(async () => ({ ok: false, status: 401 }), async () => {
      eq(await engineControlReachable(), true, '401 proves the engine is up')
    })
    await withFetch(async () => { throw new Error('ECONNREFUSED') }, async () => {
      eq(await engineControlReachable(), false, 'a thrown fetch means down')
    })
  })

  if (savedFly === undefined) delete process.env.FLY_API_TOKEN
  else process.env.FLY_API_TOKEN = savedFly
}

async function main() {
  await reachabilityTests()
  let failed = 0
  for (const [name, pass, err] of results) {
    console.log(`${pass ? '✅' : '❌'} ${name}${err ? ` — ${err}` : ''}`)
    if (!pass) failed++
  }
  console.log(`\n${results.length - failed}/${results.length} passed`)
  if (failed) process.exit(1)
}
main()
