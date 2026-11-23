// "Last active" in /admin reads instances.last_seen, so connecting to a machine must write it.
// npx tsx frontend/tests/last-seen-writes.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { touchLastSeen } from '../src/lib/last-seen'

const rd = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')
const src = readFileSync(new URL('../src/app/api/sandbox/route.ts', import.meta.url), 'utf8')
const action = (name: string) => { const i = src.indexOf(`case '${name}': {`); return src.slice(i, src.indexOf('\n    case ', i + 10)) }
assert.ok(action('connect-room').includes('touchLastSeen(supabase, user.id)'), 'connecting records activity')
assert.ok(/\.then\(\(\{ error \}\) => \{ if \(error\) console\.warn\([^]*?\(\) => \{\}\)/.test(rd('../src/lib/last-seen.ts')), 'the write runs (a Supabase builder only sends when thenned), logs a failure, and never fails the request')
assert.ok(!src.includes("case 'keepalive'"), 'the unsent keepalive action is gone')
assert.ok(/if \(r\.ok\) touchLastSeen\(admin, userId\)/.test(rd('../src/lib/phone-calls.ts')), 'a phone call that reaches the agent records activity')

const calls: any[] = []
const client: any = { from: (t: string) => ({ update: (v: any) => ({ eq: (c: string, id: string) => { calls.push({ t, v, c, id }); return Promise.resolve({ error: { message: 'boom' } }) } }) }) }
touchLastSeen(client, 'u1')
assert.equal(calls.length, 1) // the write is made synchronously
assert.deepEqual([calls[0].t, calls[0].c, calls[0].id], ['instances', 'user_id', 'u1'])
assert.ok(!Number.isNaN(Date.parse(calls[0].v.last_seen)))
console.log('last-seen-writes: ok')
