// Run: cd frontend && npx tsx tests/middleware-login-redirect.test.ts
// The real middleware with a stubbed Supabase user: a signed-in visitor on /login goes to a
// same-site ?next, else /dashboard; a guest stays on /login.
import assert from 'node:assert/strict'
import Module from 'node:module'
import { NextRequest } from 'next/server'

let user: unknown = null
const mocks: Record<string, unknown> = {
  '@supabase/ssr': { createServerClient: () => ({ auth: { getUser: async () => ({ data: { user } }) } }) },
}
const M: any = Module
const orig = M._load
M._load = function (req: string, ...rest: unknown[]) { return req in mocks ? mocks[req] : orig.call(this, req, ...rest) }

async function main() {
  const { middleware } = await import('../src/middleware')
  const o = 'https://voice-native.com'
  const go = async (qs: string) => {
    const r = await middleware(new NextRequest(`${o}/login${qs}`))
    const loc = r.headers.get('location')
    return loc ? new URL(loc) : null
  }

  user = { id: 'u1' }
  const kept = await go('?next=' + encodeURIComponent('/chat?session=abc&x=1#h'))
  assert.equal(kept!.origin, o)
  assert.equal(kept!.pathname + kept!.search + kept!.hash, '/chat?session=abc&x=1#h')
  assert.equal((await go(''))!.pathname, '/dashboard')
  for (const bad of ['//evil.com', '/\\evil.com', '\\\\evil.com', '/.//evil.com', '/%2e//evil.com', '/a/..//evil.com',
    '/./\\evil.com', '/\t/evil.com', '/\n/evil.com', 'https://evil.com/x', 'javascript:alert(1)', '']) {
    const loc = await go('?next=' + encodeURIComponent(bad))
    assert.equal(loc!.origin, o, JSON.stringify(bad))
    assert.equal(loc!.pathname, '/dashboard', JSON.stringify(bad))
  }
  // The first ?next wins; a second one cannot smuggle a host.
  assert.equal((await go('?next=%2Fsettings&next=%2F%2Fevil.com'))!.pathname, '/settings')
  // Never back to /login, so a nested ?next=/login?next=… is one hop, not a chain.
  for (const loop of ['/login', '/login?next=%2Flogin', '/login/?next=%2Fchat']) {
    assert.equal((await go('?next=' + encodeURIComponent(loop)))!.pathname, '/dashboard', loop)
  }

  user = null
  assert.equal(await go('?next=%2Fchat'), null)
  console.log('middleware-login-redirect ok')
}
main().catch((e) => { console.error(e); process.exit(1) })
