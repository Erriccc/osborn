// Run: cd frontend && npx --yes tsx tests/notes-route.test.ts
// Spec (lane L20, UI item 26): DELETE /api/notes?id= removes only the signed-in
// owner's note; another user's id (or an unknown id) -> 404 and nothing is
// deleted; unauthenticated -> 401. The owner comes from the authed Supabase
// session, never from a client-supplied user id. GET returns attachments.
// The mock DB does NOT simulate RLS, so these tests prove the route's own
// owner filter (RLS is the second layer, covered by 013_notes.sql).
import Module from 'node:module'

const results: [string, boolean, string?][] = []
async function t(name: string, fn: () => any) {
  try { await fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const NOTE_A = '11111111-1111-4111-8111-111111111111'
const NOTE_A2 = '33333333-3333-4333-8333-333333333333'
const NOTE_B = '22222222-2222-4222-8222-222222222222'
const MISSING = '99999999-9999-4999-8999-999999999999'

type Row = { id: string; user_id: string; text: string; attachments: string[]; created_at: string }
const st: { user: { id: string } | null; rows: Row[] } = { user: null, rows: [] }
const seed = () => {
  st.rows = [
    { id: NOTE_A, user_id: A, text: 'alpha', attachments: ['https://x/a.png'], created_at: '2026-11-07T10:00:00Z' },
    { id: NOTE_A2, user_id: A, text: 'alpha two', attachments: [], created_at: '2026-11-07T11:00:00Z' },
    { id: NOTE_B, user_id: B, text: 'bravo', attachments: [], created_at: '2026-11-07T09:00:00Z' },
  ]
}

// Minimal PostgREST-ish builder over st.rows: select/insert/delete + eq/order/limit/single.
function from(table: string) {
  if (table !== 'notes') throw new Error('unexpected table ' + table)
  const filters: [string, any][] = []
  let op: 'select' | 'delete' | 'insert' = 'select'
  let cols = '*'
  let returning = false
  let inserted: Row | null = null
  let lim = Infinity
  const pick = (r: Row) => {
    if (cols === '*') return { ...r }
    const o: any = {}
    for (const c of cols.split(',').map(s => s.trim())) o[c] = (r as any)[c]
    return o
  }
  const run = () => {
    const match = (r: Row) => filters.every(([k, v]) => (r as any)[k] === v)
    if (op === 'delete') {
      const hit = st.rows.filter(match)
      st.rows = st.rows.filter(r => !match(r))
      return { data: returning ? hit.map(pick) : null, error: null }
    }
    if (op === 'insert') return { data: inserted ? pick(inserted) : null, error: null }
    const rows = st.rows.filter(match).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, lim)
    return { data: rows.map(pick), error: null }
  }
  const b: any = {
    select: (c = '*') => { if (op === 'select') cols = c; else { returning = true; cols = c } return b },
    delete: () => { op = 'delete'; return b },
    insert: (row: any) => {
      op = 'insert'
      inserted = { id: crypto.randomUUID(), created_at: new Date().toISOString(), attachments: [], ...row }
      st.rows.push(inserted!)
      return b
    },
    eq: (k: string, v: any) => { filters.push([k, v]); return b },
    order: () => b,
    limit: (n: number) => { lim = n; return b },
    single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error } },
    maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error } },
    then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
  }
  return b
}

const mocks: Record<string, any> = {
  'next/server': { NextResponse: { json: (body: any, init?: any) => ({ body, status: init?.status ?? 200 }) } },
  '@/lib/supabase-server': {
    createSupabaseServer: async () => ({
      auth: { getUser: async () => ({ data: { user: st.user } }) },
      from,
    }),
  },
}

function req(method: string, url: string, body?: any): any {
  const r: any = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) })
  r.nextUrl = new URL(url)
  return r
}

