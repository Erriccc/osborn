// Run: npx tsx tests/voice-e2e/lib/devtools.test.ts
import assert from 'node:assert'
import { redactSecrets } from './devtools'

const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJtZXRhZGF0YSI6IntcInByb3Zp.c2lnbmF0dXJlLXZhbHVl'
assert.equal(redactSecrets(`[ws open] wss://x.livekit.cloud/rtc?access_token=${jwt}&auto_subscribe=1`),
  '[ws open] wss://x.livekit.cloud/rtc?access_token=[redacted]&auto_subscribe=1', 'a room URL keeps no token')
assert.equal(redactSecrets(`Authorization: Bearer ${jwt}`), 'Authorization: Bearer [redacted-jwt]', 'a bare JWT is blanked')
assert.equal(redactSecrets('https://a.b/c?apikey=abc123&x=1'), 'https://a.b/c?apikey=[redacted]&x=1', 'api keys in queries are blanked')
assert.equal(redactSecrets('https://x.com/auth/callback#refresh_token=v1abcdef&type=magiclink'), 'https://x.com/auth/callback#refresh_token=[redacted]&type=magiclink', 'tokens in a URL fragment are blanked')
assert.equal(redactSecrets('[403] GET https://www.voice-native.com/api/admin/users'), '[403] GET https://www.voice-native.com/api/admin/users', 'ordinary lines are unchanged')
console.log('devtools redaction: all assertions passed')
