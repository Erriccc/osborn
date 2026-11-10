// Run: cd frontend && npx --yes tsx tests/browser-engine.test.ts
// Spec (issue #51): the engine proxy only targets allowlisted endpoints (so the
// panel can't reach dangerous ones like `eval`), builds control/stream URLs
// correctly, and appends the stream key without leaking it into control URLs.
process.env.BROWSER_ENGINE_CONTROL_URL = 'https://eng.example:8781'
process.env.BROWSER_ENGINE_STREAM_URL = 'https://eng.example'
process.env.OSBORN_STREAM_TOKEN = 'streamsecret'

import { buildControlTarget, buildStreamTarget, GET_ALLOW, POST_ALLOW } from '../src/lib/browser-engine'

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 300)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(a === b, `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

t('GET allowlist builds the control URL', () => {
  eq(buildControlTarget('GET', 'status'), 'https://eng.example:8781/status', 'status')
  eq(buildControlTarget('GET', 'tasks', '?n=2'), 'https://eng.example:8781/tasks?n=2', 'tasks w/ qs')
})

t('POST allowlist builds the control URL', () => {
  eq(buildControlTarget('POST', 'act'), 'https://eng.example:8781/act', 'act')
  eq(buildControlTarget('POST', 'end'), 'https://eng.example:8781/end', 'end')
})

t('non-allowlisted / wrong-method actions are rejected', () => {
  eq(buildControlTarget('GET', 'eval'), null, 'eval blocked (arbitrary JS)')
  eq(buildControlTarget('GET', 'brain'), null, 'brain blocked')
  eq(buildControlTarget('POST', 'status'), null, 'status is GET-only')
  eq(buildControlTarget('GET', 'act'), null, 'act is POST-only')
  eq(buildControlTarget('GET', '../secret'), null, 'path traversal blocked')
})

t('allowlists exclude the dangerous endpoints', () => {
  for (const bad of ['eval', 'brain', 'journey']) {
    ok(!GET_ALLOW.has(bad) && !POST_ALLOW.has(bad), `${bad} must not be proxyable`)
  }
})

t('stream URL appends the key; control URLs never carry it', () => {
  eq(buildStreamTarget(''), 'https://eng.example/stream?key=streamsecret', 'stream w/ key')
  ok(buildStreamTarget('?t=5').includes('t=5'), 'stream preserves caller qs')
  ok(buildStreamTarget('?t=5').includes('key=streamsecret'), 'stream still has key')
  ok(!String(buildControlTarget('GET', 'status')).includes('streamsecret'), 'control URL has no stream key')
})

let failed = 0
for (const [name, pass, err] of results) {
  console.log(`${pass ? '✅' : '❌'} ${name}${err ? ` — ${err}` : ''}`)
  if (!pass) failed++
}
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed) process.exit(1)
