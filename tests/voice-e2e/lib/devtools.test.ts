import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { attachDevtools, redactDiagnostics } from './devtools'

// Fake values only. Every credential shape the stack prints is hidden (#322, #325).
const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXBhcnQ'
for (const [line, secret] of [
  [`[ws open] wss://x.livekit.cloud/rtc?access_token=${jwt}&auto_subscribe=1`, 'eyJzdWIi'],
  [`Authorization: Bearer ${jwt}`, 'eyJzdWIi'],
  ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ', 'eyJzdWIi'],
  ['https://a.b/c?apikey=abc123&x=1', 'abc123'],
  ['https://x.com/auth/callback#refresh_token=v1abcdef&type=magiclink', 'v1abcdef'],
  ['https://a.b/c?session_token=zz9988776655&x=1', 'zz9988776655'],
  ['Authorization: Bearer abcdefgh12345678', 'abcdefgh12345678'],
  ['Authorization: Bearer abcdefghijklmnop', 'abcdefghijklmnop'],
  ['Authorization: Token dg1234567890abcdef', 'dg1234567890abcdef'],
  ['Authorization: Basic dXNlcjpwYXNzMTIzNDU2', 'dXNlcjpwYXNzMTIzNDU2'],
  ['key sk-ant-api03-abcdefghijklmnopqrstuv', 'abcdefghijklmnopqrstuv'],
  ['LIVEKIT_API_SECRET=abcDEF1234567890', 'abcDEF1234567890'],
  ['DB_PASSWORD=correcthorsebatterystaple', 'correcthorsebatterystaple'],
  ['key AIzaSyA1234567890abcdefghijABCDEFGHIJ', 'SyA1234567890abcdefghij'],
  ['ghs_1234567890abcdefABCDEF1234567890abcd', '1234567890abcdefABCDEF'],
  ['FlyV1 fm2_lJPECAAAAAAAB1234567890abcdefgh', 'lJPECAAAAAAAB1234567'],
  ['xoxb-1234567890-abcdefghij', '1234567890-abcdefghij'],
]) assert.ok(!redactDiagnostics(line).includes(secret), `blanked: ${line}`)

// Debugging text stays readable.
for (const prose of [
  '[403] GET https://www.voice-native.com/api/admin/users', 'Token refreshed successfully', 'token: undefined',
  '[error] Error refreshing token: Unauthorized', 'Failed to load secret: NetworkError', 'AuthorizationFailed123',
  '[404] GET https://x.com/ghs_installation_cache/item', 'Token 2026-11-16T10:00:00Z expired', 'TOKEN=$LIVEKIT_TOKEN',
]) assert.equal(redactDiagnostics(prose), prose, `kept: ${prose}`)

// One redactor: the engine's copy must match the app's (the harness build copies it).
const app = new URL('../../../frontend/src/lib/redactSecrets.ts', import.meta.url)
const copy = new URL('./redactSecrets.ts', import.meta.url)
try { assert.equal(readFileSync(copy, 'utf8'), readFileSync(app, 'utf8'), 'lib/redactSecrets.ts is stale: run node frontend/scripts/build-harness-bundle.mjs') }
catch (e: any) { if (e.code !== 'ENOENT') throw e }  // an installed harness has no frontend/
// since(ms): only lines recorded at or after a moment (a person's takeover), also after the cap drops old ones.
const fakePage = new EventEmitter() as any
const buf = attachDevtools(fakePage, 3)
fakePage.emit('console', { type: () => 'log', text: () => 'before takeover' })
const cut = Date.now() + 1
while (Date.now() < cut) { /* next millisecond */ }
for (const t of ['after 1', 'after 2', 'after 3']) fakePage.emit('console', { type: () => 'log', text: () => t })
assert.equal(buf.console.length, 3, 'capped')
assert.deepEqual(buf.since(cut).console.map((l) => l.slice(9)), ['[log] after 1', '[log] after 2', '[log] after 3'])
fakePage.emit('console', { type: () => 'log', text: () => 'after 4' })
assert.deepEqual(buf.since(cut).console.map((l) => l.slice(9)), ['[log] after 2', '[log] after 3', '[log] after 4'], 'times stay aligned when the cap shifts')
assert.deepEqual(buf.since(Date.now() + 60000).console, [], 'nothing from the future')
console.log('devtools redaction: all assertions passed')
