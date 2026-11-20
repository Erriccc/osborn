import { ingestLibraryPage } from '../src/content/lens-library.js'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
let pass = 0, fail = 0
const ok = (c: any, n: string) => { c ? pass++ : fail++; console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}`) }
const TOKEN = 'tok_SECRET_abc123XYZ'
const setEnv = () => { process.env.OSBORN_SYNC_TOKEN = TOKEN; process.env.OSBORN_SUPABASE_URL = 'https://example.supabase.co'; delete process.env.OSBORN_CONTENT_INGEST; delete process.env.OSBORN_CONTENT_LENS }
const mk = (md = '# Period 01\n\nGoal: ship it\n') => ({ sessionId: 'sess-1', key: 'k', period: { index: 1, startRowId: 5, endRowId: 9, closedBy: 'compaction' } as any, pagePath: '/tmp/period-01.md', markdown: md, costUsd: 0 })
function stub(impl: (u: string, i: any) => any) { const calls: any[] = []; (globalThis as any).fetch = async (u: any, i: any) => { calls.push({ u: String(u), i }); return impl(String(u), i) }; return calls }
const logs: string[] = []; const log = (m: string) => logs.push(m)
const R = (status: number, b = '') => new Response(b, { status })

setEnv()
let calls = stub(() => R(200, '"11111111-1111-1111-1111-111111111111"'))
let s = await ingestLibraryPage(mk(), { log })
const c = calls[0]; const body = JSON.parse(c.i.body)
ok(calls.length === 1 && c.u === 'https://example.supabase.co/rest/v1/rpc/content_ingest' && c.i.method === 'POST', 'POST to rpc/content_ingest')
ok(c.i.headers.apikey && c.i.headers.Authorization === `Bearer ${c.i.headers.apikey}`, 'apikey + Bearer same anon key')
ok(JSON.parse(Buffer.from(c.i.headers.apikey.split('.')[1], 'base64url').toString()).role === 'anon', 'key role anon')
ok(Object.keys(body).sort().join() === 'p_payload,p_token' && body.p_token === TOKEN, 'body {p_token,p_payload}')
ok(!('status' in body.p_payload) && !('published_at' in body.p_payload) && !/"status"/.test(c.i.body), 'no status in payload')
ok(/^[0-9a-f]{64}$/.test(body.p_payload.content_hash) && s.status === 'ok' && s.contentHash === body.p_payload.content_hash, 'hash + state ok')
await ingestLibraryPage(mk(), { log })
ok(JSON.parse(calls[1].i.body).p_payload.content_hash === body.p_payload.content_hash, 'hash stable')
await ingestLibraryPage(mk('# Period 01\n\nchanged\n'), { log })
ok(JSON.parse(calls[2].i.body).p_payload.content_hash !== body.p_payload.content_hash, 'hash changes with content')

for (const [k, v] of [['OSBORN_CONTENT_INGEST', '0'], ['OSBORN_CONTENT_LENS', '0']]) {
  setEnv(); process.env[k] = v; calls = stub(() => R(200)); s = await ingestLibraryPage(mk(), { log })
  ok(calls.length === 0 && s.status === 'skipped', `${k}=0 disables`)
}
setEnv(); delete process.env.OSBORN_SYNC_TOKEN; calls = stub(() => R(200)); s = await ingestLibraryPage(mk(), { log })
ok(calls.length === 0 && s.status === 'skipped', 'missing token quiet skip')
setEnv(); process.env.OSBORN_SUPABASE_URL = 'not-a-url'; calls = stub(() => R(200)); let threw = false
try { s = await ingestLibraryPage(mk(), { log }) } catch { threw = true }
ok(!threw && calls.length === 0 && s.status === 'skipped', 'bad/missing url quiet skip')

setEnv(); logs.length = 0; stub(() => R(500, '{"code":"XX000","message":"boom ' + TOKEN + '"}')); threw = false
try { s = await ingestLibraryPage(mk(), { log }) } catch { threw = true }
ok(!threw && s.status === 'error', 'HTTP 500 fails open')
ok(!logs.join('\n').includes(TOKEN), 'log has no token (500)')
stub((_u, i) => new Promise((_, rej) => i.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })))))
threw = false; try { s = await ingestLibraryPage(mk(), { log, timeoutMs: 50 }) } catch { threw = true }
ok(!threw && s.status === 'error' && s.reason === 'timeout', 'timeout fails open')
stub(() => { throw new Error('net ' + TOKEN) }); logs.length = 0
s = await ingestLibraryPage(mk(), { log }); ok(s.status === 'error' && !logs.join('').includes(TOKEN), 'network error fails open, no token in log')

calls = stub(() => R(200)); logs.length = 0
s = await ingestLibraryPage(mk('x'.repeat(260 * 1024)), { log })
ok(calls.length === 0 && s.status === 'oversize', '>250KB skipped')
ok(!logs.join('').includes(TOKEN), 'no token in oversize log')

// grep source
const walk = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? (f === 'node_modules' ? [] : walk(p)) : [p] })
const hits = walk(new URL('../src', import.meta.url).pathname).filter(f => /service_role/i.test(readFileSync(f, 'utf8')))
ok(hits.length === 0, 'no service_role refs in agent/src' + (hits.length ? ': ' + hits.join() : ''))
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0)
