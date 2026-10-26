// Run: cd frontend && npx tsx tests/service-role-key-leak.test.ts
// Spec: SUPABASE_SERVICE_ROLE_KEY must never be forwarded to agent machines;
// sandbox start/stop/keepalive/delete must reject foreign sandboxIds;
// settings copy must not claim "Stored encrypted".
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'

const root = path.resolve(__dirname, '..')
const results: [string, boolean, string?][] = []
async function t(name: string, fn: () => any) {
  try { await fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const FAKE = 'fake-service-role-DO-NOT-USE-123'
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

async function main() {
  // ---- Part 1: platform-env ----
  process.env.SUPABASE_SERVICE_ROLE_KEY = FAKE
  process.env.OPENAI_API_KEY = 'fake-openai'
  const pe = await import('../src/lib/platform-env')

  await t('forwardHostEnv() default does not include SERVICE_ROLE key', () => {
    const env = pe.forwardHostEnv()
    ok(!('SUPABASE_SERVICE_ROLE_KEY' in env), 'key present in forwardHostEnv()')
    ok(!Object.values(env).includes(FAKE), 'fake value leaked under another key')
  })
  await t('forwardHostEnv() sanity: other keys still forwarded (back-compat)', () => {
    ok(pe.forwardHostEnv().OPENAI_API_KEY === 'fake-openai', 'OPENAI_API_KEY no longer forwarded')
  })
  await t('PLATFORM_FORWARD_KEYS excludes SERVICE_ROLE key', () => {
    ok(!pe.PLATFORM_FORWARD_KEYS.includes('SUPABASE_SERVICE_ROLE_KEY'), 'in PLATFORM_FORWARD_KEYS')
  })
  await t('PLATFORM_ENV_SPEC has no host-env SERVICE_ROLE entry', () => {
    const e = pe.PLATFORM_ENV_SPEC.find((s: any) => s.key === 'SUPABASE_SERVICE_ROLE_KEY')
    ok(!e || e.source !== 'host-env', 'still declared as host-env forwarded')
  })
  await t('forwardHostEnv even when explicitly given only default list stays clean', () => {
    ok(Object.keys(pe.forwardHostEnv(pe.PLATFORM_FORWARD_KEYS)).indexOf('SUPABASE_SERVICE_ROLE_KEY') < 0, 'leak')
  })

  // machines.ts merge is inline in non-exported async functions (not pure) -> source assertions.
  const mach = read('src/lib/machines.ts')
  await t('machines.ts: updateOsborn env merge strips SERVICE_ROLE (source check; merge not pure)', () => {
    const i = mach.indexOf('export async function updateOsborn')
    ok(i > 0, 'updateOsborn not found')
    const seg = mach.slice(i)
    const m = seg.match(/const cleanedEnv = \{[\s\S]*?\n\s*delete cleanedEnv\.OSBORN_CWD[\s\S]{0,400}/)
    ok(m && /SUPABASE_SERVICE_ROLE_KEY/.test(m[0]), 'no SERVICE_ROLE strip near updateOsborn cleanedEnv merge')
  })
  await t('machines.ts: repointAndStartSandbox env merge strips SERVICE_ROLE (source check)', () => {
    const i = mach.indexOf('export async function repointAndStartSandbox')
    const m = mach.slice(i).match(/const cleanedEnv = \{[\s\S]*?\n\s*delete cleanedEnv\.OSBORN_CWD[\s\S]{0,400}/)
    ok(m && /SUPABASE_SERVICE_ROLE_KEY/.test(m[0]), 'no SERVICE_ROLE strip near repoint cleanedEnv merge')
  })
  await t('machines.ts: HOME/OSBORN_CWD strip retained (regression)', () => {
    ok((mach.match(/delete cleanedEnv\.HOME/g) || []).length >= 2, 'HOME strip missing')
  })
  for (const f of ['sprites.ts', 'daytona.ts']) {
    await t(`${f}: does not read SERVICE_ROLE from host env for machine env`, () => {
      const s = read('src/lib/' + f)
      ok(!/process\.env\.SUPABASE_SERVICE_ROLE_KEY/.test(s), 'reads key directly')
    })
  }

  // ---- Part 2: sandbox route ----
  const calls: string[] = []
  const OWN = 'own-sandbox-1', FOREIGN = 'victim-sandbox-9'
  const mocks: Record<string, any> = {
    'next/server': { NextResponse: { json: (body: any, init?: any) => ({ body, status: init?.status ?? 200 }) } },
    '@/lib/supabase-server': {
      createSupabaseServer: async () => ({
        auth: { getUser: async () => ({ data: { user: { id: 'user-A' } } }) },
        from: () => {
          const b: any = {
            select: () => b, eq: () => b, update: () => b, insert: () => b,
            single: async () => ({ data: { sandbox_id: OWN, sandbox_url: 'http://x', sync_token: 'tok' }, error: null }),
            then: (res: any) => res({ data: null, error: null }),
          }
          return b
        },
      }),
    },
    '@/lib/cloud': new Proxy({}, {
      get: (_t, k: string) => {
        if (k === '__esModule') return true
        if (k === 'isSpritesConfigured') return () => true
        return async (...a: any[]) => { calls.push(`${k}:${a[0]}`); return k === 'startSandbox' ? { previewUrl: 'http://p' } : true }
      },
    }),
  }
  const M: any = Module
  const orig = M._load
  M._load = function (req: string, ...rest: any[]) { return req in mocks ? mocks[req] : orig.call(this, req, ...rest) }
  const route: any = await import('../src/app/api/sandbox/route')
  const post = (body: any) => route.POST(new Request('http://x/api/sandbox', { method: 'POST', body: JSON.stringify(body) }))
  const fn: Record<string, string> = { start: 'startSandbox', stop: 'stopSandbox', keepalive: 'keepAliveSandbox', delete: 'deleteSandbox' }

  for (const action of Object.keys(fn)) {
    await t(`route ${action}: foreign sandboxId rejected (403/404) and ${fn[action]} NOT called`, async () => {
      calls.length = 0
      const r = await post({ action, sandboxId: FOREIGN })
      ok(r.status === 403 || r.status === 404, `status ${r.status}`)
      ok(!calls.some(c => c.endsWith(`:${FOREIGN}`)), `cloud called with foreign id: ${calls.join(',')}`)
    })
    await t(`route ${action}: own sandboxId still works (back-compat)`, async () => {
      calls.length = 0
      const r = await post({ action, sandboxId: OWN })
      ok(r.status === 200, `status ${r.status}`)
      ok(calls.includes(`${fn[action]}:${OWN}`), `expected ${fn[action]} call, got ${calls.join(',')}`)
    })
    await t(`route ${action}: missing sandboxId -> 400 (back-compat)`, async () => {
      const r = await post({ action })
      ok(r.status === 400, `status ${r.status}`)
    })
  }
  M._load = orig

  // ---- Part 3: settings copy ----
  const settings = read('src/app/settings/page.tsx')
  await t('settings page does not claim keys are "Stored encrypted"', () => {
    ok(!/stored encrypted/i.test(settings), 'still says "Stored encrypted"')
  })
  await t('settings API Keys description still present and says never shown back', () => {
    ok(/never shown back/.test(settings), 'description lost')
  })

  let fail = 0
  for (const [n, p, m] of results) { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? '\n      ' + m : ''}`); if (!p) fail++ }
  console.log(`\n${results.length - fail}/${results.length} passed`)
  process.exit(fail ? 1 : 0)
}
main()
