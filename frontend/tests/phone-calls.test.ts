// Phone calls in (#361 slice 1): number format, the LiveKit SIP join event,
// call routing (verified number -> owner's machine -> agent joins the caller's
// room; busy and unknown callers hung up), connectUserAgent, the signed
// LiveKit webhook and the Supabase Send SMS hook.
// Run: cd frontend && npx tsx tests/phone-calls.test.ts
import Module from 'node:module'
import { createHash, createHmac } from 'node:crypto'

const results: [string, boolean, string?][] = []
async function t(name: string, fn: () => any) {
  try { await fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)

const USER = 'd4f24f46-1111-4222-8333-444455556666'
const OTHER = 'aaaaaaaa-1111-4222-8333-444455556666'
const ROOM = 'call-_+15551230000_AbC123'

// ── Shared state the mocks read and record into ──
const st: any = {}
const reset = () => {
  st.rpc = { data: USER, error: null }
  st.rpcArgs = null
  st.instance = { sandbox_id: 'osborn-mine', sync_token: 'tok-123' }
  st.claims = [{ user_id: USER }]
  st.service = true
  st.deleted = [] as string[]
  st.ingresses = [] as any[]
  st.ingressDeleted = [] as string[]
  st.sandbox = { id: 'osborn-mine', previewUrl: 'https://agent.example', status: 'running' }
  st.healthy = true
  st.cloud = [] as string[]
  st.fetches = [] as { url: string; init: any }[]
  st.fetchReply = (_url: string) => ({ status: 200, body: { ok: true, roomName: ROOM } })
  st.findThrows = false
}
reset()

const chain = (data: () => any) => {
  const b: any = {
    select: () => b, eq: () => b,
    single: async () => ({ data: data(), error: null }),
    then: (res: any) => res({ data: data(), error: null }),
  }
  return b
}

const mocks: Record<string, any> = {
  'next/server': { NextResponse: { json: (body: any, init?: any) => ({ body, status: init?.status ?? 200 }) } },
  '@supabase/supabase-js': {
    createClient: () => ({
      rpc: async (fn: string, args: any) => { st.rpcArgs = { fn, args }; return st.rpc },
      from: (table: string) => chain(() => table === 'instances' && st.claimsQuery ? st.claims : st.instance),
    }),
  },
  '@/lib/cloud': {
    findUserSandbox: async (uid: string, id?: string) => {
      st.cloud.push(`find:${uid}:${id}`)
      if (st.findThrows) throw new Error('machine lookup failed')
      return st.sandbox
    },
    startSandbox: async (id: string, uid: string, tok?: string) => { st.cloud.push(`start:${id}:${tok}`); return st.woken ?? { status: 'running' } },
    checkOsbornHealth: async () => { st.cloud.push('health'); return st.healthy },
    restartService: async () => { st.cloud.push('restart') },
    waitForHealth: async () => { st.cloud.push('waitHealth'); return true },
  },
}

async function main() {
  process.env.LIVEKIT_API_KEY = 'test-key'
  process.env.LIVEKIT_API_SECRET = 'test-secret-test-secret-test-secret-1234'
  process.env.LIVEKIT_URL = 'wss://example.livekit.cloud'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'

  // livekit-server-sdk: keep the real WebhookReceiver/AccessToken; stub the network clients.
  const realSdk: any = await import('livekit-server-sdk')
  mocks['livekit-server-sdk'] = {
    ...realSdk,
    RoomServiceClient: class { deleteRoom = async (name: string) => { st.deleted.push(name) } },
    IngressClient: class {
      createIngress = async (input: any, opts: any) => { st.ingresses.push({ input, opts }); return { ingressId: 'IN_1' } }
      deleteIngress = async (id: string) => { st.ingressDeleted.push(id) }
    },
  }
  const M: any = Module
  const orig = M._load
  M._load = function (req: string, ...rest: any[]) { return req in mocks ? mocks[req] : orig.call(this, req, ...rest) }

  // The instances select for the claim check and the routing lookup share a
  // table; claims come back as an array, the instance as a row.
  mocks['@supabase/supabase-js'].createClient = () => ({
    rpc: async (fn: string, args: any) => { st.rpcArgs = { fn, args }; return st.rpc },
    from: () => {
      let cols = ''
      const b: any = {
        select: (c: string) => { cols = c; return b }, eq: () => b,
        single: async () => ({ data: st.instance, error: null }),
        then: (res: any) => res({ data: cols === 'user_id' ? st.claims : st.instance, error: null }),
      }
      return b
    },
  })

  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url)
    st.fetches.push({ url: u, init })
    const r = st.fetchReply(u)
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
  }) as any

  const phone = await import('../src/lib/phone')
  const sw = await import('../src/lib/standard-webhook')
  const { connectUserAgent } = await import('../src/lib/connect-agent')
  const calls = await import('../src/lib/phone-calls')
  const lkRoute: any = await import('../src/app/api/phone/livekit/route')
  const hookRoute: any = await import('../src/app/api/phone/verify-hook/route')
  // Busy-line wait is 12s in production; tests do not sleep it.
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((fn: any, ms?: number, ...a: any[]) => realSetTimeout(fn, Math.min(ms ?? 0, 5), ...a)) as any

  // ── toUsE164 ──
  await t('toUsE164 accepts US formats and refuses the rest', () => {
    eq(phone.toUsE164('(555) 223-4567'), '+15552234567', 'formatted')
    eq(phone.toUsE164('+1 555 223 4567'), '+15552234567', '+1')
    eq(phone.toUsE164('15552234567'), '+15552234567', '11 digits')
    eq(phone.toUsE164('5552234567'), '+15552234567', '10 digits')
    eq(phone.toUsE164('+44 20 7946 0958'), null, 'UK')
    eq(phone.toUsE164('155512'), null, 'short')
    eq(phone.toUsE164('1055522345'), null, 'area code starting 1')
    eq(phone.toUsE164(''), null, 'empty')
    eq(phone.toUsE164(undefined), null, 'undefined')
  })

  // ── phoneCallFromEvent ──
  const sipEvent = (attributes: Record<string, string>, extra: any = {}) => ({
    event: 'participant_joined',
    room: { name: ROOM },
    participant: { identity: 'sip_+15552234567', kind: 3, attributes, ...extra },
  })
  await t('phoneCallFromEvent reads the camelCase sipPhoneNumber (live LiveKit Cloud form)', () => {
    eq(phone.phoneCallFromEvent(sipEvent({ sipPhoneNumber: '+15552234567' })), { roomName: ROOM, identity: 'sip_+15552234567', callerE164: '+15552234567' }, 'camel')
  })
  await t('phoneCallFromEvent reads the documented dotted sip.phoneNumber', () => {
    eq(phone.phoneCallFromEvent(sipEvent({ 'sip.phoneNumber': '+15552234567' }))?.callerE164, '+15552234567', 'dotted')
  })
  await t('phoneCallFromEvent prefers camelCase when both are present', () => {
    eq(phone.phoneCallFromEvent(sipEvent({ sipPhoneNumber: '+15552234567', 'sip.phoneNumber': '+15559998888' }))?.callerE164, '+15552234567', 'both')
  })
  await t('phoneCallFromEvent ignores other events, non-SIP joiners and missing caller ID', () => {
    eq(phone.phoneCallFromEvent({ ...sipEvent({ sipPhoneNumber: '+15552234567' }), event: 'participant_left' }), null, 'left')
    eq(phone.phoneCallFromEvent(sipEvent({ sipPhoneNumber: '+15552234567' }, { kind: 0 })), null, 'standard')
    eq(phone.phoneCallFromEvent(sipEvent({})), null, 'no caller id')
    eq(phone.phoneCallFromEvent(sipEvent({ sipPhoneNumber: 'anonymous' })), null, 'withheld')
    eq(phone.phoneCallFromEvent({ event: 'participant_joined', participant: null }), null, 'no participant')
  })

  await t('phoneCallFromEvent ignores SIP joiners in rooms the dispatch rule did not make', () => {
    const ev = sipEvent({ sipPhoneNumber: '+15552234567' })
    eq(phone.phoneCallFromEvent({ ...ev, room: { name: 'osborn-x-1' } }), null, 'agent room')
    eq(phone.phoneCallFromEvent({ ...ev, room: { name: 'xcall-1' } }), null, 'prefix not at start')
    eq(phone.phoneCallFromEvent({ ...ev, room: null }), null, 'no room')
  })
  await t('phoneCallFromEvent with a shared number: only calls to that number', () => {
    const shared = '+1 (555) 700-0000'
    eq(phone.phoneCallFromEvent(sipEvent({ sipPhoneNumber: '+15552234567', sipTrunkPhoneNumber: '+15557000000' }), shared)?.callerE164, '+15552234567', 'camel trunk')
    eq(phone.phoneCallFromEvent(sipEvent({ sipPhoneNumber: '+15552234567', 'sip.trunkPhoneNumber': '+15557000000' }), shared)?.callerE164, '+15552234567', 'dotted trunk')
    eq(phone.phoneCallFromEvent(sipEvent({ sipPhoneNumber: '+15552234567', sipTrunkPhoneNumber: '+15558880000' }), shared), null, 'other number')
    eq(phone.phoneCallFromEvent(sipEvent({ sipPhoneNumber: '+15552234567' }), shared), null, 'no dialled number')
    eq(phone.phoneCallFromEvent(sipEvent({ sipPhoneNumber: '+15552234567', sipTrunkPhoneNumber: '+15558880000' }), ''), { roomName: ROOM, identity: 'sip_+15552234567', callerE164: '+15552234567' }, 'no shared number configured')
  })
  await t('phoneCallFromEvent with a shared number that does not parse: refuses every call, warns once', () => {
    const warns: string[] = []
    const orig = console.warn
    console.warn = (...a: any[]) => { warns.push(a.join(' ')) }
    try {
      const ev = sipEvent({ sipPhoneNumber: '+15552234567', sipTrunkPhoneNumber: '+15557000000' })
      eq(phone.phoneCallFromEvent(ev, '555-70'), null, 'bad number refuses')
      eq(phone.phoneCallFromEvent(ev, 'not a number'), null, 'still refuses')
      eq(warns.length, 1, 'one warning')
      ok(/NEXT_PUBLIC_OSBORN_PHONE_NUMBER/.test(warns[0]), 'warning names the setting')
      // Unset (or blank) keeps the old behaviour: no check.
      eq(phone.phoneCallFromEvent(ev, '')?.callerE164, '+15552234567', 'unset')
      eq(phone.phoneCallFromEvent(ev, '   ')?.callerE164, '+15552234567', 'blank')
    } finally { console.warn = orig }
  })

  // ── Send SMS hook helpers ──
  await t('smsDelivery: phone change goes to the new number', () => {
    eq(phone.smsDelivery({ user: { phone: '15550000000', phone_change: '15552234567' }, sms: { otp: '123456' } }), { to: '15552234567', otp: '123456' }, 'change')
    eq(phone.smsDelivery({ user: { phone: '+15552234567' }, sms: { otp: '123456' } }), { to: '15552234567', otp: '123456' }, 'plain')
    eq(phone.smsDelivery({ user: { phone: '15552234567' }, sms: {} }), null, 'no otp')
    eq(phone.smsDelivery({ user: {}, sms: { otp: '123456' } }), null, 'no phone')
    eq(phone.smsDelivery({ user: { phone: '15552234567' }, sms: { otp: 'abc' } }), null, 'bad otp')
  })
  await t('whatsappAuthMessage carries the code in body and copy-code button', () => {
    const m: any = phone.whatsappAuthMessage('15552234567', '123456', 'osborn_code')
    eq(m.to, '15552234567', 'to')
    eq(m.template.name, 'osborn_code', 'template')
    eq(m.template.language.code, 'en_US', 'lang')
    eq(m.template.components[0].parameters[0].text, '123456', 'body')
    eq(m.template.components[1].parameters[0].text, '123456', 'button')
  })

  // ── Standard Webhooks ──
  const SECRET_RAW = Buffer.from('super-secret-key-bytes-1234567890')
  const SECRET = `v1,whsec_${SECRET_RAW.toString('base64')}`
  const sign = (id: string, ts: string, body: string, key = SECRET_RAW) => `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`
  const now = Math.floor(Date.now() / 1000)
  await t('verifyStandardWebhook accepts a valid signature and refuses tampering, age and missing secret', () => {
    const body = '{"a":1}'
    const ts = String(now)
    ok(sw.verifyStandardWebhook(body, { id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body) }, SECRET, now), 'valid')
    ok(sw.verifyStandardWebhook(body, { id: 'msg_1', timestamp: ts, signature: `v1,bogus ${sign('msg_1', ts, body)}` }, SECRET, now), 'second of two entries')
    ok(!sw.verifyStandardWebhook('{"a":2}', { id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body) }, SECRET, now), 'tampered body')
    ok(!sw.verifyStandardWebhook(body, { id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body, Buffer.from('other')) }, SECRET, now), 'wrong key')
    ok(!sw.verifyStandardWebhook(body, { id: 'msg_1', timestamp: String(now - 600), signature: sign('msg_1', String(now - 600), body) }, SECRET, now), 'too old')
    ok(!sw.verifyStandardWebhook(body, { id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body) }, undefined, now), 'no secret')
    ok(!sw.verifyStandardWebhook(body, { id: null, timestamp: ts, signature: sign('msg_1', ts, body) }, SECRET, now), 'no id')
  })

  // ── connectUserAgent ──
  await t('connectUserAgent (browser): no body, no auth header, returns the agent room', async () => {
    reset()
    st.fetchReply = () => ({ status: 200, body: { ok: true, roomName: 'osborn-x-1' } })
    const r = await connectUserAgent(USER, 'osborn-mine', async () => 'tok-123')
    eq(r, { ok: true, roomName: 'osborn-x-1', agentUrl: 'https://agent.example' }, 'result')
    const f = st.fetches.find((x: any) => x.url.endsWith('/connect-room'))
    ok(f && f.init.body === undefined, 'browser connect must not send a body')
    ok(!f.init.headers?.Authorization, 'browser connect sends no token')
  })
  await t('connectUserAgent (phone): sends roomName with the sync token', async () => {
    reset()
    const r = await connectUserAgent(USER, 'osborn-mine', async () => 'tok-123', ROOM)
    ok(r.ok, 'ok')
    const f = st.fetches.find((x: any) => x.url.endsWith('/connect-room'))
    eq(JSON.parse(f.init.body), { roomName: ROOM }, 'body')
    eq(f.init.headers.Authorization, 'Bearer tok-123', 'auth')
  })
  await t('connectUserAgent (phone): 409 from the agent is busy, no retry', async () => {
    reset()
    st.fetchReply = () => ({ status: 409, body: { ok: false, error: 'busy' } })
    const r: any = await connectUserAgent(USER, 'osborn-mine', async () => 'tok-123', ROOM)
    eq(r, { ok: false, reason: 'busy', agentUrl: 'https://agent.example' }, 'busy')
    eq(st.fetches.filter((x: any) => x.url.endsWith('/connect-room')).length, 1, 'one attempt')
  })
  await t('connectUserAgent: a 4xx refusal is not retried (phone and browser)', async () => {
    for (const status of [400, 401, 403]) {
      reset(); st.fetchReply = () => ({ status, body: { ok: false } })
      eq(await connectUserAgent(USER, 'osborn-mine', async () => 'tok-123', ROOM), { ok: false, reason: 'unreachable', agentUrl: 'https://agent.example' }, `phone ${status}`)
      eq(st.fetches.filter((x: any) => x.url.endsWith('/connect-room')).length, 1, `phone ${status}: one attempt`)
    }
    reset(); st.fetchReply = () => ({ status: 404, body: {} })
    eq((await connectUserAgent(USER, 'osborn-mine', async () => 'tok-123') as any).reason, 'unreachable', 'browser 404')
    eq(st.fetches.filter((x: any) => x.url.endsWith('/connect-room')).length, 1, 'browser: one attempt')
  })
  await t('connectUserAgent: 5xx, 429 and network errors are still retried', async () => {
    for (const status of [500, 503, 429]) {
      reset(); st.fetchReply = () => ({ status, body: { ok: false } })
      eq((await connectUserAgent(USER, 'osborn-mine', async () => 'tok-123', ROOM) as any).reason, 'unreachable', `${status}`)
      eq(st.fetches.filter((x: any) => x.url.endsWith('/connect-room')).length, 4, `${status}: four attempts`)
    }
    reset()
    let n = 0
    st.fetchReply = (u: string) => {
      if (u.endsWith('/connect-room') && n++ === 0) throw new Error('ECONNRESET')
      return { status: 200, body: { ok: true, roomName: ROOM } }
    }
    ok((await connectUserAgent(USER, 'osborn-mine', async () => 'tok-123', ROOM)).ok, 'connects after a network error')
    eq(n, 2, 'retried once')
  })
  await t('connectUserAgent: no machine, failed wake, wake + unhealthy restart', async () => {
    reset(); st.sandbox = null
    eq((await connectUserAgent(USER, undefined, async () => 'x') as any).reason, 'no-sandbox', 'no sandbox')
    reset(); st.sandbox = { id: 'osborn-mine', previewUrl: 'https://agent.example', status: 'stopped' }; st.woken = { status: 'error' }
    eq((await connectUserAgent(USER, 'osborn-mine', async () => 'tok-9') as any).reason, 'wake-failed', 'wake failed')
    ok(st.cloud.includes('start:osborn-mine:tok-9'), 'woken with the sync token')
    st.woken = undefined
    reset(); st.healthy = false
    ok((await connectUserAgent(USER, 'osborn-mine', async () => 'x')).ok, 'connects after restart')
    ok(st.cloud.includes('restart') && st.cloud.includes('waitHealth'), 'restart on unhealthy')
  })

  // ── routeCall ──
  const call = { roomName: ROOM, callerE164: '+15552234567' }
  await t('routeCall: verified number -> agent joins the caller room', async () => {
    reset()
    eq(await calls.routeCall(call), 'connected', 'outcome')
    eq(st.rpcArgs, { fn: 'user_id_for_phone', args: { p_phone: '+15552234567' } }, 'lookup')
    ok(st.cloud.includes(`find:${USER}:osborn-mine`), 'found the owner machine')
    const f = st.fetches.find((x: any) => x.url === 'https://agent.example/connect-room')
    eq(JSON.parse(f.init.body).roomName, ROOM, 'caller room')
    eq(st.deleted, [], 'no hang-up')
  })
  await t('routeCall: unknown number is hung up and no machine is touched', async () => {
    reset(); st.rpc = { data: null, error: null }
    eq(await calls.routeCall(call), 'rejected', 'outcome')
    eq(st.deleted, [ROOM], 'hung up')
    eq(st.cloud, [], 'no machine touched')
  })
  await t('routeCall: lookup error, no machine, no sync token, disputed machine -> hung up', async () => {
    reset(); st.rpc = { data: null, error: { message: 'boom' } }
    eq(await calls.routeCall(call), 'rejected', 'rpc error')
    reset(); st.instance = { sandbox_id: null, sync_token: 'tok' }
    eq(await calls.routeCall(call), 'rejected', 'no machine')
    reset(); st.instance = { sandbox_id: 'osborn-mine', sync_token: null }
    eq(await calls.routeCall(call), 'rejected', 'no sync token')
    reset(); st.claims = [{ user_id: USER }, { user_id: OTHER }]
    eq(await calls.routeCall(call), 'rejected', 'disputed')
    eq(st.cloud, [], 'disputed machine never touched')
  })
  await t('routeCall: a throw while routing hangs up, then rethrows', async () => {
    reset(); st.findThrows = true
    let thrown: any = null
    try { await calls.routeCall(call) } catch (e) { thrown = e }
    eq(thrown?.message, 'machine lookup failed', 'rethrown')
    eq(st.deleted, [ROOM], 'hung up')
  })
  await t('routeCall: no service role key -> hung up', async () => {
    reset(); delete process.env.SUPABASE_SERVICE_ROLE_KEY
    try { eq(await calls.routeCall(call), 'rejected', 'outcome'); eq(st.deleted, [ROOM], 'hung up') }
    finally { process.env.SUPABASE_SERVICE_ROLE_KEY = 'service' }
  })
  await t('routeCall: browser session live -> busy line from the agent /tts, then hang up', async () => {
    reset(); st.fetchReply = () => ({ status: 409, body: { ok: false, error: 'busy' } })
    eq(await calls.routeCall(call), 'busy', 'outcome')
    eq(st.ingresses.length, 1, 'one ingress')
    ok(st.ingresses[0].opts.url.startsWith('https://agent.example/tts?text='), `ingress url ${st.ingresses[0].opts.url}`)
    eq(st.ingresses[0].opts.roomName, ROOM, 'ingress room')
    eq(st.deleted, [ROOM], 'hung up')
    eq(st.ingressDeleted, ['IN_1'], 'ingress cleaned up')
  })

  // ── /api/phone/livekit ──
  const signedReq = async (body: string, key = process.env.LIVEKIT_API_KEY!, secret = process.env.LIVEKIT_API_SECRET!) => {
    const at = new realSdk.AccessToken(key, secret)
    at.sha256 = createHash('sha256').update(body).digest('base64')
    const jwt = await at.toJwt()
    return new Request('http://x/api/phone/livekit', { method: 'POST', body, headers: { Authorization: jwt, 'Content-Type': 'application/webhook+json' } })
  }
  const joinBody = JSON.stringify({
    event: 'participant_joined', id: 'EV_1', createdAt: String(now),
    room: { sid: 'RM_1', name: ROOM },
    participant: { sid: 'PA_1', identity: 'sip_+15552234567', kind: 'SIP', attributes: { sipPhoneNumber: '+15552234567' } },
  })
  await t('webhook: unsigned or wrongly signed -> 401, nothing routed', async () => {
    reset()
    const r1 = await lkRoute.POST(new Request('http://x', { method: 'POST', body: joinBody }))
    eq(r1.status, 401, 'unsigned')
    const r2 = await lkRoute.POST(await signedReq(joinBody, 'test-key', 'another-secret-another-secret-12345'))
    eq(r2.status, 401, 'wrong secret')
    const signed = await signedReq(joinBody)
    const r3 = await lkRoute.POST(new Request(signed.url, { method: 'POST', headers: signed.headers, body: joinBody.replace('"sipPhoneNumber":"+15552234567"', '"sipPhoneNumber":"+15559990000"') }))
    eq(r3.status, 401, 'body changed after signing')
    eq(st.rpcArgs, null, 'no lookup')
  })
  await t('webhook: signed SIP join -> 200 and the call is routed', async () => {
    reset()
    const r = await lkRoute.POST(await signedReq(joinBody))
    eq(r.status, 200, 'status')
    eq(r.body, { ok: true }, 'body')
    for (let i = 0; i < 50 && !st.fetches.some((x: any) => x.url.endsWith('/connect-room')); i++) await new Promise((res) => realSetTimeout(res, 5))
    eq(st.rpcArgs?.args, { p_phone: '+15552234567' }, 'lookup')
    ok(st.fetches.some((x: any) => x.url === 'https://agent.example/connect-room'), 'agent asked to join')
  })
  await t('webhook: signed non-SIP join is ignored', async () => {
    reset()
    const body = JSON.stringify({ event: 'participant_joined', id: 'EV_2', createdAt: String(now), room: { name: 'osborn-x' }, participant: { identity: 'user-1', kind: 'STANDARD' } })
    const r = await lkRoute.POST(await signedReq(body))
    eq(r.body, { ok: true, ignored: true }, 'ignored')
    await new Promise((res) => realSetTimeout(res, 20))
    eq(st.rpcArgs, null, 'no lookup')
  })

  // ── /api/phone/verify-hook ──
  const hookReq = (body: string, sig?: string) => {
    const ts = String(Math.floor(Date.now() / 1000))
    return new Request('http://x/api/phone/verify-hook', {
      method: 'POST', body,
      headers: { 'webhook-id': 'msg_9', 'webhook-timestamp': ts, 'webhook-signature': sig ?? sign('msg_9', ts, body) },
    })
  }
  const hookBody = JSON.stringify({ user: { id: USER, phone: '', phone_change: '15552234567' }, sms: { otp: '654321' } })
  await t('verify-hook: bad signature -> 401, nothing sent', async () => {
    reset(); process.env.SUPABASE_SEND_SMS_HOOK_SECRET = SECRET
    const r = await hookRoute.POST(hookReq(hookBody, 'v1,nope'))
    eq(r.status, 401, 'status')
    eq(st.fetches.length, 0, 'no send')
  })
  await t('verify-hook: unconfigured Meta -> 503', async () => {
    reset(); process.env.SUPABASE_SEND_SMS_HOOK_SECRET = SECRET
    delete process.env.META_WA_TOKEN
    const r = await hookRoute.POST(hookReq(hookBody))
    eq(r.status, 503, 'status')
    ok(r.body.error?.message, 'hook error shape')
  })
  await t('verify-hook: signed -> WhatsApp auth template to the new number', async () => {
    reset(); process.env.SUPABASE_SEND_SMS_HOOK_SECRET = SECRET
    process.env.META_WA_TOKEN = 'meta-token'; process.env.META_WA_PHONE_ID = '1098'; process.env.META_WA_AUTH_TEMPLATE = 'osborn_code'
    st.fetchReply = () => ({ status: 200, body: { messages: [{ id: 'wamid.1' }] } })
    const r = await hookRoute.POST(hookReq(hookBody))
    eq(r.status, 200, 'status')
    const f = st.fetches[0]
    ok(f.url.endsWith('/1098/messages') && f.url.startsWith('https://graph.facebook.com/'), `url ${f.url}`)
    eq(f.init.headers.Authorization, 'Bearer meta-token', 'auth')
    const sent = JSON.parse(f.init.body)
    eq([sent.to, sent.template.name, sent.template.components[0].parameters[0].text], ['15552234567', 'osborn_code', '654321'], 'message')
  })
  await t('verify-hook: Meta refuses -> 502 hook error', async () => {
    reset(); process.env.SUPABASE_SEND_SMS_HOOK_SECRET = SECRET
    st.fetchReply = () => ({ status: 400, body: { error: { message: 'bad' } } })
    const r = await hookRoute.POST(hookReq(hookBody))
    eq(r.status, 502, 'status')
    eq(r.body.error.message, phone.META_SEND_FAILED, 'generic message, not Meta text')
  })
  await t('verify-hook (#366): a known Meta code becomes a plain message', async () => {
    reset(); process.env.SUPABASE_SEND_SMS_HOOK_SECRET = SECRET
    st.fetchReply = () => ({ status: 400, body: { error: { code: 131026, message: 'Message undeliverable' } } })
    const r = await hookRoute.POST(hookReq(hookBody))
    eq(r.status, 502, 'status')
    ok(/isn't on WhatsApp/.test(r.body.error.message), `message ${r.body.error.message}`)
  })
  await t('verify-hook (#366): Graph version from META_WA_GRAPH_VERSION, v23.0 by default', async () => {
    reset(); process.env.SUPABASE_SEND_SMS_HOOK_SECRET = SECRET
    st.fetchReply = () => ({ status: 200, body: { messages: [{ id: 'wamid.1' }] } })
    delete process.env.META_WA_GRAPH_VERSION
    await hookRoute.POST(hookReq(hookBody))
    ok(st.fetches[0].url.startsWith('https://graph.facebook.com/v23.0/'), `default ${st.fetches[0].url}`)
    reset(); process.env.META_WA_GRAPH_VERSION = 'v25.0'
    await hookRoute.POST(hookReq(hookBody))
    ok(st.fetches[0].url.startsWith('https://graph.facebook.com/v25.0/'), `env ${st.fetches[0].url}`)
    reset(); process.env.META_WA_GRAPH_VERSION = '../x'
    await hookRoute.POST(hookReq(hookBody))
    ok(st.fetches[0].url.startsWith('https://graph.facebook.com/v23.0/'), `malformed ${st.fetches[0].url}`)
    delete process.env.META_WA_GRAPH_VERSION
  })
  await t('verify-hook (#366): logs the returned message id', async () => {
    reset(); process.env.SUPABASE_SEND_SMS_HOOK_SECRET = SECRET
    st.fetchReply = () => ({ status: 200, body: { messages: [{ id: 'wamid.HBgL' }] } })
    const logs: string[] = []
    const orig = console.log
    console.log = (...a: any[]) => { logs.push(a.join(' ')) }
    try { eq((await hookRoute.POST(hookReq(hookBody))).status, 200, 'status') } finally { console.log = orig }
    ok(logs.some((l) => l.includes('wamid.HBgL')), `logged ${logs.join('|')}`)
  })
  await t('verify-hook (#366): Meta request is aborted at about 4s -> 504 with a plain message', async () => {
    reset(); process.env.SUPABASE_SEND_SMS_HOOK_SECRET = SECRET
    const realTimeout = AbortSignal.timeout
    let asked = 0
    // AbortSignal.timeout's own timer is unref'd and would let the test process exit.
    ;(AbortSignal as any).timeout = (ms: number) => {
      asked = ms
      const c = new AbortController()
      realSetTimeout(() => c.abort(new DOMException('The operation timed out.', 'TimeoutError')), 1)
      return c.signal
    }
    const savedFetch = globalThis.fetch
    globalThis.fetch = ((_u: any, init: any) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(init.signal.reason))
    })) as any
    try {
      const r = await hookRoute.POST(hookReq(hookBody))
      eq(r.status, 504, 'status')
      ok(/too long/.test(r.body.error.message), `message ${r.body.error.message}`)
      ok(asked > 0 && asked < 5000, `timeout ${asked}ms must be under the 5s hook limit`)
    } finally { (AbortSignal as any).timeout = realTimeout; globalThis.fetch = savedFetch }
  })

  globalThis.fetch = realFetch
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
