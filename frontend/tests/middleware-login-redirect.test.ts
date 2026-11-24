import assert from 'node:assert/strict'
import { sameSitePath } from '../src/lib/signin-href'

// The middleware redirects a signed-in visitor on /login to this target.
const o = 'https://voice-native.com'
const target = (next: string | null) => new URL(sameSitePath(next, o, '/dashboard'), o)
assert.equal(target('/chat?session=abc&x=1').pathname + target('/chat?session=abc&x=1').search, '/chat?session=abc&x=1')
assert.equal(target(null).pathname, '/dashboard')
for (const bad of ['//evil.com', '/\\evil.com', '\\\\evil.com', '/.//evil.com', '/%2e//evil.com', '/a/..//evil.com',
  '/./\\evil.com', 'https://evil.com/x', 'javascript:alert(1)', '', null]) {
  assert.equal(target(bad).origin, o, String(bad))
  assert.equal(target(bad).pathname, '/dashboard', String(bad))
}
console.log('middleware-login-redirect ok')
