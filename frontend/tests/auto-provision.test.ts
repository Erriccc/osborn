// Run: cd frontend && npx --yes tsx tests/auto-provision.test.ts
// Spec: create is idempotent per user; dashboard auto-triggers create when
// GET /api/sandbox says available:true + sandbox:null (guarded vs double-fire);
// dashboard retries initial GET once on 401; unauth create -> 401;
// settings/dashboard have no hooks after an early return.
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'

const root = path.resolve(__dirname, '..')
const results: [string, boolean, string?][] = []
const warns: string[] = []
async function t(name: string, fn: () => any) {
  try { await fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

// Return the bodies of all useEffect(...) calls (balanced-paren scan).
function effectBodies(src: string): string[] {
  const out: string[] = []
  const re = /useEffect\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, depth = 1
    while (i < src.length && depth > 0) { const c = src[i]; if (c === '(') depth++; else if (c === ')') depth--; i++ }
    out.push(src.slice(m.index, i))
  }
  return out
}

function hooksAfterEarlyReturn(src: string): { early: number; hooks: string[] } | null {
  const lines = src.split('\n')
  const start = lines.findIndex(l => /^export default function /.test(l))
  if (start < 0) return null
  // top-level statements of component body are indented exactly 2 spaces
  let early = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (/^}/.test(lines[i])) break
    const single = /^  if \(.*\) return\b/.test(lines[i])
    const block = /^  if \(.*\) \{\s*$/.test(lines[i]) && /^    return\b/.test(lines[i + 1] || '')
    if (early < 0 && (single || block)) { early = i; continue }
    if (early >= 0 && /^  (const|let)?.*\b(useState|useEffect|useCallback|useMemo|useRef)\b *[<(]/.test(lines[i]) && !/^\s*\/\//.test(lines[i])) {
      return { early: early + 1, hooks: [`${i + 1}: ${lines[i].trim().slice(0, 80)}`] }
    }
  }
  return early < 0 ? null : { early: early + 1, hooks: [] }
}

async function main() {
  // ---------- route behaviour ----------
  type St = { user: any; instance: any }
  const st: St = { user: { id: 'user-A' }, instance: null }
  const prov: string[] = []
  const mocks: Record<string, any> = {
    'next/server': { NextResponse: { json: (body: any, init?: any) => ({ body, status: init?.status ?? 200 }) } },
    '@/lib/supabase-server': {
      createSupabaseServer: async () => ({
        auth: { getUser: async () => ({ data: { user: st.user } }) },
        from: () => {
          const b: any = {
            select: () => b, eq: () => b, update: () => b, insert: () => b, upsert: () => b, maybeSingle: async () => ({ data: st.instance, error: null }),
            single: async () => ({ data: st.instance, error: null }),
            then: (res: any) => res({ data: st.instance, error: null }),
          }
          return b
        },
      }),
    },
    '@/lib/cloud': new Proxy({}, {
      get: (_t, k: string) => {
        if (k === '__esModule') return true
        if (k === 'isSpritesConfigured') return () => true
        if (k === 'findUserSandbox') return async (_u: string, known?: string) =>
          known ? { id: known, status: 'running', previewUrl: 'http://existing' } : null
        if (k === 'createSandbox' || k === 'assignFromPoolOrCreate')
          return async () => { prov.push(k); return { id: 'new-sbx', status: 'running', previewUrl: 'http://new' } }
        return async () => true
      },
    }),
  }
  const M: any = Module
  const orig = M._load
  M._load = function (req: string, ...rest: any[]) { return req in mocks ? mocks[req] : orig.call(this, req, ...rest) }
  const route: any = await import('../src/app/api/sandbox/route')
  const post = (body: any) => route.POST(new Request('http://x/api/sandbox', { method: 'POST', body: JSON.stringify(body) }))
  const saved = process.env.CLOUD_PROVIDER

  for (const provider of ['sprites', 'machines']) {
    process.env.CLOUD_PROVIDER = provider
    await t(`[${provider}] create with existing sandbox_id does NOT provision a second machine`, async () => {
      prov.length = 0
      st.user = { id: 'user-A' }
      st.instance = { sandbox_id: 'existing-1', sandbox_url: 'http://existing', sync_token: 'tok' }
      const r = await post({ action: 'create' })
      ok(prov.length === 0, `provisioner called: ${prov.join(',')}`)
      ok(r.status < 400, `status ${r.status}`)
    })
    await t(`[${provider}] create twice with existing sandbox_id never provisions`, async () => {
      prov.length = 0
      await post({ action: 'create' }); await post({ action: 'create' })
      ok(prov.length === 0, `provisioner called ${prov.length}x`)
    })
    await t(`[${provider}] create with no instance provisions exactly once`, async () => {
      prov.length = 0
      st.instance = null
      const r = await post({ action: 'create' })
      ok(prov.length === 1, `provisioner calls: ${prov.length} (${prov.join(',')})`)
      ok(r.status === 200, `status ${r.status}`)
    })
    await t(`[${provider}] create with instance row but null sandbox_id provisions exactly once`, async () => {
      prov.length = 0
      st.instance = { sandbox_id: null, sandbox_url: null }
      await post({ action: 'create' })
      ok(prov.length === 1, `provisioner calls: ${prov.length}`)
    })
    await t(`[${provider}] unauthenticated create -> 401, no provisioning`, async () => {
      prov.length = 0
      st.user = null; st.instance = null
      const r = await post({ action: 'create' })
      ok(r.status === 401, `status ${r.status}`)
      ok(prov.length === 0, 'provisioned while unauthenticated')
    })
  }
  if (saved === undefined) delete process.env.CLOUD_PROVIDER; else process.env.CLOUD_PROVIDER = saved
  M._load = orig

  // ---------- dashboard source checks ----------
  const dash = read('src/app/dashboard/page.tsx')
  const effects = effectBodies(dash)

  await t('dashboard: handleProvisionSandbox still defined (back-compat)', () => {
    ok(/const handleProvisionSandbox\s*=/.test(dash), 'missing')
  })
  await t('dashboard: auto-create reachable from an effect (not just defined)', () => {
    const hit = effects.some(e => /handleProvisionSandbox\b/.test(e) || /action:\s*['"]create['"]/.test(e))
    ok(hit, 'no useEffect references handleProvisionSandbox or a create POST')
  })
  await t('dashboard: auto-create keyed on available:true and null sandbox', () => {
    const hit = effects.some(e => /available/.test(e) && /sandbox/.test(e) && (/handleProvisionSandbox\b|['"]create['"]/.test(e)))
    ok(hit, 'no effect combines `available` check with create trigger')
  })
  await t('dashboard: guard against double-firing (ref)', () => {
    const refs = Array.from(dash.matchAll(/const (\w+)\s*=\s*useRef/g)).map(m => m[1])
    const guard = refs.filter(n => /provision|auto|attempt|fired|tried|creat|started|once/i.test(n))
    ok(guard.length > 0, `no guard-like useRef (refs: ${refs.join(',')})`)
    const used = guard.some(n => effects.some(e => new RegExp(`\\b${n}\\.current`).test(e)))
    ok(used, `guard refs ${guard.join(',')} not read inside any effect`)
  })
  await t('dashboard: initial GET retried once on 401', () => {
    const hit = effects.some(e => /401/.test(e) && /\/api\/sandbox/.test(e))
    ok(hit, 'no effect that fetches /api/sandbox and checks 401')
  })

  // ---------- hooks after early return ----------
  for (const f of ['src/app/settings/page.tsx', 'src/app/dashboard/page.tsx']) {
    await t(`${f}: no React hooks after early return (heuristic)`, () => {
      const r = hooksAfterEarlyReturn(read(f))
      if (r === null) { warns.push(`${f}: no default-export component / early return found (heuristic inconclusive or none)`); return }
      ok(r.hooks.length === 0, `early return at line ${r.early}, hook after it: ${r.hooks.join('; ')}`)
    })
  }

  let fail = 0
  for (const [n, p, m] of results) { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? '\n      ' + m : ''}`); if (!p) fail++ }
  for (const w of warns) console.log(`WARN  ${w}`)
  console.log(`\n${results.length - fail}/${results.length} passed`)
  process.exit(fail ? 1 : 0)
}
main()
