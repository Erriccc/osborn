// /room-code and /leave-room use the /view-token gate (the owner's token; with none, storeWriteRefusal,
// whose cases agent-store.test.ts covers); /events stays open. npx tsx agent/tests/agent-routes-gate.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
for (const [m, path] of [['GET', '/room-code'], ['POST', '/leave-room']]) {
  const head = `req.method === '${m}' && url.pathname === '${path}') {`
  const i = src.indexOf(head)
  assert.ok(i > src.indexOf('const storeRefused = '), `${path} sits after storeRefused`)
  assert.equal(src.split(`url.pathname === '${path}'`).length - 1, 1, `${path} has one handler, so none can precede the gated one`)
  assert.match(src.slice(i + head.length), /^\s*if \(unauthorized\(\) \|\| storeRefused\(true\)\) return/, `${path}: the gate is the first statement`)
}
const ev = src.indexOf("url.pathname === '/events') {")
assert.ok(ev > 0 && !src.slice(ev, ev + 140).includes('Refused('), '/events stays open (an EventSource sends no header)')

// The cloud proxy sends the Bearer to both routes.
const sb = readFileSync(new URL('../../frontend/src/app/api/sandbox/route.ts', import.meta.url), 'utf8')
for (const p of ['/room-code', '/leave-room']) {
  const call = '}' + p + '`, {'
  assert.equal(sb.split(call).length - 1, 1, `${p}: one call from the sandbox route`)
  const m = sb.slice(sb.indexOf(call) + call.length).match(/^\s*(?:method: 'POST',\s*)?headers: (\w+) \? \{ Authorization: `Bearer \$\{\1\}` \} : \{\},/)
  assert.ok(m && sb.includes(`const ${m[1]} = await getSyncToken()`), `${p} from the sandbox route carries the token`)
}
console.log('agent-routes-gate: ok')
