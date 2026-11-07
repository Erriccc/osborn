// Run: cd frontend && npx --yes tsx tests/cost-guard.test.ts
// Spec (cost guard for warm pool + auto-provision; all Fly/Supabase calls mocked):
//  - A pool spare whose provisioning fails AFTER createSandboxRaw ran (error
//    status, or machine_pool insert failure) is best-effort destroyed, never
//    left running unregistered; the original error is still logged.
//  - A failed pool claim (repoint/start error or throw) destroys the claimed
//    machine, still marks its row dead, and returns null (caller falls back).
//  - Cleanup failures never throw out of the pool code.
//  - ensurePool never targets more than WARM_POOL_MAX spares (default 2,
//    0 disables) and stops a pass after the first failed provision.
//  - /api/sandbox create still records a created-but-unhealthy machine
//    (commit 6f2466a guard); if recording FAILS and the id is not claimed by
//    another user, the machine is stopped and the response is an error that
//    keeps the original provider error.
import Module from 'node:module'

const results: [string, boolean, string?][] = []
async function t(name: string, fn: () => any) {
  try { await fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e?.message ?? e).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }

// ───────────── shared call log ─────────────
type Call = { fn: string; args: any[] }
const calls: Call[] = []
const called = (fn: string) => calls.filter(c => c.fn === fn)
const logs: string[] = []

// ───────────── fake machines.ts ─────────────
const fly = {
  createResult: (appName: string, userId: string): any =>
    ({ id: appName, status: 'running', previewUrl: `https://${appName}.fly.dev`, userId, createdAt: '' }),
  repoint: async (appName: string, userId: string): Promise<any> =>
    ({ id: appName, status: 'running', previewUrl: `https://${appName}.fly.dev`, userId, createdAt: '' }),
  deleteThrows: false,
  // Per-call stopMachineCold outcomes: true/false, or 'throw'. Empty = true.
  stopOutcomes: [] as (boolean | 'throw')[],
}
const machinesMock = {
  __esModule: true,
  isMachinesConfigured: () => true,
  createSandboxRaw: async (appName: string, userId: string, ...rest: any[]) => {
    calls.push({ fn: 'createSandboxRaw', args: [appName, userId, ...rest] })
    return fly.createResult(appName, userId)
  },
  stopMachineCold: async (id: string) => {
    calls.push({ fn: 'stopMachineCold', args: [id] })
    const o = fly.stopOutcomes.shift() ?? true
    if (o === 'throw') throw new Error('fly stop exploded')
    return o
  },
  deleteSandbox: async (id: string) => {
    calls.push({ fn: 'deleteSandbox', args: [id] })
    if (fly.deleteThrows) throw new Error('fly delete exploded')
    return true
  },
  stopSandbox: async (id: string) => { calls.push({ fn: 'stopSandbox', args: [id] }); return true },
  repointAndStartSandbox: async (appName: string, userId: string) => {
    calls.push({ fn: 'repointAndStartSandbox', args: [appName, userId] })
    return fly.repoint(appName, userId)
  },
}

