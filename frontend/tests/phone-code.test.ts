// Emailed code on phone calls (#362): the window/try rules, one try at the code
// (counted before the check, single winner under a race), POST /api/phone/code
// (sync-token auth) and routeCall's code step (prompt, retry line, goodbye and
// hang-up after the last try or on expiry, agent takes the call on a match).
// Run: cd frontend && npx tsx tests/phone-code.test.ts
import Module from 'node:module'

const results: [string, boolean, string?][] = []
async function t(name: string, fn: () => any) {
  try { await fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)

const USER = 'd4f24f46-1111-4222-8333-444455556666'
const OTHER = 'aaaaaaaa-1111-4222-8333-444455556666'
const ROOM = 'call-_+15551230000_AbC123'
const TOKEN = 'sync-token-0123456789abcdef'

// ── A small in-memory Supabase: the two tables and the auth calls phone-code.ts uses ──
const st: any = {}
const reset = () => {
  st.db = { phone_call_codes: [] as any[], instances: [{ user_id: USER, sync_token: TOKEN }] }
  st.email = 'owner@example.com'
  st.code = '482913'
  st.sendError = null
  st.sent = [] as any[]
  st.verifies = [] as string[]
  st.signedOut = [] as string[]
  st.deleted = [] as string[]
  st.ingresses = [] as any[]
  st.roomExists = true
  st.onVerify = null as null | (() => void)
}
reset()

function table(name: string) {
  const q: any = { op: 'select', filters: [], selected: false, limit: Infinity }
  const run = () => {
    const rows: any[] = st.db[name]
    const match = rows.filter((r) => q.filters.every((f: any) => f(r)))
    if (q.op === 'insert') {
      if (rows.some((r) => r.room_name === q.value.room_name)) return { data: null, error: { code: '23505', message: 'duplicate key' } }
      rows.push({ attempts: 0, misses: 0, verified_at: null, created_at: new Date().toISOString(), ...q.value })
      return { data: null, error: null }
    }
    if (q.op === 'delete') { st.db[name] = rows.filter((r) => !match.includes(r)); return { data: null, error: null } }
    if (q.op === 'update') {
      match.forEach((r) => Object.assign(r, q.patch))
      return { data: q.selected ? match.map((r) => ({ ...r })) : null, error: null }
    }
    return { data: match.slice(0, q.limit).map((r) => ({ ...r })), error: null }
  }
  const b: any = {
    select: () => { if (q.op !== 'select') q.selected = true; return b },
    insert: (v: any) => { q.op = 'insert'; q.value = v; return b },
    update: (p: any) => { q.op = 'update'; q.patch = p; return b },
    delete: () => { q.op = 'delete'; return b },
    eq: (k: string, v: any) => { q.filters.push((r: any) => r[k] === v); return b },
    is: (k: string, v: any) => { q.filters.push((r: any) => (r[k] ?? null) === v); return b },
    lt: (k: string, v: any) => { q.filters.push((r: any) => r[k] < v); return b },
    limit: (n: number) => { q.limit = n; return b },
    maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error } },
    then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
  }
  return b
}

const admin: any = {
  from: (name: string) => table(name),
  auth: {
    admin: {
      getUserById: async (id: string) => ({ data: { user: id === USER && st.email ? { id, email: st.email } : null }, error: null }),
      signOut: async (jwt: string) => { st.signedOut.push(jwt); return { error: null } },
    },
  },
}
const anon = () => ({
  auth: {
    signInWithOtp: async (args: any) => { st.sent.push(args); return { error: st.sendError } },
    verifyOtp: async (args: any) => {
      st.verifies.push(args.token)
      st.onVerify?.()
      return args.token === st.code && args.email === st.email
        ? { data: { session: { access_token: `jwt-${st.verifies.length}` } }, error: null }
        : { data: { session: null }, error: { message: 'Token has expired or is invalid' } }
    },
  },
})

const mocks: Record<string, any> = {
  'next/server': { NextResponse: { json: (body: any, init?: any) => ({ body, status: init?.status ?? 200 }) } },
  '@supabase/supabase-js': { createClient: () => anon() },
  '@/lib/sandbox-claims': {
    serviceClient: () => admin,
    checkSandboxClaim: async () => 'mine',
  },
  '@/lib/connect-agent': {
    connectUserAgent: async (_u: string, _s: any, _g: any, roomName: string) => ({ ok: true, roomName, agentUrl: 'https://agent.example', callCode: st.callCode }),
  },
}

