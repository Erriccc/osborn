// Run: cd frontend && npx tsx tests/newest-sandbox-image.test.ts
// New machines must run the newest RELEASED sandbox image, never a `:latest`
// tag that the manual release path leaves stale (it was 0.9.272 while the
// fleet ran 0.9.277 on 2026-11-12).
import assert from 'node:assert'
import { pickNewestVersionTag, parseImageRef, sandboxImageWithTag, resolveNewestSandboxImage, resetNewestSandboxImageCache } from '../src/lib/machines'

const real = ['0.9.252', '0.9.269', '0.9.270', '0.9.271', '0.9.272', '0.9.275', '0.9.276', '0.9.277', 'latest', 'legacy-app-0.9.268']
assert.strictEqual(pickNewestVersionTag(real), '0.9.277')
// Numeric, not lexicographic.
assert.strictEqual(pickNewestVersionTag(['0.9.99', '0.9.100']), '0.9.100')
assert.strictEqual(pickNewestVersionTag(['0.9.277', '0.10.0']), '0.10.0')
assert.strictEqual(pickNewestVersionTag(['0.99.99', '1.0.0']), '1.0.0')
// Only plain x.y.z counts.
assert.strictEqual(pickNewestVersionTag(['latest', 'legacy-app-9.9.9', '9.9.9-rc1', 'v9.9.9', '9.9', 'sha256:abc', '', '0.0.1']), '0.0.1')
assert.strictEqual(pickNewestVersionTag(['latest', 'main']), null)
assert.strictEqual(pickNewestVersionTag([null, 42, undefined, { tag: '9.9.9' }, ' 0.9.3 ']), '0.9.3')
// Ceiling: a tag above what npm calls released is never chosen.
assert.strictEqual(pickNewestVersionTag(['0.9.277', '99.0.0'], '0.9.277'), '0.9.277')
assert.strictEqual(pickNewestVersionTag(['0.9.276', '0.9.278'], '0.9.277'), '0.9.276')
assert.strictEqual(pickNewestVersionTag(['99.0.0'], '0.9.277'), null)
assert.strictEqual(pickNewestVersionTag(['0.9.277', '99.0.0'], 'not-a-version'), '99.0.0')

// Image reference shapes FLY_SANDBOX_IMAGE can take.
assert.deepStrictEqual(parseImageRef('registry.fly.io/osborn-sandbox3:latest'), { host: 'registry.fly.io', repo: 'osborn-sandbox3' })
assert.deepStrictEqual(parseImageRef('registry.fly.io/osborn-sandbox/agent:latest'), { host: 'registry.fly.io', repo: 'osborn-sandbox/agent' })
assert.deepStrictEqual(parseImageRef('  registry.fly.io/osborn-sandbox3  '), { host: 'registry.fly.io', repo: 'osborn-sandbox3' })
assert.deepStrictEqual(parseImageRef('registry.fly.io/osborn-sandbox3:0.9.1@sha256:' + 'a'.repeat(64)), { host: 'registry.fly.io', repo: 'osborn-sandbox3' })
assert.deepStrictEqual(parseImageRef('registry.fly.io/osborn-sandbox3@sha256:' + 'a'.repeat(64)), { host: 'registry.fly.io', repo: 'osborn-sandbox3' })
assert.deepStrictEqual(parseImageRef('host:5000/team/repo:tag'), { host: 'host:5000', repo: 'team/repo' })
assert.strictEqual(parseImageRef('no-slash'), null)
assert.strictEqual(sandboxImageWithTag('registry.fly.io/osborn-sandbox3:latest', '0.9.277'), 'registry.fly.io/osborn-sandbox3:0.9.277')
assert.strictEqual(sandboxImageWithTag('registry.fly.io/osborn-sandbox3', '0.9.277'), 'registry.fly.io/osborn-sandbox3:0.9.277')
assert.strictEqual(sandboxImageWithTag('registry.fly.io/osborn-sandbox3@sha256:' + 'b'.repeat(64), '0.9.277'), 'registry.fly.io/osborn-sandbox3:0.9.277')
assert.strictEqual(sandboxImageWithTag('host:5000/team/repo:old', '1.2.3'), 'host:5000/team/repo:1.2.3')

// resolveNewestSandboxImage against a mocked registry + npm.
async function withFetch(impl: (url: string, init?: any) => Promise<Response>, fn: () => Promise<void>) {
  const real = globalThis.fetch
  globalThis.fetch = ((u: any, i?: any) => impl(String(u), i)) as typeof fetch
  try { resetNewestSandboxImageCache(); await fn() } finally { globalThis.fetch = real; resetNewestSandboxImageCache() }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function main() {
  process.env.FLY_SANDBOX_IMAGE = 'registry.fly.io/osborn-sandbox3:latest'
  process.env.FLY_API_TOKEN = '  tok-with-padding  '
  const calls: Array<{ url: string; auth?: string }> = []

  // Happy path: stale :latest in config → pinned to the released version.
  await withFetch(async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization })
    if (url.includes('/tags/list')) return json({ tags: real })
    if (url.includes('registry.npmjs.org')) return json({ version: '0.9.277' })
    return json({}, 404)
  }, async () => {
    assert.strictEqual(await resolveNewestSandboxImage(1_000), 'registry.fly.io/osborn-sandbox3:0.9.277')
    const reg = calls.find((c) => c.url.includes('/tags/list'))!
    assert.ok(reg.url.startsWith('https://registry.fly.io/v2/osborn-sandbox3/tags/list'), reg.url)
    assert.strictEqual(reg.auth, 'Basic ' + Buffer.from('x:tok-with-padding').toString('base64'), 'token must be trimmed')
    // Cached: no second registry call inside the TTL.
    const n = calls.length
    assert.strictEqual(await resolveNewestSandboxImage(2_000), 'registry.fly.io/osborn-sandbox3:0.9.277')
    assert.strictEqual(calls.length, n)
  })

  // A tag newer than npm's latest (bad/unreleased build) is not handed out.
  await withFetch(async (url) => url.includes('/tags/list') ? json({ tags: [...real, '99.0.0'] }) : json({ version: '0.9.277' }), async () => {
    assert.strictEqual(await resolveNewestSandboxImage(1_000), 'registry.fly.io/osborn-sandbox3:0.9.277')
  })

  // npm unreachable → newest tag as-is (still better than a stale :latest).
  await withFetch(async (url) => { if (url.includes('/tags/list')) return json({ tags: real }); throw new Error('npm down') }, async () => {
    assert.strictEqual(await resolveNewestSandboxImage(1_000), 'registry.fly.io/osborn-sandbox3:0.9.277')
  })

  // Registry 401 → configured image, and the failure is cached (one call, not one per sign-up).
  let hits = 0
  await withFetch(async () => { hits++; return json({ errors: [] }, 401) }, async () => {
    assert.strictEqual(await resolveNewestSandboxImage(1_000), 'registry.fly.io/osborn-sandbox3:latest')
    assert.strictEqual(await resolveNewestSandboxImage(30_000), 'registry.fly.io/osborn-sandbox3:latest')
    assert.strictEqual(hits, 1)
    // …but only briefly: after the short TTL it tries again.
    await resolveNewestSandboxImage(70_000)
    assert.strictEqual(hits, 2)
  })

  // Registry throws → configured image, never an exception.
  await withFetch(async () => { throw new Error('boom') }, async () => {
    assert.strictEqual(await resolveNewestSandboxImage(1_000), 'registry.fly.io/osborn-sandbox3:latest')
  })

  console.log('newest-sandbox-image: all assertions passed')
}
main().catch((e) => { console.error(e); process.exit(1) })