// ───────────── fake service-role supabase (machine_pool) ─────────────
const db = {
  spareCount: 0,
  insertError: null as null | { message: string },
  claimRows: [] as { id: string; app_name: string }[],
}
function poolClient() {
  return {
    from(table: string) {
      const st: any = { table, op: 'select', payload: undefined, filters: {} as Record<string, any> }
      const b: any = {
        select: (_c?: any, opts?: any) => { if (st.op !== 'update') { st.op = opts?.head ? 'count' : 'select' } else st.returning = true; return b },
        insert: (p: any) => { st.op = 'insert'; st.payload = p; return b },
        update: (p: any) => { st.op = 'update'; st.payload = p; return b },
        upsert: (p: any) => { st.op = 'upsert'; st.payload = p; return b },
        eq: (k: string, v: any) => { st.filters[k] = v; return b },
        limit: () => b,
        then: (res: any, rej?: any) => {
          calls.push({ fn: `db.${table}.${st.op}`, args: [st.payload, { ...st.filters }] })
          let out: any = { data: null, error: null }
          if (table === 'machine_pool' && st.op === 'count') out = { count: db.spareCount, error: null }
          else if (table === 'machine_pool' && st.op === 'insert') out = { data: null, error: db.insertError }
          else if (table === 'machine_pool' && st.op === 'update' && st.returning) out = { data: db.claimRows, error: null }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return b
    },
  }
}

// ───────────── fake route deps ─────────────
const route = {
  user: { id: 'user-cg-0' } as any,
  assignResult: (userId: string): any => ({ id: `osborn-${userId}`, status: 'running', previewUrl: 'http://new', userId }),
  claimedByOther: false,
  setSandboxOk: true,
  recordedSandboxId: null as string | null,
}
const routeCloudMock = new Proxy({}, {
  get: (_t, k: string) => {
    if (k === '__esModule') return true
    if (k === 'isSpritesConfigured') return () => true
    if (k === 'findUserSandbox') return async () => null
    if (k === 'stopSandbox') return async (id: string) => { calls.push({ fn: 'stopSandbox', args: [id] }); return true }
    if (k === 'deleteSandbox') return async (id: string) => { calls.push({ fn: 'route.deleteSandbox', args: [id] }); return true }
    if (k === 'createSandbox' || k === 'assignFromPoolOrCreate')
      return async (userId: string) => { calls.push({ fn: k, args: [userId] }); return route.assignResult(userId) }
    return async () => true
  },
})
const routeSupabase = () => ({
  auth: { getUser: async () => ({ data: { user: route.user } }) },
  rpc: async (fn: string, args: any) => {
    calls.push({ fn: `rpc.${fn}`, args: [args] })
    if (fn === 'sandbox_claimed_by_other') return { data: route.claimedByOther, error: null }
    if (fn === 'set_instance_sandbox') return { data: route.setSandboxOk, error: null }
    return { data: null, error: null }
  },
  from: () => {
    const b: any = {
      select: () => b, eq: () => b, update: () => b, insert: () => b, upsert: () => b,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: route.recordedSandboxId ? { sandbox_id: route.recordedSandboxId } : null, error: null }),
      then: (res: any) => res({ data: null, error: null }),
    }
    return b
  },
})

const mocks: Record<string, any> = {
  './machines': machinesMock,
  '@supabase/supabase-js': { __esModule: true, createClient: () => poolClient() },
  'next/server': { NextResponse: { json: (body: any, init?: any) => ({ body, status: init?.status ?? 200 }) } },
  '@/lib/supabase-server': { createSupabaseServer: async () => routeSupabase() },
  '@/lib/cloud': routeCloudMock,
}

function reset() {
  calls.length = 0; logs.length = 0
  fly.createResult = (appName, userId) => ({ id: appName, status: 'running', previewUrl: `https://${appName}.fly.dev`, userId, createdAt: '' })
  fly.repoint = async (appName, userId) => ({ id: appName, status: 'running', previewUrl: `https://${appName}.fly.dev`, userId, createdAt: '' })
  fly.deleteThrows = false
  fly.stopOutcomes = []
  db.spareCount = 0; db.insertError = null; db.claimRows = []
  delete process.env.WARM_POOL_MAX
}

