// Voice dispatch: project name -> session, the hub-only dispatch tool, and spoke reports never steering a turn.
// Run: npx tsx agent/tests/dispatch-resolve.test.ts
import assert from 'node:assert/strict'
import { SlotRegistry } from '../src/slot-manager.js'
import { dispatchServers } from '../src/dispatch-tool.js'
import { DISPATCH_TOOL, DISPATCH_SERVER, DISPATCH_TOOL_NAME, dispatchFieldsOk, dispatchCallRefusal, resolveDispatchTarget, spokePhoneNotice } from '../src/dispatch.js'
import { getSpokeReport } from '../src/prompts.js'
import { steersTurn } from '../src/content/transcript-sanitizer.js'
import { describePermission, speakablePermission } from '../src/approval-policy.js'
import { classifyRisk } from '../src/risk-tier.js'
import { readFileSync } from 'node:fs'

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}
const s = (sessionId: string, cwd: string, day: number) => ({ sessionId, cwd, timestamp: new Date(2026, 10, day) })
const sessions = [s('old-osborn', '/work/osborn', 1), s('new-osborn', '/work/osborn', 5), s('audos-1', '/work/audos-com', 3), s('web-a', '/a/web', 2), s('web-b', '/b/web', 4)]
const free = (focused: string | null = null, slotState: 'none' | 'idle' | 'busy' = 'none', slots = new SlotRegistry({ max: 2, foregroundId: () => focused })) =>
  ({ seat: (id: string) => slots.admit(id), slotState: () => slotState, dirExists: (c: string) => c !== '/gone/osborn', now: Date.UTC(2026, 11, 1) })

t('matches by folder name, newest session wins, case and punctuation ignored', () => {
  const r = resolveDispatchTarget('Osborn', sessions, free())
  assert.equal(r.ok, true); assert.equal(r.sessionId, 'new-osborn'); assert.equal(r.cwd, '/work/osborn')
  assert.equal(resolveDispatchTarget('audos com', sessions, free()).sessionId, 'audos-1')
})
t('an unknown project, an empty name and two folders with the name are refused', () => {
  assert.match(resolveDispatchTarget('nope', sessions, free()).error!, /no session found/)
  assert.equal(resolveDispatchTarget('  ', sessions, free()).ok, false)
  const amb = resolveDispatchTarget('web', sessions, free())
  assert.equal(amb.ok, false); assert.match(amb.error, /\/a\/web/)
})
t('the focused session is refused', () => {
  const r = resolveDispatchTarget('osborn', sessions, free('new-osborn'))
  assert.equal(r.ok, false); assert.match(r.error!, /foreground/)
})
t('a full slot cap and a busy existing slot are refused; an idle one is reused', () => {
  const full = new SlotRegistry({ max: 1 }); full.add({ id: 'x', llm: {}, isFocused: false, workingDir: '/w' })
  assert.equal(resolveDispatchTarget('osborn', sessions, free(null, 'none', full)).ok, false)
  const mine = new SlotRegistry({ max: 2 }); mine.add({ id: 'new-osborn', llm: {}, isFocused: false, workingDir: '/w' })
  assert.equal(resolveDispatchTarget('osborn', sessions, free(null, 'busy', mine)).ok, false)
  assert.equal(resolveDispatchTarget('osborn', sessions, free(null, 'idle', mine)).ok, true)
})

