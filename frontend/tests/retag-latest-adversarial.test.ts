// Run: cd frontend && npx --yes tsx tests/retag-latest-adversarial.test.ts
// Adversarial tests derived from the spec only.
import { checkImageBuild, compareVersions, retagLatest } from '../src/lib/image-build-check'

const results: [string, boolean, string?][] = []
async function t(name: string, fn: () => any) {
  try { await fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e?.message ?? e).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }

const SECRET = 'FLYSECRET-tok_abc123XYZ'
const SECRET_B64 = Buffer.from(`x:${SECRET}`).toString('base64')
const logged: string[] = []
const origErr = console.error, origLog = console.log, origWarn = console.warn, origFetch = globalThis.fetch
function capture() {
  logged.length = 0
  const f = (...a: any[]) => { logged.push(a.map(String).join(' ')) }
  console.error = f; console.log = f; console.warn = f
}
function restore() { console.error = origErr; console.log = origLog; console.warn = origWarn; globalThis.fetch = origFetch }

type Req = { url: string; method: string }
let reqs: Req[] = []
// mode: which request should fail and how
function fakeFetch(opts: { current?: string | null; getThrows?: boolean; putThrows?: boolean; putStatus?: number; getStatus?: number; putBody?: string }) {
  reqs = []
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input)
    const method = (init.method || 'GET').toUpperCase()
    reqs.push({ url, method })
    if (method === 'PUT') {
      if (opts.putThrows) throw new Error('ECONNRESET on put')
      const s = opts.putStatus ?? 201
      return new Response(opts.putBody ?? '', { status: s })
    }
    if (url.includes('/manifests/latest')) {
      if (opts.current === null || opts.current === undefined) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify({ config: { digest: 'sha256:cur' } }), { status: 200 })
    }
    if (url.includes('/blobs/sha256:cur')) {
      return new Response(JSON.stringify({ config: { Env: [`OSBORN_IMAGE_VERSION=${opts.current}`] } }), { status: 200 })
    }
    if (/\/manifests\/[^/]+$/.test(url)) {
      if (opts.getThrows) throw new Error('ENOTFOUND on get')
      return new Response('{"a":1}', { status: opts.getStatus ?? 200, headers: { 'content-type': 'application/vnd.docker.distribution.manifest.v2+json', 'docker-content-digest': 'sha256:dead' } })
    }
    return new Response('{}', { status: 404 })
  }) as any
}
const puts = () => reqs.filter((r) => r.method === 'PUT').length

