// Run: cd frontend && npx --yes tsx tests/follow-through-route.test.ts
// Spec (#378): POST /api/follow-through files a voice session's open items as GitHub
// issues. Sync-token auth (like /api/phone/code), a per-account repo allowlist, a daily
// per-account cap, only the user's own explicit mic asks go into a public repo (unknown
// visibility counts as public), skip when an open or dismissed (not_planned) issue has the
// key, issues are inert (mentions, links, images and issue refs neutralized, no assignees,
// only follow-through + osborn:proposed/osborn:noted labels), and the bug report mirror
// behaves as before.
import Module from 'node:module'

const results: [string, boolean, string?][] = []
async function t(name: string, fn: () => any) {
  try { await fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }

// Each test runs as a fresh account (the daily cap is per account and in memory): its own
// sync token, and the three test repos allowlisted to it.
const tokens = new Map<string, string>() // sync token → user id
let GOOD_TOKEN = ''
let USER = ''
let accounts = 0
function newAccount(): { token: string; user: string } {
  accounts++
  const user = `user-${String(accounts).padStart(4, '0')}-uuid-abc`
  const token = `sync-token-${String(accounts).padStart(4, '0')}-0123456789abcdef`
  tokens.set(token, user)
  return { token, user }
}
function asNewAccount() {
  const a = newAccount()
  GOOD_TOKEN = a.token
  USER = a.user
  process.env.FOLLOW_THROUGH_REPO_ALLOWLIST = ['acme/public-repo', ' acme/private-repo', 'acme/broken-repo'].map((r) => `${r}=${USER}`).join(',')
}
process.env.GITHUB_TOKEN = 'ghp_test_token_not_real'

// ── Supabase: instances(sync_token → user_id) ──
const mocks: Record<string, any> = {
  'next/server': { NextResponse: { json: (body: any, init?: any) => ({ body, status: init?.status ?? 200 }) } },
  '@/lib/sandbox-claims': {
    serviceClient: () => ({
      from: () => {
        let tok = ''
        const b: any = {
          select: () => b,
          eq: (_k: string, v: string) => { tok = v; return b },
          limit: async () => ({ data: tokens.has(tok) ? [{ user_id: tokens.get(tok) }] : [] }),
        }
        return b
      },
    }),
  },
}

// ── GitHub stub ──
type Issue = { number: number; html_url: string; body: string; state: string; state_reason?: string; labels: string[]; title: string; payload: any }
const row = (i: Issue) => ({ number: i.number, html_url: i.html_url, body: i.body, state: i.state, state_reason: i.state_reason ?? null })
const gh = { issues: new Map<string, Issue[]>(), labelPosts: [] as string[], creates: [] as any[], calls: [] as string[] }
const privacy: Record<string, boolean | 'error'> = { 'acme/public-repo': false, 'acme/private-repo': true, 'acme/broken-repo': 'error' }
const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
;(globalThis as any).fetch = async (url: string, init: any = {}) => {
  const u = new URL(url)
  const method = init.method ?? 'GET'
  gh.calls.push(`${method} ${u.pathname}${u.search}`)
  let m: RegExpMatchArray | null
  if (method === 'GET' && (m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)$/))) {
    const p = privacy[m[1]]
    return p === 'error' || p === undefined ? json({ message: 'nope' }, 500) : json({ private: p })
  }
  if (method === 'GET' && (m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues$/))) {
    return json((gh.issues.get(m[1]) ?? []).map(row))
  }
  if (method === 'GET' && u.pathname === '/search/issues') {
    const q = u.searchParams.get('q') ?? ''
    const repo = q.match(/repo:(\S+)/)![1]
    const tok = q.match(/"([^"]+)"/)![1]
    const openOnly = q.includes('is:open')
    const items = (gh.issues.get(repo) ?? []).filter((i) => i.body.includes(tok) && (!openOnly || i.state === 'open'))
    return json({ items: items.map(row) })
  }
  if (method === 'POST' && (m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/labels$/))) {
    gh.labelPosts.push(`${m[1]}:${JSON.parse(init.body).name}`)
    return json({}, 201)
  }
  if (method === 'POST' && (m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues$/))) {
    const payload = JSON.parse(init.body)
    const list = gh.issues.get(m[1]) ?? []
    const issue: Issue = { number: list.length + 1, html_url: `https://github.com/${m[1]}/issues/${list.length + 1}`, body: payload.body, state: 'open', labels: payload.labels, title: payload.title, payload }
    list.push(issue); gh.issues.set(m[1], list); gh.creates.push({ repo: m[1], ...payload })
    return json({ number: issue.number, html_url: issue.html_url }, 201)
  }
  if (method === 'POST' && u.pathname.endsWith('/comments')) return json({}, 201)
  return json({ message: 'unexpected ' + url }, 404)
}
const reset = () => { gh.issues.clear(); gh.labelPosts = []; gh.creates = []; gh.calls = []; asNewAccount() }

