// /room-code and /leave-room need the owner's token (or, with no token, this machine's own pages);
// /events stays open. npx tsx agent/tests/agent-routes-gate.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { storeWriteRefusal } from '../src/agent-store.js'

const base = { publicDeploy: false, forwarded: false, host: 'localhost:8741', remote: '127.0.0.1', frontendUrl: 'https://voice-native.com', read: true }
const refused = (o: object) => storeWriteRefusal({ hasToken: false, ...base, ...o } as any) !== null

// No sync token (local mode): the checks ownerRouteRefused falls back to.
assert.equal(refused({}), false, "the agent's own curl")
assert.equal(refused({ origin: 'http://localhost:3000' }), false, 'the local frontend page')
assert.equal(refused({ origin: 'https://voice-native.com' }), false, 'the hosted frontend')
assert.equal(refused({ origin: 'https://evil.example' }), true, 'another site in a browser')
assert.equal(refused({ forwarded: true }), true, 'a tunnelled request')
assert.equal(refused({ host: 'm.example.com' }), true, 'a public name')
assert.equal(refused({ remote: '203.0.113.9' }), true, 'a remote address')
assert.equal(refused({ publicDeploy: true }), true, 'a public deploy with no token')

const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
assert.ok(src.includes('const ownerRouteRefused = (): boolean => unauthorized() || (!syncToken && storeRefused(true))'), 'token set: owner Bearer; none: this machine only')
for (const r of ['GET', 'POST']) {
  const path = r === 'GET' ? '/room-code' : '/leave-room'
  const i = src.indexOf(`req.method === '${r}' && url.pathname === '${path}') {`)
  assert.ok(i > 0 && src.slice(i, i + 140).includes('ownerRouteRefused()'), `${path} checks access first`)
}
const ev = src.indexOf("url.pathname === '/events') {")
assert.ok(ev > 0 && !src.slice(ev, ev + 140).includes('Refused()'), '/events stays open (EventSource sends no header)')

// The cloud proxy sends the Bearer to both routes.
const sb = readFileSync(new URL('../../frontend/src/app/api/sandbox/route.ts', import.meta.url), 'utf8')
for (const p of ['/room-code', '/leave-room']) {
  const i = sb.indexOf('}' + p + '`')
  assert.ok(i > 0 && sb.slice(i, i + 200).includes('Authorization: `Bearer'), `${p} from the sandbox route carries the token`)
}
console.log('agent-routes-gate: ok')
