// Run: cd frontend && npx --yes tsx tests/sandbox-poll.test.ts
// One failed or cached /api/sandbox poll must not flip the machine's shown state,
// and cloud mode must not reach for the localhost default before the machine's URL arrives.
import assert from 'node:assert'
import { readSandboxPoll } from '../src/lib/sandbox-poll'
import { awaitingCloudUrl, isLocalAgentUrl } from '../src/lib/agent-read'

const running = { id: 'osborn-3', status: 'running', previewUrl: 'https://osborn-3.fly.dev' }
assert.deepEqual(readSandboxPoll(true, { available: true, sandbox: running }), { available: true, sandbox: running })
assert.deepEqual(readSandboxPoll(true, { available: true, sandbox: null }), { available: true, sandbox: null }, 'a confirmed-gone machine is news')
assert.equal(readSandboxPoll(true, { available: true, sandbox: { ...running, status: 'stopped' }, cached: true }), null, 'the DB row after a failed Fly lookup')
assert.equal(readSandboxPoll(false, { error: 'Sandbox ownership check unavailable' }), null, '503')
assert.equal(readSandboxPoll(false, { error: 'Not authenticated' }), null, '401')
assert.equal(readSandboxPoll(true, null), null, 'unparseable body')

assert.equal(awaitingCloudUrl('http://localhost:8741', 'cloud'), true)
assert.equal(awaitingCloudUrl('', 'cloud'), true)
assert.equal(awaitingCloudUrl('https://osborn-3.fly.dev', 'cloud'), false)
assert.equal(awaitingCloudUrl('http://localhost:8741', 'local'), false, 'local mode talks to localhost on purpose')
assert.equal(isLocalAgentUrl('http://127.0.0.1:8741'), true)
console.log('sandbox-poll: all assertions passed')
