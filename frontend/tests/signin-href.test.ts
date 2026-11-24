import assert from 'node:assert/strict'
import { sameSitePath, signInHref } from '../src/lib/signin-href'

assert.equal(signInHref('/browser'), '/login?next=%2Fbrowser')
assert.equal(signInHref('/chat?room=a&x=1'), '/login?next=%2Fchat%3Froom%3Da%26x%3D1')

const o = 'https://voice-native.com'
assert.equal(sameSitePath('/chat?room=a&x=1#h', o), '/chat?room=a&x=1#h')
assert.equal(sameSitePath(o + '/library', o), '/library')
assert.equal(sameSitePath(null, o, '/'), '/')
// `/.//evil.com` resolves to the path `//evil.com`, which a browser navigation reads as another host.
for (const bad of ['//evil.com', '/\\evil.com', '\\\\evil.com', '/.//evil.com', '/%2e//evil.com', '/a/..//evil.com',
  '/./\\evil.com', 'https://evil.com/x', 'javascript:alert(1)', '', null, undefined]) {
  assert.equal(sameSitePath(bad, o), '/dashboard', String(bad))
}
console.log('signin-href ok')
