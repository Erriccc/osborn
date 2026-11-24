import assert from 'node:assert/strict'
import { signInHref } from '../src/lib/signin-href'

assert.equal(signInHref('/browser'), '/login?next=%2Fbrowser')
assert.equal(signInHref('/chat?room=a&x=1'), '/login?next=%2Fchat%3Froom%3Da%26x%3D1')
for (const bad of ['//evil.com', 'https://x.com', '/\\evil', 'javascript:1', '', null, undefined]) {
  assert.equal(signInHref(bad as string), '/login?next=%2Fdashboard', String(bad))
}
console.log('signin-href ok')
