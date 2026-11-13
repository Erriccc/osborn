// Library on session end: npx tsx agent/tests/library-session-end.test.ts
import assert from 'node:assert/strict'

delete process.env.OPENROUTER_API_KEY
delete process.env.OSBORN_SYNC_TOKEN
const { launchLibraryOnSessionEnd, libraryStatus } = await import('../src/content/lens-launch.js')

assert.equal(launchLibraryOnSessionEnd(null, '/w', 'disconnect'), null, 'no session, nothing to do')
const r = launchLibraryOnSessionEnd('abcdef12-0000', '/w', 'disconnect')!
assert.equal(r.status, 'no-key', 'a missing key is reported, not hidden')
const st = libraryStatus()
assert.equal(st.openrouterKey, false); assert.equal(st.syncToken, false)
assert.deepEqual({ sid: st.lastRun?.sessionId, why: st.lastRun?.reason }, { sid: 'abcdef12-0000', why: 'disconnect' })
console.log('library-session-end: all assertions passed')
