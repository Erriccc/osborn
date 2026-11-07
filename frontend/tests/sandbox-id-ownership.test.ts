// sandbox_id ownership (spec-only TDD).
// Run: cd /workspace/osborn/frontend && npx --yes tsx tests/sandbox-id-ownership.test.ts
import Module from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const results: [string, boolean, string?][] = []
async function t(name: string, fn: () => any) {
  try { await fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }

const USER_A = 'd4f24f46-1111-4222-8333-444455556666'
const MINE = 'osborn-d4f24f46-v2'
const VICTIM = 'osborn-victim-v2'

const st: any = { user: { id: USER_A }, instance: { sandbox_id: MINE }, claims: [{ user_id: USER_A }], claimsError: null as any, upserts: [] as any[], cloudCalls: [] as string[] }

async function main() {
  process.env.LIVEKIT_API_KEY = 'test-key'
  process.env.LIVEKIT_API_SECRET = 'test-secret-test-secret-test-secret-1234'
  process.env.LIVEKIT_URL = 'wss://example.livekit.cloud'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  delete process.env.OSBORN_DEV_ALLOW_ANY_ROOM

  const chain = (data: () => any, error: () => any = () => null, onWrite?: (k: string, v: any) => void) => {
    const b: any = {
      select: () => b, eq: () => b,
      upsert: (v: any) => { onWrite?.('upsert', v); return b },
      update: (v: any) => { onWrite?.('update', v); return b },
      maybeSingle: async () => ({ data: data(), error: error() }),
      single: async () => ({ data: data(), error: error() }),
      then: (res: any) => res({ data: data(), error: error() }),
    }
    return b
  }
  const cloudFn = (n: string, ret?: any) => async (...a: any[]) => { st.cloudCalls.push(n); return ret }
  const mocks: Record<string, any> = {
    'next/server': { NextResponse: { json: (body: any, init?: any) => ({ body, status: init?.status ?? 200 }) } },
    '@/lib/supabase-server': {
      createSupabaseServer: async () => ({
        auth: { getUser: async () => ({ data: { user: st.user } }) },
        from: () => chain(() => st.instance, () => null, (k, v) => st.upserts.push({ k, v })),
      }),
    },
    '@supabase/supabase-js': {
      createClient: () => ({ from: () => chain(() => st.claims, () => st.claimsError) }),
    },
    '@/lib/cloud': new Proxy({ isSpritesConfigured: () => true }, {
      get: (tgt: any, p: string) => p in tgt ? tgt[p] : cloudFn(String(p), { previewUrl: 'https://x', status: 'running', id: MINE }),
    }),
  }
  const M: any = Module
  const orig = M._load
  M._load = function (req: string, ...rest: any[]) { return req in mocks ? mocks[req] : orig.call(this, req, ...rest) }
  mocks['@/lib/room-ownership'] = await import('../src/lib/room-ownership')

  // ---- C1. POST /api/instance ignores/rejects client sandbox_id ----
  const inst: any = await import('../src/app/api/instance/route')
  for (const key of ['sandboxId', 'sandbox_id']) {
    await t(`POST /api/instance: client-supplied ${key} is not written to the row`, async () => {
      st.upserts = []; st.user = { id: USER_A }; st.instance = { user_id: USER_A }
      const req = { json: async () => ({ serverUrl: 'http://localhost:8741', [key]: VICTIM }) }
      const r = await inst.POST(req)
      const rejected = r.status >= 400 && r.status < 500
      const written = st.upserts.some((u: any) => u.v && u.v.sandbox_id === VICTIM)
      ok(rejected || !written, `sandbox_id ${VICTIM} was persisted (status ${r.status})`)
    })
  }

  // ---- C2. /api/sandbox ownership with a duplicate claim ----
  const sbx: any = await import('../src/app/api/sandbox/route')
  for (const action of ['start', 'stop', 'keepalive', 'delete']) {
    await t(`POST /api/sandbox ${action}: own row id also claimed by another user -> rejected (404/403)`, async () => {
      st.user = { id: USER_A }; st.instance = { sandbox_id: MINE }; st.cloudCalls = []
      st.claims = [{ user_id: USER_A }, { user_id: 'victim-user' }]; st.claimsError = null
      const r = await sbx.POST({ json: async () => ({ action, sandboxId: MINE }) })
      ok(r.status === 404 || r.status === 403, `status ${r.status}`)
      ok(!st.cloudCalls.some((c: string) => /^(startSandbox|stopSandbox|deleteSandbox|keepAliveSandbox)$/.test(c)), `mutating cloud call made: ${st.cloudCalls}`)
    })
  }
  await t('POST /api/sandbox start: uniquely-claimed own id still allowed (compat)', async () => {
    st.user = { id: USER_A }; st.instance = { sandbox_id: MINE }; st.cloudCalls = []
    st.claims = [{ user_id: USER_A }]; st.claimsError = null
    const r = await sbx.POST({ json: async () => ({ action: 'start', sandboxId: MINE }) })
    ok(r.status === 200, `status ${r.status}`)
  })
  await t('POST /api/sandbox start: id that is not in own row -> 404', async () => {
    st.instance = { sandbox_id: MINE }; st.claims = [{ user_id: USER_A }]
    const r = await sbx.POST({ json: async () => ({ action: 'start', sandboxId: VICTIM }) })
    ok(r.status === 404, `status ${r.status}`)
  })

  // ---- C3/C4. token route ----
  const token: any = await import('../src/app/api/token/route')
  const get = (qs: string) => token.GET({ nextUrl: new URL(`http://x/api/token?${qs}`) })
  await t('token: duplicate-claim lookup ERROR fails closed -> 404', async () => {
    st.user = { id: USER_A }; st.instance = { sandbox_id: MINE }
    st.claims = null; st.claimsError = { message: 'boom' }
    const r = await get('roomCode=d4f24f46-v2-mabc123')
    ok(r.status === 404, `status ${r.status}`)
    ok(!r.body.token, 'token minted')
  })
  await t('token: missing service key fails closed -> 404', async () => {
    st.user = { id: USER_A }; st.instance = { sandbox_id: MINE }
    st.claims = [{ user_id: USER_A }]; st.claimsError = null
    const k = process.env.SUPABASE_SERVICE_ROLE_KEY
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    try {
      const r = await get('roomCode=d4f24f46-v2-mabc123')
      ok(r.status === 404, `status ${r.status}`)
      ok(!r.body.token, 'token minted')
    } finally { process.env.SUPABASE_SERVICE_ROLE_KEY = k }
  })
  await t('token: legacy owner (no sandbox_id) on osborn-<uid12> still gets 200', async () => {
    st.user = { id: USER_A }; st.instance = null; st.claims = []; st.claimsError = null
    const r = await get('roomCode=d4f24f46-111-mabc123')
    ok(r.status === 200, `status ${r.status}`)
    ok(typeof r.body.token === 'string', 'no token')
  })
  await t('token: legacy owner still 200 when service key is absent (no sandbox_id to dispute)', async () => {
    st.user = { id: USER_A }; st.instance = null; st.claims = []; st.claimsError = null
    const k = process.env.SUPABASE_SERVICE_ROLE_KEY
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    try { const r = await get('roomCode=d4f24f46-111-mabc123'); ok(r.status === 200, `status ${r.status}`) }
    finally { process.env.SUPABASE_SERVICE_ROLE_KEY = k }
  })
  await t('token: uniquely-claimed owner still 200 (compat)', async () => {
    st.user = { id: USER_A }; st.instance = { sandbox_id: MINE }; st.claims = [{ user_id: USER_A }]; st.claimsError = null
    const r = await get('roomCode=d4f24f46-v2-mabc123')
    ok(r.status === 200, `status ${r.status}`)
  })

  M._load = orig

  // ---- D. migration static check ----
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
  const f = readdirSync(dir).find(n => /^012_.*\.sql$/.test(n))
  await t('migration 012_*.sql exists', async () => { ok(f, 'no 012_*.sql in frontend/supabase/migrations') })
  if (f) {
    const sql = readFileSync(join(dir, f), 'utf8')
    await t('012: UNIQUE index on instances.sandbox_id', async () => {
      ok(/create\s+unique\s+index[^;]*\bsandbox_id\b/i.test(sql) || /unique\s*\(\s*sandbox_id\s*\)/i.test(sql), 'no unique index on sandbox_id')
    })
    await t('012: client writes to sandbox_id restricted (revoke / WITH CHECK / SECURITY DEFINER)', async () => {
      const revoke = /revoke\s+(insert|update|all)[^;]*\(\s*sandbox_id\s*\)[^;]*from/i.test(sql) || /revoke[^;]*on\s+(table\s+)?(public\.)?instances[^;]*from\s+(authenticated|anon)/i.test(sql)
      const check = /with\s+check[^;]*sandbox_id/i.test(sql)
      const definer = /security\s+definer/i.test(sql)
      const trigger = /create\s+(or\s+replace\s+)?trigger/i.test(sql) && /sandbox_id/i.test(sql)
      ok(revoke || check || definer || trigger, 'no write restriction on sandbox_id found')
    })
  }

  let failN = 0
  for (const [n, p, m] of results) { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? '\n      ' + m : ''}`); if (!p) failN++ }
  console.log(`\n${results.length - failN}/${results.length} passed`)
  process.exit(failN ? 1 : 0)
}
main()
