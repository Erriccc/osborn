// Library on session end: npx tsx agent/tests/library-session-end.test.ts
import assert from 'node:assert/strict'

delete process.env.OPENROUTER_API_KEY
const { launchLibraryOnSessionEnd, lastLibraryRun } = await import('../src/content/lens-launch.js')

assert.equal(launchLibraryOnSessionEnd(null, '/w', 'disconnect'), null, 'no session, nothing to do')
const r = launchLibraryOnSessionEnd('abcdef12-0000-full-uuid', '/w', 'disconnect')!
assert.equal(r.status, 'no-key', 'a missing key is reported, not hidden')
assert.deepEqual({ s: lastLibraryRun()?.session, why: lastLibraryRun()?.reason }, { s: 'abcdef12', why: 'disconnect' }, 'only 8 chars of the id are kept (it is shown on public /health)')
console.log('library-session-end: all assertions passed')