async function main() {
  // ── compareVersions edge cases
  await t('0.9.10 > 0.9.9 (numeric, not lexical)', () => { ok(compareVersions('0.9.10', '0.9.9') === 1, 'a'); ok(compareVersions('0.9.9', '0.9.10') === -1, 'b') })
  await t('0.9.272 vs 0.9.30', () => ok(compareVersions('0.9.272', '0.9.30') === 1, 'x'))
  await t('equal versions -> 0', () => ok(compareVersions('1.2.3', '1.2.3') === 0, 'x'))
  await t('1.2 equals 1.2.0', () => ok(compareVersions('1.2', '1.2.0') === 0, 'x'))
  await t('v-prefix tolerated', () => ok(compareVersions('v1.2.4', '1.2.3') === 1, 'x'))
  await t('prerelease suffix ignored (1.0.0-beta.1 == 1.0.0)', () => ok(compareVersions('1.0.0-beta.1', '1.0.0') === 0, 'x'))
  await t('prerelease of newer core still newer', () => ok(compareVersions('1.0.1-rc.1', '1.0.0') === 1, 'x'))
  await t('unknown tag "latest" -> null', () => { ok(compareVersions('0.9.1', 'latest') === null, 'a'); ok(compareVersions('latest', '0.9.1') === null, 'b') })
  await t('empty / garbage -> null', () => { ok(compareVersions('', '1.0.0') === null, 'a'); ok(compareVersions('1..2', '1.0.0') === null, 'b'); ok(compareVersions('abc', 'def') === null, 'c') })
  await t('major bump dominates', () => ok(compareVersions('1.0.0', '0.99.99') === 1, 'x'))

  // ── retagLatest behavior
  capture()
  await t('newer than current -> retagged, one PUT', async () => {
    fakeFetch({ current: '0.9.9' })
    const r = await retagLatest('0.9.10', SECRET, 'app')
    ok(r === 'retagged', `got ${r}`); ok(puts() === 1, 'puts')
  })
  await t('equal to current -> not skipped as older (idempotent retag)', async () => {
    fakeFetch({ current: '0.9.10' })
    const r = await retagLatest('0.9.10', SECRET, 'app')
    ok(r === 'retagged', `got ${r}`)
  })
  await t('older than current -> skipped-older, NO PUT', async () => {
    fakeFetch({ current: '0.9.10' })
    const r = await retagLatest('0.9.9', SECRET, 'app')
    ok(r === 'skipped-older', `got ${r}`); ok(puts() === 0, 'must not PUT')
  })
  await t('unknown current tag (404) -> proceeds', async () => {
    fakeFetch({ current: null })
    const r = await retagLatest('0.9.10', SECRET, 'app')
    ok(r === 'retagged', `got ${r}`)
  })
  await t('current version unparseable ("latest" string) -> proceeds', async () => {
    fakeFetch({ current: 'weird' })
    const r = await retagLatest('0.9.10', SECRET, 'app')
    ok(r === 'retagged', `got ${r}`)
  })
  await t('current is prerelease of same core -> not treated as newer', async () => {
    fakeFetch({ current: '0.9.10-beta.1' })
    const r = await retagLatest('0.9.10', SECRET, 'app')
    ok(r === 'retagged', `got ${r}`)
  })
  await t('network error on GET does not throw, no PUT', async () => {
    fakeFetch({ current: '0.9.1', getThrows: true })
    const r = await retagLatest('0.9.10', SECRET, 'app')
    ok(r === 'failed', `got ${r}`); ok(puts() === 0, 'put')
  })
  await t('network error on PUT does not throw', async () => {
    fakeFetch({ current: '0.9.1', putThrows: true })
    const r = await retagLatest('0.9.10', SECRET, 'app')
    ok(r === 'failed', `got ${r}`)
  })
  await t('GET 404 does not throw', async () => {
    fakeFetch({ current: '0.9.1', getStatus: 404 })
    ok((await retagLatest('0.9.10', SECRET, 'app')) === 'failed', 'x')
  })
  await t('PUT 500 does not throw and logs to console.error loudly', async () => {
    logged.length = 0
    const before = logged.length
    fakeFetch({ current: '0.9.1', putStatus: 500, putBody: 'boom' })
    const errs: string[] = []
    console.error = (...a: any[]) => { errs.push(a.join(' ')); logged.push(a.join(' ')) }
    ok((await retagLatest('0.9.10', SECRET, 'app')) === 'failed', 'x')
    ok(errs.some((e) => /FAIL/i.test(e) && e.includes('0.9.10')), 'no loud error: ' + errs.join('|'))
    ok(logged.length > before, 'nothing logged')
  })
  await t('registry echoing the token in PUT body is... not our concern; token itself never logged on failure paths', async () => {
    for (const o of [{ getThrows: true }, { putThrows: true }, { putStatus: 401 }, { current: '0.9.99' }, { current: null }]) {
      fakeFetch({ current: '0.9.1', ...o } as any)
      await retagLatest('0.9.10', SECRET, 'app')
    }
    const all = logged.join('\n')
    ok(!all.includes(SECRET), 'raw token logged')
    ok(!all.includes(SECRET_B64), 'basic-auth b64 logged')
    ok(!/Basic\s/i.test(all), 'auth header logged')
  })
  await t('fetch itself throwing synchronously/undefined error object does not throw', async () => {
    globalThis.fetch = (() => { throw 'string-error' }) as any
    ok((await retagLatest('0.9.10', SECRET, 'app')) === 'failed', 'x')
  })

  // ── checkImageBuild wiring
  const base = { fetchLatestVersion: async () => '0.9.10', tagExists: async () => false, ensureFlyctl: () => {} }
  process.env.FLY_API_TOKEN = SECRET
  process.env.FLY_SANDBOX_APP = 'app'
  await t('build success -> retag called once with version', async () => {
    const calls: string[] = []
    await checkImageBuild({ ...base, build: async () => {}, retag: async (v) => { calls.push(v) } })
    ok(calls.length === 1 && calls[0] === '0.9.10', JSON.stringify(calls))
  })
  await t('build failure -> no retag, no throw', async () => {
    let n = 0
    await checkImageBuild({ ...base, build: async () => { throw new Error('build broke') }, retag: async () => { n++ } })
    ok(n === 0, 'retag called')
  })
  await t('tag exists -> no build, but :latest is retagged once (manual releases never move it)', async () => {
    let b = 0, r = 0
    await checkImageBuild({ ...base, tagExists: async () => true, build: async () => { b++ }, retag: async () => { r++ } })
    ok(b === 0 && r === 1, `build=${b} retag=${r}`)
  })
  await t('tag exists + retag rejects -> still does not throw', async () => {
    await checkImageBuild({ ...base, tagExists: async () => true, build: async () => {}, retag: async () => { throw new Error('x') } })
  })
  await t('retag rejecting inside checkImageBuild does not throw', async () => {
    await checkImageBuild({ ...base, build: async () => {}, retag: async () => { throw new Error('x') } })
  })

  restore()
  let fail = 0
  for (const [n, p, m] of results) { if (!p) fail++; console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? '  -> ' + m : ''}`) }
  console.log(`\n${results.length - fail}/${results.length} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { restore(); console.error(e); process.exit(1) })