async function main() {
  const M: any = Module
  const origLoad = M._load
  M._load = function (req: string, ...rest: any[]) { return req in mocks ? mocks[req] : origLoad.call(this, req, ...rest) }
  const origErr = console.error, origWarn = console.warn, origLog = console.log
  const capture = (...a: any[]) => { logs.push(a.map(String).join(' ')) }
  console.error = capture; console.warn = capture; console.log = capture

  process.env.FLY_API_TOKEN = 'fake-fly'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://fake-supabase'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role'

  const pool: any = await import('../src/lib/machine-pool')

  // ───────── provisionSpare cleanup ─────────
  await t('pool: spare that comes back with error status is destroyed, not registered', async () => {
    reset()
    db.spareCount = 1
    fly.createResult = (appName, userId) => ({ id: appName, status: 'error', userId, createdAt: '', error: 'health wait timed out' })
    await pool.ensurePool(2)
    const created = called('createSandboxRaw')
    ok(created.length === 1, `createSandboxRaw calls: ${created.length}`)
    const app = created[0].args[0]
    ok(called('deleteSandbox').some(c => c.args[0] === app), `orphan ${app} not destroyed (deleteSandbox calls: ${JSON.stringify(called('deleteSandbox'))})`)
    ok(called('db.machine_pool.insert').length === 0, 'registered a failed spare')
    ok(logs.some(l => l.includes('health wait timed out')), 'original provisioning error not logged')
  })

  await t('pool: spare whose machine_pool insert fails is destroyed', async () => {
    reset()
    db.spareCount = 1
    db.insertError = { message: 'insert denied' }
    await pool.ensurePool(2)
    const app = called('createSandboxRaw')[0]?.args[0]
    ok(app, 'no create')
    ok(called('deleteSandbox').some(c => c.args[0] === app), 'unregistered running spare not destroyed')
    ok(logs.some(l => l.includes('insert denied')), 'original insert error not logged')
  })

  await t('pool: cleanup failure never throws out of ensurePool', async () => {
    reset()
    db.spareCount = 1
    fly.deleteThrows = true
    fly.createResult = (appName, userId) => ({ id: appName, status: 'error', userId, createdAt: '', error: 'boom-original' })
    await pool.ensurePool(2) // must not reject
    ok(called('deleteSandbox').length === 1, 'cleanup not attempted')
    ok(logs.some(l => l.includes('boom-original')), 'original error lost when cleanup failed')
  })

  await t('pool: healthy spare is registered and NOT destroyed (no regression)', async () => {
    reset()
    db.spareCount = 1
    await pool.ensurePool(2)
    ok(called('db.machine_pool.insert').length === 1, 'spare not registered')
    ok(called('deleteSandbox').length === 0, 'healthy spare destroyed')
    ok(called('stopMachineCold').length === 1, 'spare not cold-stopped')
  })

  await t('pool: registered spare whose first cold stop fails is retried once and kept', async () => {
    reset()
    db.spareCount = 1
    fly.stopOutcomes = [false, true]
    await pool.ensurePool(2)
    ok(called('stopMachineCold').length === 2, `stop calls: ${called('stopMachineCold').length}`)
    ok(called('deleteSandbox').length === 0, 'spare destroyed although the retry stopped it')
    ok(!called('db.machine_pool.update').some(c => c.args[0]?.status === 'dead'), 'row marked dead although the retry stopped it')
  })

  await t('pool: registered spare that will not stop after retry is destroyed + row marked dead', async () => {
    reset()
    db.spareCount = 0
    fly.stopOutcomes = ['throw', false]
    await pool.ensurePool(2)
    const app = called('createSandboxRaw')[0]?.args[0]
    ok(app, 'no create')
    ok(called('createSandboxRaw').length === 1, `pass continued after failure: ${called('createSandboxRaw').length} creates`)
    ok(called('stopMachineCold').length === 2, `stop calls: ${called('stopMachineCold').length}`)
    ok(called('deleteSandbox').some(c => c.args[0] === app), 'unstoppable spare not destroyed')
    ok(called('db.machine_pool.update').some(c => c.args[0]?.status === 'dead' && c.args[1]?.app_name === app), 'row not marked dead')
  })

  await t('pool: destroyPoolMachine refuses non-pool app names', async () => {
    reset()
    await pool.destroyPoolMachine('osborn-1b9d70e5-v2', 'test')
    await pool.destroyPoolMachine('osborn-pool-xyz', 'test')
    await pool.destroyPoolMachine('osborn-pool-0123456789ab-x', 'test')
    ok(called('deleteSandbox').length === 0, `deleteSandbox called: ${JSON.stringify(called('deleteSandbox'))}`)
    await pool.destroyPoolMachine('osborn-pool-0123456789ab', 'test')
    ok(called('deleteSandbox').length === 1, 'valid pool app not destroyed')
  })

  // ───────── WARM_POOL_MAX cap ─────────
  await t('pool cap: default WARM_POOL_MAX=2 caps an oversized request', async () => {
    reset()
    db.spareCount = 0
    await pool.ensurePool(10)
    ok(called('createSandboxRaw').length === 2, `created ${called('createSandboxRaw').length} spares, expected 2`)
  })

  await t('pool cap: WARM_POOL_MAX=1 limits default ensurePool() to 1', async () => {
    reset()
    process.env.WARM_POOL_MAX = '1'
    await pool.ensurePool()
    ok(called('createSandboxRaw').length === 1, `created ${called('createSandboxRaw').length}`)
  })

  await t('pool cap: WARM_POOL_MAX=0 disables provisioning', async () => {
    reset()
    process.env.WARM_POOL_MAX = '0'
    await pool.ensurePool(5)
    ok(called('createSandboxRaw').length === 0, `created ${called('createSandboxRaw').length}`)
  })

  await t('pool cap: invalid WARM_POOL_MAX falls back to 2', async () => {
    reset()
    process.env.WARM_POOL_MAX = 'lots'
    await pool.ensurePool(9)
    ok(called('createSandboxRaw').length === 2, `created ${called('createSandboxRaw').length}`)
  })

  await t('pool cap: spares already at cap -> nothing created', async () => {
    reset()
    db.spareCount = 2
    await pool.ensurePool(10)
    ok(called('createSandboxRaw').length === 0, `created ${called('createSandboxRaw').length}`)
  })

  await t('pool: a pass stops after the first failed provision (no hammering)', async () => {
    reset()
    db.spareCount = 0
    fly.createResult = (appName, userId) => ({ id: appName, status: 'error', userId, createdAt: '', error: 'quota' })
    await pool.ensurePool(2)
    ok(called('createSandboxRaw').length === 1, `attempted ${called('createSandboxRaw').length} creates after a failure`)
  })

  // ───────── takeSpareFromPool cleanup ─────────
  await t('pool claim: repoint error -> machine destroyed, row marked dead, null', async () => {
    reset()
    db.claimRows = [{ id: 'row-1', app_name: 'osborn-pool-aaaaaaaaaaaa' }]
    fly.repoint = async (appName, userId) => ({ id: appName, status: 'error', userId, createdAt: '', error: 'repoint health failed' })
    const r = await pool.takeSpareFromPool('user-X')
    ok(r === null, 'expected null')
    ok(called('deleteSandbox').some(c => c.args[0] === 'osborn-pool-aaaaaaaaaaaa'), 'failed claim left machine running')
    ok(called('db.machine_pool.update').some(c => c.args[0]?.status === 'dead' && c.args[1]?.id === 'row-1'), 'row not marked dead')
    ok(logs.some(l => l.includes('repoint health failed')), 'original claim error not logged')
  })

  await t('pool claim: repoint throws + destroy throws -> still null, no throw', async () => {
    reset()
    db.claimRows = [{ id: 'row-2', app_name: 'osborn-pool-bbbbbbbbbbbb' }]
    fly.repoint = async () => { throw new Error('fly 500 original') }
    fly.deleteThrows = true
    const r = await pool.takeSpareFromPool('user-Y')
    ok(r === null, 'expected null')
    ok(called('deleteSandbox').length === 1, 'cleanup not attempted')
    ok(called('db.machine_pool.update').some(c => c.args[0]?.status === 'dead'), 'row not marked dead')
    ok(logs.some(l => l.includes('fly 500 original')), 'original error lost')
  })

  await t('pool claim: successful claim is not destroyed (no regression)', async () => {
    reset()
    db.claimRows = [{ id: 'row-3', app_name: 'osborn-pool-cccccccccccc' }]
    const r = await pool.takeSpareFromPool('user-Z')
    ok(r && r.status === 'running', 'claim failed')
    ok(called('deleteSandbox').length === 0, 'healthy claimed machine destroyed')
  })

  // ───────── /api/sandbox create ─────────
  const savedProvider = process.env.CLOUD_PROVIDER
  process.env.CLOUD_PROVIDER = 'machines'
  const sandboxRoute: any = await import('../src/app/api/sandbox/route')
  const post = (body: any) => sandboxRoute.POST(new Request('http://x/api/sandbox', { method: 'POST', body: JSON.stringify(body) }))
  const routeReset = (uid: string) => {
    reset()
    route.user = { id: uid }
    route.claimedByOther = false
    route.setSandboxOk = true
    route.recordedSandboxId = null
    route.assignResult = (userId: string) => ({ id: `osborn-${userId}`, status: 'running', previewUrl: 'http://new', userId })
  }

  await t('route: created-but-unhealthy machine is still recorded (6f2466a guard)', async () => {
    routeReset('user-cg-1')
    route.assignResult = (userId) => ({ id: `osborn-${userId}`, status: 'error', userId, error: 'Agent did not pass health check after creation' })
    const r = await post({ action: 'create' })
    ok(called('rpc.set_instance_sandbox').some(c => c.args[0]?.p_sandbox_id === 'osborn-user-cg-1'), 'unhealthy machine not recorded')
    ok(called('stopSandbox').length === 0, 'recorded machine was stopped')
    ok(r.status === 500, `status ${r.status}`)
  })

  await t('route: record failure (unclaimed id) -> machine stopped, error keeps original', async () => {
    routeReset('user-cg-2')
    route.setSandboxOk = false
    const r = await post({ action: 'create' })
    ok(called('stopSandbox').some(c => c.args[0] === 'osborn-user-cg-2'), 'unrecorded machine left running')
    ok(r.status >= 500, `status ${r.status}`)
    ok(r.body?.id === 'osborn-user-cg-2', 'response lost the machine id')
    ok(typeof r.body?.error === 'string' && r.body.error.length > 0, 'no error in response')
  })

  await t('route: record failure keeps the original provider error text', async () => {
    routeReset('user-cg-3')
    route.setSandboxOk = false
    route.assignResult = (userId) => ({ id: `osborn-${userId}`, status: 'error', userId, error: 'ORIGINAL-provider-error' })
    const r = await post({ action: 'create' })
    ok(String(r.body?.error).includes('ORIGINAL-provider-error'), `original error dropped: ${r.body?.error}`)
  })

  await t('route: record failure on an id claimed by ANOTHER user -> never stopped', async () => {
    routeReset('user-cg-4')
    route.setSandboxOk = false
    route.claimedByOther = true
    await post({ action: 'create' })
    ok(called('stopSandbox').length === 0, 'stopped a machine another user claims')
    ok(called('route.deleteSandbox').length === 0, 'deleted a machine another user claims')
  })

  await t('route: claim RPC fails but row already holds the pool id -> not stopped, 200', async () => {
    routeReset('user-cg-6')
    route.setSandboxOk = false
    route.assignResult = () => ({ id: 'osborn-pool-0123456789ab', status: 'running', previewUrl: 'http://pool', userId: 'user-cg-6' })
    route.recordedSandboxId = 'osborn-pool-0123456789ab'
    const r = await post({ action: 'create' })
    ok(called('stopSandbox').length === 0, 'stopped the recorded pool machine')
    ok(r.status === 200, `status ${r.status}`)
    ok(r.body?.id === 'osborn-pool-0123456789ab' && r.body?.status === 'running', `body ${JSON.stringify(r.body)}`)
  })

  await t('route: claim RPC fails and row holds a DIFFERENT id -> still stopped', async () => {
    routeReset('user-cg-7')
    route.setSandboxOk = false
    route.recordedSandboxId = 'osborn-something-else'
    const r = await post({ action: 'create' })
    ok(called('stopSandbox').some(c => c.args[0] === 'osborn-user-cg-7'), 'unrecorded machine left running')
    ok(r.status >= 500, `status ${r.status}`)
  })

  await t('route: successful create+record is not stopped (no regression)', async () => {
    routeReset('user-cg-5')
    const r = await post({ action: 'create' })
    ok(r.status === 200, `status ${r.status}`)
    ok(called('stopSandbox').length === 0, 'healthy recorded machine stopped')
  })

  if (savedProvider === undefined) delete process.env.CLOUD_PROVIDER; else process.env.CLOUD_PROVIDER = savedProvider
  M._load = origLoad
  console.error = origErr; console.warn = origWarn; console.log = origLog

  let fail = 0
  for (const [n, p, m] of results) { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? '\n      ' + m : ''}`); if (!p) fail++ }
  console.log(`\n${results.length - fail}/${results.length} passed`)
  process.exit(fail ? 1 : 0)
}
main()
