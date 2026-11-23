// /canvas-token hands out a listener credential for the whole room, so it needs the live meeting's key,
// and the Claude sign-in token reaches only the controlling user. npx tsx agent/tests/canvas-key.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { newCanvasKey, secretMatches, withCanvasKey } from '../src/canvas-key.js'

const k = newCanvasKey()
assert.equal(k.length, 36, 'a long random key')
assert.notEqual(k, newCanvasKey(), 'a new key per meeting')
assert.equal(secretMatches(k, k), true)
assert.equal(secretMatches(k, k.slice(0, -1) + (k.endsWith('a') ? 'b' : 'a')), false, 'a wrong key')
assert.equal(secretMatches(k, ''), false)
assert.equal(secretMatches(k, null), false)
assert.equal(secretMatches(k, 'x'), false, 'a different length')
assert.equal(secretMatches(null, 'anything'), false, 'no live meeting: nothing matches')
assert.equal(secretMatches('', ''), false, 'an empty key never matches')

// The key reaches every meeting-canvas cast URL, including the one the chat's Join button builds.
const keyOf = (u?: string) => new URL(u!).searchParams.get('k')
const agent = encodeURIComponent('https://m.fly.dev')
assert.equal(keyOf(withCanvasKey(`https://app.example/meeting-canvas?agent=${agent}`, k)), k, 'the frontend-built cast URL')
assert.equal(new URL(withCanvasKey(`https://app.example/meeting-canvas?agent=${agent}`, k)!).searchParams.get('agent'), 'https://m.fly.dev', 'agent kept')
assert.equal(keyOf(withCanvasKey(`https://app.example/meeting-canvas?agent=${agent}&k=old`, k)), k, 'a stale key is replaced')
assert.equal(withCanvasKey('https://example.com/some-page', k), 'https://example.com/some-page', 'another page gets no key')
assert.equal(withCanvasKey(undefined, k), undefined)
assert.equal(withCanvasKey('not a url', k), 'not a url')

const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const route = src.slice(src.indexOf("url.pathname === '/canvas-token'"))
assert.ok(route.slice(0, 600).includes("secretMatches(canvasKey, url.searchParams.get('k'))"), 'the route checks the key before minting')
assert.ok(route.slice(0, 600).indexOf('secretMatches') < route.slice(0, 900).indexOf('canvasTokenHook'), 'the check comes before the hook')
assert.ok(/canvasKey = newCanvasKey\(\)\s+const castUrl = withCanvasKey\(/.test(src), 'a new key is minted into the cast URL when a meeting is joined')
const end = src.indexOf('const endMeeting = async')
assert.ok(src.slice(end, end + 300).includes('canvasKey = null'), 'the key dies with the meeting')

// Every claude-auth.ts callback goes through sendAuthEvent, which keeps the token off the broadcast.
const helper = src.slice(src.indexOf('function sendAuthEvent('), src.indexOf('function sendAuthEvent(') + 400)
assert.ok(helper.includes('const { token, ...rest }') && helper.includes('void send({ type, ...rest })'), 'the broadcast never carries the token')
assert.ok(helper.includes('send({ type, ...rest, token }, controllingUserIdentity)'), 'the token goes only to the controller')
assert.ok(src.includes('ensureClaudeAuth(sendAuthEvent)'), 'join path')
assert.ok(src.includes('replayInFlightAuth(sendAuthEvent)'), 'replay on TrackSubscribed')
assert.ok(src.includes('const authSend = (type: string, payload: unknown) => sendAuthEvent(type, payload, sendToFrontend)'), 'claude_auth_start path')
assert.equal((src.match(/(ensureClaudeAuth|replayInFlightAuth|startClaudeAuthOnDemand)\(\(/g) ?? []).length, 0, 'no auth callback bypasses sendAuthEvent')

const page = readFileSync(new URL('../../frontend/src/app/meeting-canvas/page.tsx', import.meta.url), 'utf8')
assert.equal((page.match(/canvas-token\?k=\$\{encodeURIComponent\(params\.get\('k'\)/g) ?? []).length, 2, 'both canvas-token fetches send the page key')
assert.ok(/sendToFrontend\(\{ type: 'ide_ready', url: ideUrl \}, opts\.sender\)/.test(src), 'the editor token URL goes only to the requester')
const join = src.slice(src.indexOf('Recall.ai join error'), src.indexOf('Recall.ai join error') + 200)
assert.ok(join.includes('canvasKey = null'), 'a failed join leaves no live key')
const rc = readFileSync(new URL('../src/recall-client.ts', import.meta.url), 'utf8')
assert.ok(!/\$\{opts(\?|!)?\.castUrl\}/.test(rc), 'the recall client never logs the raw cast URL (it carries the key)')
console.log('canvas-key: ok')
