// Run: cd frontend && npx --yes tsx tests/browser-engine.test.ts
// Spec (issue #51): the engine proxy only targets allowlisted endpoints (so the
// panel can't reach dangerous ones like `eval`) and builds control/stream URLs
// correctly: the stream is the engine's per-tab control route, never the public view.
process.env.BROWSER_ENGINE_CONTROL_URL = 'https://eng.example:8781'

import {
  buildControlTarget,
  buildStreamTarget,
  engineTokenConfigured,
  GET_ALLOW,
  POST_ALLOW,
} from '../src/lib/browser-engine'

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

t('stream URL is the per-tab control route and keeps only a numeric tab', () => {
  eq(buildStreamTarget(''), 'https://eng.example:8781/stream', 'own current tab by default')
  eq(buildStreamTarget('?t=5'), 'https://eng.example:8781/stream', 'cache-buster dropped')
  eq(buildStreamTarget('?tab=2&t=5'), 'https://eng.example:8781/stream?tab=2', 'tab kept')
  eq(buildStreamTarget('?tab=x'), 'https://eng.example:8781/stream', 'non-numeric tab dropped')
})

t('engineTokenConfigured reflects whether the engine token is set (#63)', () => {
  const saved = process.env.OSBORN_ENGINE_TOKEN
  delete process.env.OSBORN_ENGINE_TOKEN
  eq(engineTokenConfigured(), false, 'unset → false')
  process.env.OSBORN_ENGINE_TOKEN = '   '
  eq(engineTokenConfigured(), false, 'whitespace-only → false')
  process.env.OSBORN_ENGINE_TOKEN = 'enginesecret'
  eq(engineTokenConfigured(), true, 'set → true')
  if (saved === undefined) delete process.env.OSBORN_ENGINE_TOKEN
  else process.env.OSBORN_ENGINE_TOKEN = saved
})

let failed = 0
for (const [name, pass, err] of results) {
  console.log(`${pass ? '✅' : '❌'} ${name}${err ? ` — ${err}` : ''}`)
  if (!pass) failed++
}
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed) process.exit(1)
