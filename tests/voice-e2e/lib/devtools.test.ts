// Run: npx tsx tests/voice-e2e/lib/devtools.test.ts
import assert from 'node:assert'
import { redactDiagnostics } from './devtools'

const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJtZXRhZGF0YSI6IntcInByb3Zp.c2lnbmF0dXJlLXZhbHVl'
assert.equal(redactDiagnostics(`[ws open] wss://x.livekit.cloud/rtc?access_token=${jwt}&auto_subscribe=1`),
  '[ws open] wss://x.livekit.cloud/rtc?access_token=[redacted]&auto_subscribe=1', 'a room URL keeps no token')
assert.equal(redactDiagnostics(`Authorization: Bearer ${jwt}`), 'Authorization: Bearer [redacted-jwt]', 'a bare JWT is blanked')
assert.equal(redactDiagnostics('https://a.b/c?apikey=abc123&x=1'), 'https://a.b/c?apikey=[redacted]&x=1', 'api keys in queries are blanked')
assert.equal(redactDiagnostics('https://x.com/auth/callback#refresh_token=v1abcdef&type=magiclink'), 'https://x.com/auth/callback#refresh_token=[redacted]&type=magiclink', 'tokens in a URL fragment are blanked')
assert.equal(redactDiagnostics('[403] GET https://www.voice-native.com/api/admin/users'), '[403] GET https://www.voice-native.com/api/admin/users', 'ordinary lines are unchanged')
assert.equal(redactDiagnostics('Authorization: Bearer abcdefgh12345678'), 'Authorization: Bearer [redacted]', 'opaque bearer tokens are blanked')
assert.equal(redactDiagnostics('key sk-ant-api03-abcdefghij'), 'key [redacted-key]', 'known key prefixes are blanked')
assert.ok(!redactDiagnostics('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ').includes('eyJzdWIi'), 'a truncated JWT is blanked')
console.log('devtools redaction: all assertions passed')
