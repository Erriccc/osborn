// Run: cd frontend && npx --yes tsx tests/image-build-retag.test.ts
// Spec (auto-retag of the sandbox image's :latest after a versioned build):
//  - After a SUCCESSFUL `fly deploy --build-only --push --image-label <ver>`,
//    checkImageBuild re-tags <app>:latest to <ver> (registry manifest copy).
//  - Build failure (throw) -> no retag. Tag already exists -> no build, but :latest is
//    still retagged (forward-only): a manual `fly deploy --image-label` release creates
//    the tag without moving :latest, which left it five releases stale on 2026-11-12.
//  - compareVersions: numeric per-segment compare, null for non-versions.
//  - retagLatest copies the manifest byte-for-byte (GET by version, PUT to
//    latest, same Content-Type), forward-only: never moves :latest to an older
//    version than the OSBORN_IMAGE_VERSION it currently points at; unknown
//    current version -> proceed.
//  - Retag failure (HTTP error or network throw) never throws; logs loudly.
import { checkImageBuild, compareVersions, retagLatest } from '../src/lib/image-build-check'

const results: [string, boolean, string?][] = []
async function t(name: string, fn: () => any) {
  try { await fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e?.message ?? e).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }

const errors: string[] = []
const origErr = console.error, origLog = console.log
const origFetch = globalThis.fetch

// ───────────── fake Fly registry ─────────────
type Req = { url: string; method: string; headers: Record<string, string>; body?: Buffer }
const reqs: Req[] = []
const MANIFEST_BODY = '{"schemaVersion":2,  "config":{"digest":"sha256:cfgNEW"}}' // odd spacing: must be copied verbatim
let currentLatestVersion: string | null = '0.9.270'
let latestIsIndex = false
let putStatus = 201
let getVersionStatus = 200
let fetchThrows = false

function installFakeFetch() {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input)
    const method = (init.method || 'GET').toUpperCase()
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]))
    reqs.push({ url, method, headers, body: init.body ? Buffer.from(init.body) : undefined })
    if (fetchThrows) throw new Error('network down')
    const json = (o: any, h: Record<string, string> = {}) =>
      new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json', ...h } })
    const m = url.match(/\/v2\/([^/]+)\/(manifests|blobs)\/(.+)$/)
    if (!m) return new Response('nope', { status: 404 })
    const [, , kind, ref] = m
    if (method === 'PUT') return new Response('', { status: putStatus, headers: { 'docker-content-digest': 'sha256:put' } })
    if (kind === 'manifests' && ref === 'latest') {
      if (currentLatestVersion === null) return new Response('{}', { status: 404 })
      if (latestIsIndex) return json({ manifests: [
        { digest: 'sha256:arm', platform: { architecture: 'arm64' } },
        { digest: 'sha256:amd', platform: { architecture: 'amd64' } },
      ] })
      return json({ config: { digest: 'sha256:cfgOLD' } })
    }
    if (kind === 'manifests' && ref === 'sha256:amd') return json({ config: { digest: 'sha256:cfgOLD' } })
    if (kind === 'blobs' && ref === 'sha256:cfgOLD') return json({ config: { Env: ['PATH=/usr/bin', `OSBORN_IMAGE_VERSION=${currentLatestVersion}`] } })
    if (kind === 'manifests') {
      if (getVersionStatus !== 200) return new Response('missing', { status: getVersionStatus })
      return new Response(MANIFEST_BODY, { status: 200, headers: {
        'content-type': 'application/vnd.oci.image.manifest.v1+json',
        'docker-content-digest': 'sha256:new',
      } })
    }
    return new Response('nope', { status: 404 })
  }) as typeof fetch
}
function reset() {
  reqs.length = 0; errors.length = 0
  currentLatestVersion = '0.9.270'; latestIsIndex = false
  putStatus = 201; getVersionStatus = 200; fetchThrows = false
}
const puts = () => reqs.filter(r => r.method === 'PUT')

