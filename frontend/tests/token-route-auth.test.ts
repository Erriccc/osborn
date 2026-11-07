// Run: cd frontend && npx --yes tsx tests/token-route-auth.test.ts
// Spec (UI review item 22): /api/token requires a signed-in user and only mints
// for a room on that user's machine. unauth -> 401; wrong-owner room -> 404;
// owner -> token; sandbox id claimed by another user -> 404; malformed -> 400.
import Module from 'node:module'

const results: [string, boolean, string?][] = []
async function t(name: string, fn: () => any) {
  try { await fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }

type St = { user: any; instance: any; claims: { user_id: string }[] }
const st: St = { user: null, instance: null, claims: [] }

const USER_A = 'd4f24f46-1111-4222-8333-444455556666'
const OWNED = 'osborn-d4f24f46-v2'

async function main() {
  process.env.LIVEKIT_API_KEY = 'test-key'
  process.env.LIVEKIT_API_SECRET = 'test-secret-test-secret-test-secret-1234'
  process.env.LIVEKIT_URL = 'wss://example.livekit.cloud'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  delete process.env.OSBORN_DEV_ALLOW_ANY_ROOM

  const chain = (data: () => any) => {
    const b: any = {
      select: () => b, eq: () => b,
      maybeSingle: async () => ({ data: data(), error: null }),
      single: async () => ({ data: data(), error: null }),
      then: (res: any) => res({ data: data(), error: null }),
    }
    return b
  }
  const mocks: Record<string, any> = {
    'next/server': { NextResponse: { json: (body: any, init?: any) => ({ body, status: init?.status ?? 200 }) } },
    '@/lib/supabase-server': {
      createSupabaseServer: async () => ({
        auth: { getUser: async () => ({ data: { user: st.user } }) },
        from: () => chain(() => st.instance),
      }),
    },
    '@supabase/supabase-js': {
      createClient: () => ({ from: () => chain(() => st.claims) }),
    },
  }
  const M: any = Module
  const orig = M._load
  M._load = function (req: string, ...rest: any[]) { return req in mocks ? mocks[req] : orig.call(this, req, ...rest) }
  // room-ownership is imported via the @/ alias — serve the real module.
  mocks['@/lib/room-ownership'] = await import('../src/lib/room-ownership')
  const route: any = await import('../src/app/api/token/route')
  const get = (qs: string) => route.GET({ nextUrl: new URL(`http://x/api/token?${qs}`) })

  await t('unauthenticated request -> 401, no token', async () => {
    st.user = null
    const r = await get(`roomCode=d4f24f46-v2-mabc123`)
    ok(r.status === 401, `status ${r.status}`)
    ok(!r.body.token, 'token returned')
  })
  await t('unauthenticated request without roomCode -> 401', async () => {
    st.user = null
    const r = await get('provider=openai')
    ok(r.status === 401, `status ${r.status}`)
  })
  await t('owner + own room -> 200 with token for that room', async () => {
    st.user = { id: USER_A }; st.instance = { sandbox_id: OWNED }; st.claims = [{ user_id: USER_A }]
    const r = await get(`roomCode=d4f24f46-v2-mabc123&sessionId=s1`)
    ok(r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`)
    ok(typeof r.body.token === 'string' && r.body.token.length > 20, 'no token')
    ok(r.body.roomName === 'osborn-d4f24f46-v2-mabc123', `roomName ${r.body.roomName}`)
    const payload = JSON.parse(Buffer.from(r.body.token.split('.')[1], 'base64url').toString())
    ok(payload.video?.room === 'osborn-d4f24f46-v2-mabc123', 'grant room mismatch')
    ok(JSON.parse(payload.metadata).userId === USER_A, 'userId missing from metadata')
  })
  await t('authenticated, another user\'s room -> 404', async () => {
    st.user = { id: USER_A }; st.instance = { sandbox_id: OWNED }; st.claims = [{ user_id: USER_A }]
    const r = await get(`roomCode=1b9d70e5-v2-mabc123`)
    ok(r.status === 404, `status ${r.status}`)
    ok(!r.body.token, 'token returned')
  })
  await t('prefix collision (osborn-d4f24f46-v2-n-<ts>) is not the owner of osborn-d4f24f46-v2 -> 404', async () => {
    st.user = { id: USER_A }; st.instance = { sandbox_id: OWNED }; st.claims = [{ user_id: USER_A }]
    const r = await get(`roomCode=d4f24f46-v2-n-mabc123`)
    ok(r.status === 404, `status ${r.status}`)
  })
  await t('no instances row and room not on the user-derived app -> 404', async () => {
    st.user = { id: USER_A }; st.instance = null
    const r = await get(`roomCode=d4f24f46-v2-mabc123`)
    ok(r.status === 404, `status ${r.status}`)
  })
  await t('legacy user (no sandbox_id) + room on deterministic app osborn-<uid12> -> 200', async () => {
    // uid12 = first 12 chars of the user id = 'd4f24f46-111' (machines.ts
    // appNameFromUserId), so the legacy agent's rooms are osborn-d4f24f46-111-<ts>.
    st.user = { id: USER_A }; st.instance = null
    const r = await get(`roomCode=d4f24f46-111-mabc123`)
    ok(r.status === 200, `status ${r.status}`)
  })
  await t('sandbox_id copied into own row but claimed by another user -> 404', async () => {
    st.user = { id: USER_A }; st.instance = { sandbox_id: OWNED }
    st.claims = [{ user_id: USER_A }, { user_id: 'victim-user' }]
    const r = await get(`roomCode=d4f24f46-v2-mabc123`)
    ok(r.status === 404, `status ${r.status}`)
  })
  await t('malformed roomCode -> 400', async () => {
    st.user = { id: USER_A }; st.instance = { sandbox_id: OWNED }; st.claims = [{ user_id: USER_A }]
    const r = await get(`roomCode=${encodeURIComponent('../Evil Room')}`)
    ok(r.status === 400, `status ${r.status}`)
  })
  await t('authenticated, no roomCode -> fresh random room with no "-" (cannot hit an agent room)', async () => {
    st.user = { id: USER_A }
    const r = await get('provider=openai')
    ok(r.status === 200, `status ${r.status}`)
    ok(/^[a-z0-9]{6}$/.test(r.body.roomCode), `roomCode ${r.body.roomCode}`)
  })

  M._load = orig

  let fail = 0
  for (const [n, p, m] of results) { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? '\n      ' + m : ''}`); if (!p) fail++ }
  console.log(`\n${results.length - fail}/${results.length} passed`)
  process.exit(fail ? 1 : 0)
}
main()
