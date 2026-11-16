import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { redactDiagnostics } from './devtools'

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
console.log('devtools redaction: all assertions passed')
