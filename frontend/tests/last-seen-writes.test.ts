// "Last active" in /admin reads instances.last_seen, so connecting to a machine must write it.
// npx tsx frontend/tests/last-seen-writes.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/app/api/sandbox/route.ts', import.meta.url), 'utf8')
const action = (name: string) => { const i = src.indexOf(`case '${name}': {`); return src.slice(i, src.indexOf('\n    case ', i + 10)) }
assert.ok(action('connect-room').includes('touchLastSeen(supabase, user.id)'), 'connecting records activity')
assert.ok(/\.then\(\(\{ error \}\) => \{ if \(error\) console\.warn\([^]*?\(\) => \{\}\)/.test(src.slice(src.indexOf('function touchLastSeen'), src.indexOf('export async function GET'))), 'the write runs (a Supabase builder only sends when thenned), logs a failure, and never fails the request')
console.log('last-seen-writes: ok')