async function main() {
  const M: any = Module
  const orig = M._load
  M._load = function (request: string, ...rest: any[]) { return request in mocks ? mocks[request] : orig.call(this, request, ...rest) }
  const route: any = await import('../src/app/api/notes/route')
  const del = (id: string, extra = '') => route.DELETE(req('DELETE', `http://x/api/notes?id=${id}${extra}`))

  await t('DELETE own note -> 200 and removes exactly that note', async () => {
    seed(); st.user = { id: A }
    const r = await del(NOTE_A)
    ok(r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`)
    ok(!st.rows.some(x => x.id === NOTE_A), 'own note still present')
    ok(st.rows.some(x => x.id === NOTE_A2), "owner's other note was removed")
    ok(st.rows.some(x => x.id === NOTE_B), "another user's note was removed")
    ok(st.rows.length === 2, `rows left ${st.rows.length}`)
  })

  await t("DELETE another user's note -> 404 and nothing deleted", async () => {
    seed(); st.user = { id: A }
    const r = await del(NOTE_B)
    ok(r.status === 404, `status ${r.status}`)
    ok(st.rows.length === 3, `rows left ${st.rows.length}`)
  })

  await t('DELETE ignores a client-supplied user_id (query string)', async () => {
    seed(); st.user = { id: A }
    const r = await del(NOTE_B, `&user_id=${B}`)
    ok(r.status === 404, `status ${r.status}`)
    ok(st.rows.some(x => x.id === NOTE_B), 'B note deleted via spoofed user_id')
  })

  await t('DELETE unknown id -> 404', async () => {
    seed(); st.user = { id: A }
    const r = await del(MISSING)
    ok(r.status === 404, `status ${r.status}`)
    ok(st.rows.length === 3, 'rows changed')
  })

  await t('DELETE unauthenticated -> 401 and nothing deleted', async () => {
    seed(); st.user = null
    const r = await del(NOTE_A)
    ok(r.status === 401, `status ${r.status}`)
    ok(st.rows.length === 3, 'rows changed while unauthenticated')
  })

  await t('DELETE without id -> 400', async () => {
    seed(); st.user = { id: A }
    const r = await route.DELETE(req('DELETE', 'http://x/api/notes'))
    ok(r.status === 400, `status ${r.status}`)
    ok(st.rows.length === 3, 'rows changed')
  })

  await t('DELETE with a non-uuid id -> 400, no query', async () => {
    seed(); st.user = { id: A }
    const r = await del('not-a-uuid')
    ok(r.status === 400, `status ${r.status}`)
    ok(st.rows.length === 3, 'rows changed')
  })

  await t("GET returns only the owner's notes, newest first, with attachments", async () => {
    seed(); st.user = { id: A }
    const r = await route.GET()
    ok(r.status === 200, `status ${r.status}`)
    const notes = r.body.notes as any[]
    ok(notes.length === 2 && notes.every(n => n.id !== NOTE_B), JSON.stringify(notes))
    ok(notes[0].id === NOTE_A2, 'not newest first')
    ok(Array.isArray(notes[1].attachments) && notes[1].attachments[0] === 'https://x/a.png', 'attachments missing from GET')
  })

  await t('GET unauthenticated -> 401', async () => {
    seed(); st.user = null
    const r = await route.GET()
    ok(r.status === 401, `status ${r.status}`)
  })

  await t('POST stores the session user id, not a client-supplied one', async () => {
    seed(); st.user = { id: A }
    const r = await route.POST(req('POST', 'http://x/api/notes', { text: 'hi', user_id: B }))
    ok(r.status === 200, `status ${r.status}`)
    const added = st.rows.find(x => x.text === 'hi')
    ok(added?.user_id === A, `stored user_id ${added?.user_id}`)
  })

  M._load = orig

  let fail = 0
  for (const [n, p, m] of results) { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? '\n      ' + m : ''}`); if (!p) fail++ }
  console.log(`\n${results.length - fail}/${results.length} passed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
