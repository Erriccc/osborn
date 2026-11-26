// /room-code and /leave-room use the /view-token gate (the owner's token; with none, storeWriteRefusal,
// whose cases agent-store.test.ts covers); /events stays open. npx tsx agent/tests/agent-routes-gate.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
for (const [m, path] of [['GET', '/room-code'], ['POST', '/leave-room']]) {
  const i = src.indexOf(`req.method === '${m}' && url.pathname === '${path}') {`)
  assert.ok(i > src.indexOf('const storeRefused = '), `${path} sits after storeRefused`)
  assert.ok(src.slice(i, i + 140).includes('if (unauthorized() || storeRefused(true)) return'), `${path} checks access first`)
}
const ev = src.indexOf("url.pathname === '/events') {")
assert.ok(ev > 0 && !src.slice(ev, ev + 140).includes('Refused('), '/events stays open (an EventSource sends no header)')

// The cloud proxy sends the Bearer to both routes.
const sb = readFileSync(new URL('../../frontend/src/app/api/sandbox/route.ts', import.meta.url), 'utf8')
for (const p of ['/room-code', '/leave-room']) {
  const i = sb.indexOf('}' + p + '`')
  assert.ok(i > 0 && sb.slice(i, i + 200).includes('Authorization: `Bearer'), `${p} from the sandbox route carries the token`)
}
console.log('agent-routes-gate: ok')