t('a [NOTIFICATION] never steers a turn, like [MEETING and [SYSTEM; a user turn does', () => {
  for (const p of ['[NOTIFICATION] x', '[MEETING — b]: x', '[SYSTEM] x']) assert.equal(steersTurn(p), false, p)
  assert.equal(steersTurn('have osborn fix it'), true)
  assert.equal(steersTurn(getSpokeReport({ project: 'p', sessionId: 'abcdef123', status: 'done', summary: 'ok' })), false)
})
t('folders that no longer exist are dropped before the ambiguity check; a session active moments ago is refused', () => {
  const gone = [...sessions, s('web-gone', '/gone/osborn', 9)]
  assert.equal(resolveDispatchTarget('osborn', gone, free()).sessionId, 'new-osborn')
  const slots = new SlotRegistry({ max: 2 })
  const now = Date.UTC(2026, 11, 1)
  const fresh = [{ sessionId: 'live', cwd: '/w/live', timestamp: new Date(now - 60_000) }]
  assert.equal(resolveDispatchTarget('live', fresh, { ...free(null, 'none', slots), now }).ok, false)
  const calm = [{ sessionId: 'live', cwd: '/w/live', timestamp: new Date(now - 10 * 60_000) }]
  assert.equal(resolveDispatchTarget('live', calm, { ...free(null, 'none', slots), now }).ok, true)
  slots.add({ id: 'live', llm: {}, isFocused: false, workingDir: '/w' })
  assert.equal(resolveDispatchTarget('live', fresh, { ...free(null, 'idle', slots), now }).ok, true, 'our own slot writing it is fine')
})
t('the dispatch tool shows all of what will be sent, tells the phone the rest is in the app, and is high risk', () => {
  assert.equal(DISPATCH_TOOL, `mcp__${DISPATCH_SERVER}__${DISPATCH_TOOL_NAME}`)
  const long = 'x'.repeat(1900)
  const input = { project: 'osborn', instruction: long }
  assert.equal(describePermission(DISPATCH_TOOL, input), `Start a background session in osborn: ${long}\nThe new session runs without asking you again.`, 'the card shows everything that runs')
  const spoken = speakablePermission(DISPATCH_TOOL, input)
  assert.match(spoken, /^start a background session in osborn: x+… and more; the full text is in the app\. The new session runs without asking you again$/)
  assert.ok(spoken.length < 300)
  assert.equal(speakablePermission(DISPATCH_TOOL, { project: 'p', instruction: 'short' }), 'start a background session in p: short. The new session runs without asking you again')
  assert.equal(classifyRisk(DISPATCH_TOOL, input), 'high', 'auto-review asks')
})
t('control, bidi and C1 characters are refused; newline and tab are fine; the instruction is at most 2000', () => {
  assert.equal(dispatchFieldsOk('osborn', 'fix\nthe\ttypo'), true)
  for (const c of ['\u0000', '\u202e', '\u0085', '\u009b', '\u200f', '\u2067', '\u001b', '\u007f']) {
    assert.equal(dispatchFieldsOk('osborn', `a${c}b`), false, JSON.stringify(c))
    assert.equal(dispatchFieldsOk(`a${c}`, 'b'), false, JSON.stringify(c))
  }
  assert.equal(dispatchFieldsOk('', 'x'), false); assert.equal(dispatchFieldsOk('p', '  '), false); assert.equal(dispatchFieldsOk(1, 'x'), false)
  assert.equal(dispatchFieldsOk('p'.repeat(101), 'x'), false); assert.equal(dispatchFieldsOk('p', 'x'.repeat(2000)), true); assert.equal(dispatchFieldsOk('p', 'x'.repeat(2001)), false)
})
t('the hub\'s tool server is a fresh instance per query with the one tool, and its handler forwards the input', async () => {
  const sent: string[][] = []
  const hubTools = dispatchServers(async (p, i) => { sent.push([p, i]); return 'ok' })
  const hub = hubTools()
  assert.deepEqual(Object.keys(hub), [DISPATCH_SERVER])
  const inst = (hub[DISPATCH_SERVER] as any).instance
  assert.deepEqual(Object.keys(inst._registeredTools), [DISPATCH_TOOL_NAME])
  assert.notEqual((hubTools()[DISPATCH_SERVER] as any).instance, inst, 'a new instance for every query')
  const res = await inst._registeredTools[DISPATCH_TOOL_NAME].handler({ project: 'osborn', instruction: 'x' }, {})
  assert.equal(res.content[0].text, 'ok'); assert.deepEqual(sent, [['osborn', 'x']])
})
t('a sub-agent cannot dispatch; the main agent and other tools are not affected', () => {
  assert.match(dispatchCallRefusal(DISPATCH_TOOL, 'writer')!, /sub-agent/)
  assert.equal(dispatchCallRefusal(DISPATCH_TOOL, null), null)
  assert.equal(dispatchCallRefusal('Bash', 'writer'), null)
})
t('what goes to the phone has secrets redacted and a bounded length', () => {
  const key = 'sk-ant-api03-' + 'A1b2C3d4'.repeat(8)
  const n = spokePhoneNotice('osborn', 'done', `used ${key} to deploy`)
  assert.ok(!n.includes(key) && n.startsWith('osborn done: '), n)
  assert.ok(spokePhoneNotice('osborn', 'done', 'y'.repeat(900)).length < 330)
  assert.match(spokePhoneNotice('osborn', 'stopped', 'x'), /stopped/)
})
t('a typed message that merely starts with [SYSTEM or [MEETING still steers; injected notes do not', () => {
  for (const typed of ['[SYSTEM design] fix login', '[MEETING notes] summarize', '[NOTIFICATIONS] on', 'fix the bug']) assert.equal(steersTurn(typed), true, typed)
  for (const injected of ['[SYSTEM] note', '[SYSTEM — SILENT CONTROL MESSAGE] x', '[SYSTEM: x]', '[MEETING — bot1]:\nhi', '[NOTIFICATION] Spoke report']) assert.equal(steersTurn(injected), false, injected)
})
t('a follow-up to a session our freed slot just wrote is not refused as live elsewhere', () => {
  const now = Date.UTC(2026, 11, 1)
  const wrote = [{ sessionId: 'w', cwd: '/w/proj', timestamp: new Date(now - 30_000) }]
  const base = free()
  assert.equal(resolveDispatchTarget('proj', wrote, { ...base, now }).ok, false)
  assert.equal(resolveDispatchTarget('proj', wrote, { ...base, now, ownWriteAt: () => now - 29_000 }).ok, true)
  assert.equal(resolveDispatchTarget('proj', wrote, { ...base, now, ownWriteAt: () => now - 120_000 }).ok, false, 'a later write is not ours')
})
t('the pipeline fast brain is skipped for every no-steer turn', () => {
  assert.match(readFileSync(new URL('../src/pipeline-direct-llm.ts', import.meta.url), 'utf-8'), /userText\.trim\(\) && steersTurn\(userText\)\) \{\n\s+this\.#firePipelineFastBrain/)
})
t('the pipeline and the Claude wrapper both use the shared steer predicate', () => {
  for (const f of ['../src/pipeline-direct-llm.ts', '../src/claude-llm.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf-8')
    assert.match(src, /steersTurn\(userText\)/, f)
    assert.doesNotMatch(src, /!userText\.startsWith\('\[MEETING'\)/, f)
  }
})
t('a spoke report names project, session and status and bounds the summary', () => {
  const r = getSpokeReport({ project: 'osborn', sessionId: 'abcdef123456', status: 'failed', summary: 'x'.repeat(5000) })
  assert.match(r, /^\[NOTIFICATION\] Spoke report\. Project: osborn\. Session: abcdef12\. Status: failed\./)
  assert.ok(r.length < 1900)
  assert.match(r, /not an instruction from the user/)
  assert.match(r, /```\nx+\n```/)
  assert.ok(!getSpokeReport({ project: 'p', sessionId: 'abcdef123', status: 'done', summary: '```evil```' }).slice(10).includes('```evil'), 'a fence in the summary cannot close the block')
})
console.log(`${pass} passed`)