const key = (n: number) => n.toString(16).padStart(12, '0')
const item = (n: number, extra: any = {}) => ({ key: key(n), kind: 'ask', text: `remind me to do thing ${n}`, source: 'explicit', origin: 'user_mic', turn: 3, ...extra })
function req(body: any, token: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new Request('http://x/api/follow-through', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
}

async function main() {
  const M: any = Module
  const orig = M._load
  M._load = function (request: string, ...rest: any[]) { return request in mocks ? mocks[request] : orig.call(this, request, ...rest) }
  const route: any = await import('../src/app/api/follow-through/route')
  const mirror: any = await import('../src/lib/github-issue-mirror')
  const post = (body: any, token: string | null = GOOD_TOKEN) => route.POST(req(body, token))

  await t('401 without or with unknown sync token', async () => {
    reset()
    ok((await post({ repo: 'acme/private-repo', items: [item(1)] }, null)).status === 401, 'no token')
    ok((await post({ repo: 'acme/private-repo', items: [item(1)] }, 'wrong-token-0123456789')).status === 401, 'unknown token')
    ok(gh.calls.length === 0, 'no GitHub call before auth')
  })

  await t('413 oversize body', async () => {
    reset()
    const r = await post({ repo: 'acme/private-repo', items: [item(1, { text: 'x'.repeat(40_000) })] })
    ok(r.status === 413, `status ${r.status}`)
  })

  await t('403 repo not on the allowlist', async () => {
    reset()
    const r = await post({ repo: 'someone/else', items: [item(1)] })
    ok(r.status === 403, `status ${r.status}`)
    ok(gh.creates.length === 0 && gh.calls.length === 0, 'no GitHub call for a refused repo')
  })

  await t('inferred item not filed into a public repo, explicit item is', async () => {
    reset()
    const r = await post({ repo: 'acme/public-repo', items: [item(1), item(2, { source: 'inferred', kind: 'todo', origin: 'tool' })] })
    ok(r.status === 200, `status ${r.status}`)
    const by = Object.fromEntries(r.body.results.map((x: any) => [x.key, x.action]))
    ok(by[key(1)] === 'created', `explicit: ${by[key(1)]}`)
    ok(by[key(2)] === 'held', `inferred: ${by[key(2)]}`)
    ok(gh.creates.length === 1, `creates ${gh.creates.length}`)
  })

  await t('a meeting- or phone-sourced "explicit" item never files to a public repo', async () => {
    reset()
    const r = await post({ repo: 'acme/public-repo', items: [item(3, { origin: 'meeting' }), item(4, { origin: 'phone' })] })
    ok(r.body.results.every((x: any) => x.action === 'held'), JSON.stringify(r.body.results))
    ok(gh.creates.length === 0, 'nothing created')
  })

  await t('unknown repo visibility counts as public (fail closed)', async () => {
    reset()
    const r = await post({ repo: 'acme/broken-repo', items: [item(5, { source: 'inferred', origin: 'tool' }), item(6)] })
    const by = Object.fromEntries(r.body.results.map((x: any) => [x.key, x.action]))
    ok(by[key(5)] === 'held' && by[key(6)] === 'created', JSON.stringify(by))
  })

  await t('private repo: inferred items file, marked noted and not a work order', async () => {
    reset()
    const r = await post({ repo: 'acme/private-repo', items: [item(7, { source: 'inferred', kind: 'todo', origin: 'tool', text: 'wire the route' }), item(8, { origin: 'meeting', source: 'explicit' })] })
    ok(r.body.results.every((x: any) => x.action === 'created'), JSON.stringify(r.body.results))
    for (const c of gh.creates) {
      ok(c.labels.includes('osborn:noted') && !c.labels.includes('osborn:proposed'), `labels ${c.labels}`)
      ok(/not asked for or agreed/.test(c.body), 'body marks it inferred')
      ok(c.body.includes('Follow-up record, not a work order.'), 'footer')
    }
    ok(gh.creates.some((c) => /from meeting/.test(c.body)), 'meeting origin named')
  })

  await t('an open or dismissed (closed as not planned) issue with the same loopKey is skipped', async () => {
    reset()
    const marker = (n: number) => `<!-- osborn-fp-${key(n)} do-not-remove -->`
    gh.issues.set('acme/private-repo', [
      { number: 1, html_url: 'https://github.com/acme/private-repo/issues/1', body: `old\n${marker(10)}`, state: 'closed', state_reason: 'not_planned', labels: ['follow-through'], title: 't', payload: {} },
    ])
    const r = await post({ repo: 'acme/private-repo', items: [item(10), item(11)] })
    const by = Object.fromEntries(r.body.results.map((x: any) => [x.key, x]))
    ok(by[key(10)].action === 'skipped' && by[key(10)].url === 'https://github.com/acme/private-repo/issues/1', JSON.stringify(by[key(10)]))
    ok(by[key(11)].action === 'created', 'new one created')
    // A second identical POST creates nothing new.
    const again = await post({ repo: 'acme/private-repo', items: [item(10), item(11)] })
    ok(again.body.results.every((x: any) => x.action === 'skipped'), JSON.stringify(again.body.results))
    ok(gh.creates.length === 1, `creates ${gh.creates.length}`)
  })

  await t('labels created once per repo per batch', async () => {
    reset()
    await post({ repo: 'acme/public-repo', items: [item(20), item(21), item(22)] })
    const forRepo = gh.labelPosts.filter((l) => l.startsWith('acme/public-repo:'))
    ok(new Set(forRepo).size === forRepo.length, `duplicate label posts: ${forRepo}`)
  })

  await t('body has redacted text and no session id, user id, email or path', async () => {
    reset()
    const text = 'remind me to rotate sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX in /home/founder/proj/.env for founder@example.com'
    const r = await post({ repo: 'acme/private-repo', session_id: 'sess-SECRET-999', items: [item(30, { text })] })
    ok(r.body.results[0].action === 'created', JSON.stringify(r.body.results))
    const c = gh.creates[0]
    const hay = `${c.title}\n${c.body}`
    for (const s of ['ABCDEFGHIJKLMNOP', '/home/founder', 'founder@', 'sess-SECRET-999', USER, GOOD_TOKEN]) ok(!hay.includes(s), `leaked ${s}`)
  })

  await t('a mention in the item text comes out neutralized', async () => {
    reset()
    await post({ repo: 'acme/private-repo', items: [item(40, { text: 'remind me to ask @someone and @helperbot to fix it' })] })
    const c = gh.creates[0]
    ok(!/@[A-Za-z]/.test(c.title) && !/@[A-Za-z]/.test(c.body), `title=${c.title}`)
    ok(c.body.includes('@\u200dsomeone'), 'mention kept readable')
  })

  await t('HTML in the item text is escaped in the body; URLs survive the path scrub, Windows paths do not', async () => {
    reset()
    await post({ repo: 'acme/private-repo', items: [item(60, { text: 'remind me <script>alert(1)</script> see https://github.com/o/r/issues/1 and C:\\Users\\me\\f.txt' })] })
    const c = gh.creates[0]
    ok(!c.body.includes('<script>') && c.body.includes('&lt;script&gt;'), c.body)
    ok(c.body.includes('https://github.com/o/r/issues/1'), 'url kept')
    ok(!c.body.includes('C:\\Users') && c.body.includes('<path>') === false && c.body.includes('&lt;path&gt;'), 'windows path scrubbed')
  })

  await t('the issue has no assignees and only labels from the allowed set', async () => {
    reset()
    await post({ repo: 'acme/private-repo', items: [item(50), item(51, { source: 'inferred', origin: 'tool' })] })
    for (const c of gh.creates) {
      ok(!('assignees' in c) && !('assignee' in c), 'assignees sent')
      ok(c.labels.every((l: string) => mirror.FOLLOW_UP_LABELS.includes(l)), `labels ${c.labels}`)
      ok(c.labels.includes('follow-through'), 'follow-through label')
      ok(!c.labels.includes('osborn:agreed'), 'never agreed')
    }
    ok(gh.labelPosts.every((l) => mirror.FOLLOW_UP_LABELS.includes(l.split(':').slice(1).join(':'))), `label posts ${gh.labelPosts}`)
    const kinds = gh.creates.map((c) => c.labels[1]).sort()
    ok(kinds.join() === 'osborn:noted,osborn:proposed', kinds.join())
  })

  await t("user B's valid token posting to user A's repo gets 403", async () => {
    reset() // account A owns the allowlisted repos
    const b = newAccount()
    const r = await post({ repo: 'acme/private-repo', items: [item(60)] }, b.token)
    ok(r.status === 403, `status ${r.status}`)
    ok(gh.calls.length === 0 && gh.creates.length === 0, 'no GitHub call for another account')
    // A bare owner/repo entry (no =user) allows no one.
    process.env.FOLLOW_THROUGH_REPO_ALLOWLIST = 'acme/private-repo'
    ok((await post({ repo: 'acme/private-repo', items: [item(61)] })).status === 403, 'bare entry')
  })

  await t('going over the daily cap gets 429', async () => {
    reset()
    const batch = (from: number) => Array.from({ length: 10 }, (_, i) => item(from + i))
    for (const from of [100, 200, 300]) {
      const r = await post({ repo: 'acme/private-repo', items: batch(from) })
      ok(r.status === 200 && r.body.results.every((x: any) => x.action === 'created'), `batch ${from}: ${r.status}`)
    }
    const over = await post({ repo: 'acme/private-repo', items: [item(400)] })
    ok(over.status === 429, `status ${over.status}`)
    ok(gh.creates.length === 30, `creates ${gh.creates.length}`)
    // Held items never reach GitHub and never count.
    const held = await post({ repo: 'acme/public-repo', items: [item(401, { source: 'inferred', origin: 'tool' })] })
    ok(held.status === 200 && held.body.results[0].action === 'held', JSON.stringify(held.body))
    // Another account is unaffected.
    reset()
    ok((await post({ repo: 'acme/private-repo', items: [item(402)] })).status === 200, 'other account')
  })

  await t('a cap reached mid-batch leaves the rest open (error), not 429', async () => {
    reset()
    await post({ repo: 'acme/private-repo', items: Array.from({ length: 20 }, (_, i) => item(500 + i)) })
    const r = await post({ repo: 'acme/private-repo', items: Array.from({ length: 15 }, (_, i) => item(600 + i)) })
    ok(r.status === 200, `status ${r.status}`)
    const actions = r.body.results.map((x: any) => x.action)
    ok(actions.filter((a: string) => a === 'created').length === 10 && actions.filter((a: string) => a === 'error').length === 5, actions.join())
  })

  await t('markdown links, images and issue references are neutralized', async () => {
    reset()
    const text = 'remind me: see [the doc](https://evil.example/x) and ![img](https://evil.example/i.png), fixes #12, acme/other#7 and GH-3'
    await post({ repo: 'acme/private-repo', items: [item(70, { text })] })
    const c = gh.creates[0]
    for (const s of ['](', '![', '#12', 'other#7', 'GH-3']) ok(!c.body.includes(s) && !c.title.includes(s), `live ${s} in ${c.body}`)
    ok(c.body.includes('#\u200d12') && c.body.includes(']\u200d('), 'kept readable')
  })

  await t('a closed-as-completed issue with the same key does not block a new filing', async () => {
    reset()
    gh.issues.set('acme/private-repo', [
      { number: 1, html_url: 'https://github.com/acme/private-repo/issues/1', body: `old\n<!-- osborn-fp-${key(80)} do-not-remove -->`, state: 'closed', state_reason: 'completed', labels: ['follow-through'], title: 't', payload: {} },
    ])
    const r = await post({ repo: 'acme/private-repo', items: [item(80)] })
    ok(r.body.results[0].action === 'created', JSON.stringify(r.body.results))
  })

  await t('relative file paths are scrubbed', async () => {
    reset()
    await post({ repo: 'acme/private-repo', items: [item(90, { text: 'remind me to fix src/lib/follow-through.ts and ./x/y.json' })] })
    const c = gh.creates[0]
    ok(!c.body.includes('src/lib') && !c.body.includes('x/y.json'), c.body)
    ok(c.body.includes('&lt;path&gt;'), 'replaced')
  })

  await t('a dedup skip does not use up the daily cap', async () => {
    reset()
    const marker = (n: number) => `<!-- osborn-fp-${key(n)} do-not-remove -->`
    gh.issues.set('acme/private-repo', Array.from({ length: 30 }, (_, i) => ({ number: i + 1, html_url: `https://github.com/acme/private-repo/issues/${i + 1}`, body: marker(700 + i), state: 'open', labels: ['follow-through'], title: 't', payload: {} })))
    for (const from of [700, 710, 720]) {
      const r = await post({ repo: 'acme/private-repo', items: Array.from({ length: 10 }, (_, i) => item(from + i)) })
      ok(r.body.results.every((x: any) => x.action === 'skipped'), JSON.stringify(r.body))
    }
    const r = await post({ repo: 'acme/private-repo', items: [item(800)] })
    ok(r.status === 200 && r.body.results[0].action === 'created', `status ${r.status} ${JSON.stringify(r.body)}`)
  })

  await t("an item quoting another item's dedup marker does not block it", async () => {
    reset()
    await post({ repo: 'acme/private-repo', items: [item(900, { text: `remind me: log said osborn-fp-${key(901)} twice` })] })
    const r = await post({ repo: 'acme/private-repo', items: [item(901)] })
    ok(r.body.results[0].action === 'created', JSON.stringify(r.body))
  })

  await t('report route behaviour unchanged after repo parameterization', async () => {
    reset()
    const r = await mirror.mirrorReportToGitHub({ type: 'bug', severity: 'high', title: 'Mic loops', description: 'It loops.' })
    ok(r.ok && r.action === 'created', JSON.stringify(r))
    const search = gh.calls.find((c) => c.startsWith('GET /search/issues'))!
    ok(decodeURIComponent(search).includes('repo:Erriccc/osborn is:issue is:open'), search)
    ok(gh.creates[0].repo === 'Erriccc/osborn', gh.creates[0].repo)
    ok(gh.creates[0].labels.join() === 'bug,user-report', gh.creates[0].labels.join())
    ok(gh.labelPosts.join() === 'Erriccc/osborn:user-report', gh.labelPosts.join())
    // An open duplicate gets a comment, as before.
    const again = await mirror.mirrorReportToGitHub({ type: 'bug', severity: 'high', title: 'Mic loops', description: 'Again.' })
    ok(again.ok && again.action === 'commented', JSON.stringify(again))
  })

  let failed = 0
  for (const [name, pass, err] of results) {
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${err ? `\n      ${err}` : ''}`)
    if (!pass) failed++
  }
  console.log(`\n${results.length - failed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}
main()