async function main() {
  console.error = (...a: any[]) => { errors.push(a.map(String).join(' ')) }
  console.log = () => {}
  installFakeFetch()
  const savedToken = process.env.FLY_API_TOKEN
  const savedApp = process.env.FLY_SANDBOX_APP
  process.env.FLY_API_TOKEN = 'tok-test'
  process.env.FLY_SANDBOX_APP = 'osborn-sandbox3'

  // ── compareVersions ──
  await t('compareVersions: numeric (not lexical) segment compare', () => {
    ok(compareVersions('0.9.272', '0.9.30') === 1, '272 > 30')
    ok(compareVersions('0.9.30', '0.9.272') === -1, '30 < 272')
    ok(compareVersions('0.10.0', '0.9.999') === 1, 'minor bump wins')
    ok(compareVersions('1.0.0', '0.99.99') === 1, 'major bump wins')
  })
  await t('compareVersions: equal, ragged lengths, prefixes/suffixes', () => {
    ok(compareVersions('0.9.272', '0.9.272') === 0, 'equal')
    ok(compareVersions('1.2', '1.2.0') === 0, 'ragged equal')
    ok(compareVersions('v0.9.5', '0.9.4') === 1, 'v prefix')
    ok(compareVersions('0.9.5-beta.1', '0.9.5') === 0, 'prerelease suffix ignored')
  })
  await t('compareVersions: non-versions -> null', () => {
    ok(compareVersions('latest', '0.9.1') === null, 'latest')
    ok(compareVersions('0.9.1', '') === null, 'empty')
    ok(compareVersions('legacy-app-0.9.268', '0.9.1') === null, 'label')
  })

  // ── retagLatest ──
  await t('retagLatest: copies version manifest verbatim to :latest', async () => {
    reset()
    const r = await retagLatest('0.9.272', 'tok-test', 'osborn-sandbox3')
    ok(r === 'retagged', `result ${r}`)
    const p = puts()
    ok(p.length === 1, `puts ${p.length}`)
    ok(p[0].url === 'https://registry.fly.io/v2/osborn-sandbox3/manifests/latest', `put url ${p[0].url}`)
    ok(p[0].body?.toString() === MANIFEST_BODY, 'body not byte-identical')
    ok(p[0].headers['content-type'] === 'application/vnd.oci.image.manifest.v1+json', `ct ${p[0].headers['content-type']}`)
    ok(p[0].headers['authorization'] === 'Basic ' + Buffer.from('x:tok-test').toString('base64'), 'auth header')
    ok(reqs.some(r => r.method === 'GET' && r.url.endsWith('/manifests/0.9.272')), 'GET by version tag')
  })
  await t('retagLatest: never moves :latest backwards', async () => {
    reset(); currentLatestVersion = '0.9.300'
    const r = await retagLatest('0.9.272', 'tok-test', 'osborn-sandbox3')
    ok(r === 'skipped-older', `result ${r}`)
    ok(puts().length === 0, 'PUT happened')
  })
  await t('retagLatest: same version is (idempotently) retagged', async () => {
    reset(); currentLatestVersion = '0.9.272'
    ok(await retagLatest('0.9.272', 'tok-test', 'osborn-sandbox3') === 'retagged', 'not retagged')
  })
  await t('retagLatest: reads version through a multi-arch index (amd64)', async () => {
    reset(); latestIsIndex = true; currentLatestVersion = '0.9.300'
    ok(await retagLatest('0.9.272', 'tok-test', 'osborn-sandbox3') === 'skipped-older', 'index not followed')
    ok(reqs.some(r => r.url.endsWith('/manifests/sha256:amd')), 'amd64 sub-manifest not fetched')
  })
  await t('retagLatest: unknown current version (no :latest) -> proceeds', async () => {
    reset(); currentLatestVersion = null
    ok(await retagLatest('0.9.272', 'tok-test', 'osborn-sandbox3') === 'retagged', 'did not proceed')
  })
  await t('retagLatest: PUT failure does not throw, logs loudly', async () => {
    reset(); putStatus = 401
    const r = await retagLatest('0.9.272', 'tok-test', 'osborn-sandbox3')
    ok(r === 'failed', `result ${r}`)
    ok(errors.some(e => e.includes('RETAG OF :latest FAILED') && e.includes('401')), `errors ${JSON.stringify(errors)}`)
  })
  await t('retagLatest: missing version manifest does not throw, no PUT', async () => {
    reset(); getVersionStatus = 404
    ok(await retagLatest('0.9.272', 'tok-test', 'osborn-sandbox3') === 'failed', 'not failed')
    ok(puts().length === 0, 'PUT happened')
  })
  await t('retagLatest: network throw does not throw', async () => {
    reset(); fetchThrows = true
    ok(await retagLatest('0.9.272', 'tok-test', 'osborn-sandbox3') === 'failed', 'not failed')
    ok(errors.some(e => e.includes('RETAG OF :latest FAILED')), 'not logged')
  })
  await t('retagLatest: never logs the token', async () => {
    reset(); putStatus = 500
    await retagLatest('0.9.272', 'tok-test', 'osborn-sandbox3')
    ok(!errors.some(e => e.includes('tok-test')), 'token leaked into logs')
  })

  // ── checkImageBuild orchestration ──
  const steps: string[] = []
  const deps = (o: { exists?: boolean; buildThrows?: boolean; retagThrows?: boolean } = {}) => ({
    fetchLatestVersion: async () => { steps.push('version'); return '0.9.273' },
    tagExists: async () => { steps.push('exists'); return !!o.exists },
    ensureFlyctl: () => { steps.push('flyctl') },
    build: async (v: string, app: string) => { steps.push(`build:${v}:${app}`); if (o.buildThrows) throw new Error('fly deploy exited with status 1') },
    retag: async (v: string, tok: string, app: string) => { steps.push(`retag:${v}:${tok}:${app}`); if (o.retagThrows) throw new Error('boom') },
  })
  await t('checkImageBuild: successful build -> retag :latest to that version', async () => {
    reset(); steps.length = 0
    await checkImageBuild(deps())
    ok(steps.join(',') === 'version,exists,flyctl,build:0.9.273:osborn-sandbox3,retag:0.9.273:tok-test:osborn-sandbox3', steps.join(','))
  })
  await t('checkImageBuild: build failure -> no retag, no throw', async () => {
    reset(); steps.length = 0
    await checkImageBuild(deps({ buildThrows: true }))
    ok(!steps.some(s => s.startsWith('retag')), 'retag ran after failed build')
    ok(errors.some(e => e.includes('fly deploy exited')), 'build failure not logged')
  })
  await t('checkImageBuild: tag already exists -> no build, :latest still retagged', async () => {
    reset(); steps.length = 0
    await checkImageBuild(deps({ exists: true }))
    ok(!steps.some(s => s.startsWith('build') || s.startsWith('flyctl')), steps.join(','))
    ok(steps.join(',') === 'version,exists,retag:0.9.273:tok-test:osborn-sandbox3', steps.join(','))
  })
  await t('checkImageBuild: a throwing retag still never throws out', async () => {
    reset(); steps.length = 0
    await checkImageBuild(deps({ retagThrows: true }))
    ok(steps.some(s => s.startsWith('retag')), 'retag not called')
  })
  await t('checkImageBuild: real retagLatest failure after build does not throw', async () => {
    reset(); steps.length = 0; putStatus = 500
    const d: any = deps(); delete d.retag
    await checkImageBuild(d)
    ok(errors.some(e => e.includes('RETAG OF :latest FAILED')), `errors ${JSON.stringify(errors)}`)
  })

  globalThis.fetch = origFetch
  if (savedToken === undefined) delete process.env.FLY_API_TOKEN; else process.env.FLY_API_TOKEN = savedToken
  if (savedApp === undefined) delete process.env.FLY_SANDBOX_APP; else process.env.FLY_SANDBOX_APP = savedApp
  console.error = origErr; console.log = origLog

  let fail = 0
  for (const [n, p, m] of results) { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? '\n      ' + m : ''}`); if (!p) fail++ }
  console.log(`\n${results.length - fail}/${results.length} passed`)
  process.exit(fail ? 1 : 0)
}
main()