async function main() {
  process.env.LIVEKIT_API_KEY = 'test-key'
  process.env.LIVEKIT_API_SECRET = 'test-secret-test-secret-test-secret-1234'
  process.env.LIVEKIT_URL = 'wss://example.livekit.cloud'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon'

  const realSdk: any = await import('livekit-server-sdk')
  mocks['livekit-server-sdk'] = {
    ...realSdk,
    RoomServiceClient: class {
      deleteRoom = async (name: string) => { st.deleted.push(name) }
      listRooms = async (names: string[]) => (st.roomExists ? names.map((name) => ({ name })) : [])
    },
    IngressClient: class {
      createIngress = async (_input: any, opts: any) => { st.ingresses.push(opts); return { ingressId: `IN_${st.ingresses.length}` } }
      deleteIngress = async () => {}
    },
  }
  const M: any = Module
  const orig = M._load
  M._load = function (req: string, ...rest: any[]) { return req in mocks ? mocks[req] : orig.call(this, req, ...rest) }

  const code = await import('../src/lib/phone-code')
  const calls = await import('../src/lib/phone-calls')
  const route: any = await import('../src/app/api/phone/code/route')
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((fn: any, ms?: number, ...a: any[]) => realSetTimeout(fn, Math.min(ms ?? 0, 2), ...a)) as any

  const NOW = Date.parse('2026-11-19T12:00:00Z')
  const row = (o: any = {}) => ({ room_name: ROOM, user_id: USER, expires_at: new Date(NOW + 60_000).toISOString(), attempts: 0, misses: 0, verified_at: null, ...o })

  // ── Pure rules ──
  await t('window: 5 minutes, 3 tries', () => {
    eq(code.CALL_CODE_TTL_MS, 300_000, 'ttl')
    eq(code.CALL_CODE_MAX_TRIES, 3, 'tries')
  })
  await t('callCodeStatus: open, verified, locked, expired; a missing row is expired', () => {
    eq(code.callCodeStatus(row(), NOW), 'open', 'open')
    eq(code.callCodeStatus(row({ attempts: 2 }), NOW), 'open', 'two tries used')
    eq(code.callCodeStatus(row({ attempts: 3 }), NOW), 'locked', 'three tries used')
    eq(code.callCodeStatus(row({ attempts: 3, verified_at: 'x' }), NOW), 'verified', 'matched on the last try')
    eq(code.callCodeStatus(row({ expires_at: new Date(NOW).toISOString() }), NOW), 'expired', 'at expiry')
    eq(code.callCodeStatus(row({ expires_at: 'garbage' }), NOW), 'expired', 'unreadable expiry')
    eq(code.callCodeStatus(null, NOW), 'expired', 'no row')
  })
  await t('callCodeStatus by misses: a try still being checked does not lock the call', () => {
    eq(code.callCodeStatus(row({ attempts: 3, misses: 2 }), NOW, 'misses'), 'open', 'third try in flight')
    eq(code.callCodeStatus(row({ attempts: 3, misses: 3 }), NOW, 'misses'), 'locked', 'third try wrong')
  })
  await t('callCodeOutcome: a match, a miss with tries left, the last miss', () => {
    eq(code.callCodeOutcome(true, 3), 'ok', 'match on the last try')
    eq(code.callCodeOutcome(false, 1), 'wrong', 'first miss')
    eq(code.callCodeOutcome(false, 2), 'wrong', 'second miss')
    eq(code.callCodeOutcome(false, 3), 'locked', 'third miss')
  })
  await t('refusedTry: only an open window counts a try', () => {
    eq(code.refusedTry('open'), null, 'open')
    eq(code.refusedTry('verified'), 'ok', 'verified')
    eq(code.refusedTry('locked'), 'locked', 'locked')
    eq(code.refusedTry('expired'), 'expired', 'expired')
  })
  await t('callCodeNext: waits, says retry once per new miss, then ends', () => {
    eq(code.callCodeNext(0, row(), NOW), 'wait', 'nothing typed')
    eq(code.callCodeNext(0, row({ attempts: 1 }), NOW), 'wait', 'a try in flight')
    eq(code.callCodeNext(0, row({ attempts: 1, misses: 1 }), NOW), 'retry', 'first miss')
    eq(code.callCodeNext(1, row({ attempts: 1, misses: 1 }), NOW), 'wait', 'already told')
    eq(code.callCodeNext(2, row({ attempts: 3, misses: 3 }), NOW), 'locked', 'last miss')
    eq(code.callCodeNext(0, row({ attempts: 1, verified_at: 'x' }), NOW), 'verified', 'match')
    eq(code.callCodeNext(0, null, NOW), 'expired', 'no row')
  })

  // ── startCallCode ──
  await t('startCallCode opens a 5-minute window and emails the account (no new users)', async () => {
    reset()
    st.db.phone_call_codes.push(row({ room_name: 'call-old', expires_at: new Date(NOW - 2 * 86400_000).toISOString() }))
    eq(await code.startCallCode(admin, USER, ROOM, NOW), 'sent', 'sent')
    eq(st.sent, [{ email: 'owner@example.com', options: { shouldCreateUser: false } }], 'otp email')
    eq(st.db.phone_call_codes.map((r: any) => r.room_name), [ROOM], 'old window swept, new one open')
    eq(st.db.phone_call_codes[0].expires_at, new Date(NOW + 300_000).toISOString(), 'expiry')
    ok(!('code' in st.db.phone_call_codes[0]), 'the row holds no code')
  })
  await t('startCallCode: no email on the account, or the send fails', async () => {
    reset(); st.email = null
    eq(await code.startCallCode(admin, USER, ROOM, NOW), 'no-email', 'no email')
    eq(st.sent.length, 0, 'nothing sent')
    reset(); st.sendError = { message: 'email rate limit exceeded' }
    eq(await code.startCallCode(admin, USER, ROOM, NOW), 'send-failed', 'send failed')
    reset(); st.db.phone_call_codes.push(row())
    eq(await code.startCallCode(admin, USER, ROOM, NOW), 'already-open', 'a second window for the same call')
    eq(st.sent.length, 0, 'no second email')
  })

  // ── checkCallCode ──
  await t('checkCallCode: the right code matches once, and the sign-in it made is revoked', async () => {
    reset(); st.db.phone_call_codes.push(row())
    eq(await code.checkCallCode(admin, USER, ROOM, '482913', NOW), 'ok', 'match')
    const r = st.db.phone_call_codes[0]
    eq([r.attempts, r.misses, !!r.verified_at], [1, 0, true], 'row')
    eq(st.signedOut, ['jwt-1'], 'session revoked')
    eq(await code.checkCallCode(admin, USER, ROOM, '000000', NOW), 'ok', 'already verified: no further check')
    eq(st.verifies.length, 1, 'one verifyOtp')
  })
  await t('checkCallCode: three wrong codes lock the call; a fourth is not checked', async () => {
    reset(); st.db.phone_call_codes.push(row())
    eq(await code.checkCallCode(admin, USER, ROOM, '111111', NOW), 'wrong', '1')
    eq(await code.checkCallCode(admin, USER, ROOM, '222222', NOW), 'wrong', '2')
    eq(await code.checkCallCode(admin, USER, ROOM, '333333', NOW), 'locked', '3')
    eq(await code.checkCallCode(admin, USER, ROOM, '482913', NOW), 'locked', 'right code after the lock')
    eq(st.verifies, ['111111', '222222', '333333'], 'checked three times only')
    eq([st.db.phone_call_codes[0].attempts, st.db.phone_call_codes[0].misses], [3, 3], 'counts')
  })
  await t('checkCallCode: a malformed code uses a try without reaching Supabase', async () => {
    reset(); st.db.phone_call_codes.push(row())
    eq(await code.checkCallCode(admin, USER, ROOM, '12a456', NOW), 'wrong', 'letters')
    eq(await code.checkCallCode(admin, USER, ROOM, '1234567', NOW), 'wrong', 'seven digits')
    eq(st.verifies.length, 0, 'no verifyOtp')
    eq(st.db.phone_call_codes[0].attempts, 2, 'tries used')
  })
  await t('checkCallCode: expired window, unknown room, another account\'s room', async () => {
    reset(); st.db.phone_call_codes.push(row({ expires_at: new Date(NOW - 1).toISOString() }))
    eq(await code.checkCallCode(admin, USER, ROOM, '482913', NOW), 'expired', 'expired')
    eq(await code.checkCallCode(admin, USER, 'call-other', '482913', NOW), 'expired', 'no row')
    reset(); st.db.phone_call_codes.push(row({ user_id: OTHER }))
    eq(await code.checkCallCode(admin, USER, ROOM, '482913', NOW), 'expired', 'other account')
    eq(st.db.phone_call_codes[0].attempts, 0, 'no try counted')
    eq(st.verifies.length, 0, 'never checked')
  })
  await t('checkCallCode: a try that loses the count race is not checked', async () => {
    reset(); st.db.phone_call_codes.push(row({ attempts: 2, misses: 2 }))
    // Another instance takes the last try between the read and the claim.
    const realFrom = admin.from
    let reads = 0
    admin.from = (name: string) => {
      const b = realFrom(name)
      const ms = b.maybeSingle
      b.maybeSingle = async () => { const r = await ms(); if (++reads === 1) st.db.phone_call_codes[0].attempts = 3; return r }
      return b
    }
    try {
      eq(await code.checkCallCode(admin, USER, ROOM, '482913', NOW), 'wrong', 'lost the race')
      eq(st.verifies.length, 0, 'not checked')
    } finally { admin.from = realFrom }
  })

  // ── POST /api/phone/code ──
  const req = (body: any, auth: string | null = `Bearer ${TOKEN}`) => new Request('https://x/api/phone/code', {
    method: 'POST',
    headers: auth ? { authorization: auth, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  await t('route: the machine\'s sync token names the account; the try is checked', async () => {
    reset(); st.db.phone_call_codes.push(row({ expires_at: new Date(Date.now() + 60_000).toISOString() }))
    const r = await route.POST(req({ roomName: ROOM, code: '482913' }))
    eq([r.status, r.body], [200, { result: 'ok' }], 'match')
  })
  await t('route: refuses a missing or unknown token before any try', async () => {
    reset(); st.db.phone_call_codes.push(row({ expires_at: new Date(Date.now() + 60_000).toISOString() }))
    eq((await route.POST(req({ roomName: ROOM, code: '482913' }, null))).status, 401, 'no token')
    eq((await route.POST(req({ roomName: ROOM, code: '482913' }, 'Bearer short'))).status, 401, 'short token')
    eq((await route.POST(req({ roomName: ROOM, code: '482913' }, 'Bearer unknown-token-unknown-token'))).status, 401, 'unknown token')
    eq(st.db.phone_call_codes[0].attempts, 0, 'no try counted')
  })
  await t('route: a token shared by two rows names no one', async () => {
    reset(); st.db.instances.push({ user_id: OTHER, sync_token: TOKEN })
    eq((await route.POST(req({ roomName: ROOM, code: '482913' }))).status, 401, 'ambiguous')
  })
  await t('route: bad bodies are refused', async () => {
    reset()
    eq((await route.POST(req('not json'))).status, 400, 'not json')
    eq((await route.POST(req({ roomName: 'osborn-x', code: '1' }))).status, 400, 'not a call room')
    eq((await route.POST(req({ roomName: ROOM, code: 123456 }))).status, 400, 'code not a string')
    eq((await route.POST(req('x'.repeat(2000)))).status, 413, 'too large')
  })
  await t('route: another account\'s call is never checked', async () => {
    reset(); st.db.phone_call_codes.push(row({ user_id: OTHER, expires_at: new Date(Date.now() + 60_000).toISOString() }))
    const r = await route.POST(req({ roomName: ROOM, code: '482913' }))
    eq(r.body, { result: 'expired' }, 'refused')
    eq(st.verifies.length, 0, 'not checked')
  })

  // ── routeCall's code step ──
  const lines = () => st.ingresses.map((o: any) => decodeURIComponent(String(o.url).split('text=')[1] ?? ''))
  const call = { roomName: ROOM, callerE164: '+15551230000' }
  const admin2: any = { ...admin, rpc: async () => ({ data: USER, error: null }) }
  admin2.from = (name: string) => name === 'instances'
    ? { select: () => ({ eq: () => ({ single: async () => ({ data: { sandbox_id: 'osborn-mine', sync_token: TOKEN } }) }) }) }
    : table(name)
  mocks['@/lib/sandbox-claims'].serviceClient = () => admin2

  await t('routeCall without callCode: connected, no email (flag off on the agent)', async () => {
    reset(); st.callCode = undefined
    eq(await calls.routeCall(call), 'connected', 'connected')
    eq(st.sent.length, 0, 'no email')
    eq(st.ingresses.length, 0, 'no line')
  })
  await t('routeCall with callCode: prompt, then connected once the agent\'s try matches', async () => {
    reset(); st.callCode = true
    let polls = 0
    const realFrom = admin2.from
    admin2.from = (name: string) => {
      if (name === 'phone_call_codes' && st.db.phone_call_codes.length && ++polls === 3) {
        void code.checkCallCode(admin, USER, ROOM, '482913')
      }
      return realFrom(name)
    }
    try {
      eq(await calls.routeCall(call), 'connected', 'connected')
    } finally { admin2.from = realFrom }
    eq(st.sent.length, 1, 'one email')
    eq(lines(), [code.CODE_PROMPT_LINE], 'prompt only')
    ok(String(st.ingresses[0].url).startsWith('https://agent.example/tts?text='), 'spoken by the agent\'s /tts')
    eq(st.deleted, [], 'not hung up')
  })
  await t('routeCall with callCode: three misses -> retry, retry, goodbye and hang-up', async () => {
    reset(); st.callCode = true
    const tries = ['111111', '222222', '333333']
    const realFrom = admin2.from
    let busy = false
    admin2.from = (name: string) => {
      const r = st.db.phone_call_codes[0]
      if (name === 'phone_call_codes' && r && !busy && tries.length && r.misses === r.attempts) {
        busy = true
        void code.checkCallCode(admin, USER, ROOM, tries.shift()!).finally(() => { busy = false })
      }
      return realFrom(name)
    }
    try {
      eq(await calls.routeCall(call), 'rejected', 'rejected')
    } finally { admin2.from = realFrom }
    eq(lines(), [code.CODE_PROMPT_LINE, code.CODE_RETRY_LINE, code.CODE_RETRY_LINE, code.CODE_LOCKED_LINE], 'lines')
    eq(st.deleted, [ROOM], 'hung up')
  })
  await t('routeCall with callCode: a repeated webhook for the same call sends nothing and hangs up nothing', async () => {
    reset(); st.callCode = true; st.db.phone_call_codes.push(row({ expires_at: new Date(Date.now() + 60_000).toISOString() }))
    eq(await calls.routeCall(call), 'connected', 'left to the first routing')
    eq(st.sent.length, 0, 'no second email')
    eq(lines(), [], 'no line')
    eq(st.deleted, [], 'not hung up')
  })
  await t('routeCall with callCode: the email fails -> a goodbye and hang-up, never connected', async () => {
    reset(); st.callCode = true; st.sendError = { message: 'over_email_send_rate_limit' }
    eq(await calls.routeCall(call), 'rejected', 'rejected')
    eq(lines(), [code.CODE_SEND_FAILED_LINE], 'line')
    eq(st.deleted, [ROOM], 'hung up')
  })
  await t('routeCall with callCode: no code before expiry -> goodbye and hang-up', async () => {
    reset(); st.callCode = true
    const realFrom = admin2.from
    admin2.from = (name: string) => {
      const r = st.db.phone_call_codes[0]
      if (r) r.expires_at = new Date(Date.now() - 1).toISOString()
      return realFrom(name)
    }
    try { eq(await calls.routeCall(call), 'rejected', 'rejected') } finally { admin2.from = realFrom }
    eq(lines(), [code.CODE_PROMPT_LINE, code.CODE_EXPIRED_LINE], 'lines')
    eq(st.deleted, [ROOM], 'hung up')
  })
  await t('routeCall with callCode: the caller hung up -> no goodbye into a gone room', async () => {
    reset(); st.callCode = true; st.roomExists = false
    const realFrom = admin2.from
    admin2.from = (name: string) => {
      const r = st.db.phone_call_codes[0]
      if (r) r.expires_at = new Date(Date.now() - 1).toISOString()
      return realFrom(name)
    }
    try { eq(await calls.routeCall(call), 'rejected', 'rejected') } finally { admin2.from = realFrom }
    eq(lines(), [code.CODE_PROMPT_LINE], 'no goodbye ingress')
  })

  globalThis.setTimeout = realSetTimeout
  let failed = 0
  for (const [name, pass, err] of results) {
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${err ? `\n     ${err}` : ''}`)
    if (!pass) failed++
  }
  console.log(`\n${results.length - failed}/${results.length} passed`)
  if (failed) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
