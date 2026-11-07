// Fixture tests for the shared transcript sanitizer (lane L2a, UI#2, #9, #10, #11, #16).
// Real-shaped inputs: the [time:] tag the frontend prepends to typed turns, the
// [INTERRUPTED]/[CONTEXT] templates from pipeline-direct-llm.ts, the post-compaction
// <session_tail> block, <recalled_context>, client notices ([favorited], [welcome-back]),
// [SYSTEM] lines. Also covers the data path that reads them: getSessionPreview (via
// listAllClaudeSessions + the persisted manifest) and the recall store (string-content
// user rows, recentRows ordering/source filter).
// SYNTHETIC values only (no real secrets).
//
// Run: cd agent && npx tsx tests/sanitizer-session-tail.test.ts   (self-sandboxes HOME)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'

const HOME = mkdtempSync(join(tmpdir(), 'osborn-sanitizer-tail-home-'))
process.env.HOME = HOME
delete process.env.CLAUDE_CONFIG_DIR

const { cleanTurnText, sanitizeRecord } = await import('../src/content/transcript-sanitizer.js')

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) }
}
const LEAK_RE = /\[time:|<session_tail|<\/session_tail>|\[INTERRUPTED\]|\[CONTEXT\]|\[SYSTEM|<recalled_context|<system-reminder|<task-notification|CONTEXT PRESERVATION|\[favorited\]|\[welcome-back\]/

// ── Real-shaped builders (mirror pipeline-direct-llm.ts templates) ───────────
const T = '[time: 2026-11-06 16:14 local] '
const longRecent = Array.from({ length: 12 }, (_, i) => `Assistant message ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(12)).join('\n\n')
function interrupted(userText: string): string {
  return [
    `[INTERRUPTED] The user interrupted your response mid-speech.`, ``,
    `What the user heard before cutoff:`, `"I've got part 1, all set"`, ``,
    `WHAT THE USER DID NOT HEAR (you wrote this but it was cut off):`,
    `Anything in "Your recent messages" below that appears AFTER the quoted heard text is content the user did not hear. The user has no memory of it.`, ``,
    `Your recent messages (full untruncated — you wrote these):`, longRecent, ``, ``,
    `User's message: "${userText}"`, ``,
    `CONTEXT PRESERVATION (READ THIS):`,
    `The user has NO memory of unheard content.`, ``,
    `SUB-AGENTS: background sub-agents survive an interrupt.`, ``,
    `RESPOND with speech first, then act:`,
    `- ALWAYS reply with at least one spoken sentence before doing any tool calls`,
  ].join('\n')
}
function contextWrap(userText: string): string {
  return [
    `[CONTEXT] You generated speech while the user was already talking. None of it played.`, ``,
    `What the user is saying now:`, `"${userText}"`, ``,
    `Text you produced that the user did NOT hear:`, `"some unheard text"`, ``,
    `CONTEXT PRESERVATION (READ THIS):`, `The user has NO memory of the unheard text.`,
  ].join('\n')
}
const tail = [
  '<session_tail>',
  '2026-09-10T22:49:35  User: [Request interrupted by user]',
  '2026-09-10T22:50:01  Assistant: Okay, stopping the Sept 10 work.',
  '</session_tail>',
].join('\n')

// ── 1. cleanTurnText on user turns ───────────────────────────────────────────
ok('UI#10 time tag stripped', cleanTurnText(T + 'New finding - two chat tabs collide') === 'New finding - two chat tabs collide')
ok('UI#16 tail + time tag', cleanTurnText(tail + '\n\n' + T + 'hello there') === 'hello there', String(cleanTurnText(tail + '\n\n' + T + 'hello there')))
ok('UI#2 INTERRUPTED unwrap with inner time tag (anchor past 1200 chars)', (() => {
  const raw = interrupted(T + 'what about the second tab?')
  return raw.indexOf("User's message") > 1200 && cleanTurnText(raw) === 'what about the second tab?'
})(), String(cleanTurnText(interrupted(T + 'what about the second tab?'))))
ok('UI#16 tail + INTERRUPTED + inner time tag', cleanTurnText(tail + '\n\n' + interrupted(T + 'and the dashboard')) === 'and the dashboard')
ok('CONTEXT unwrap with inner time tag', cleanTurnText(contextWrap(T + 'keep going')) === 'keep going', String(cleanTurnText(contextWrap(T + 'keep going'))))
ok('user quote containing a double quote survives', cleanTurnText(interrupted('he said "stop" then left')) === 'he said "stop" then left')
ok('[favorited] notice dropped', cleanTurnText(T + '[favorited] The user favorited the file plan.md.') === null)
ok('[welcome-back] notice dropped', cleanTurnText('[welcome-back] The user just returned after 3 hours away.') === null)
ok('[SYSTEM] dropped', cleanTurnText('[SYSTEM] Session resumed.') === null)
ok('[SYSTEM — SILENT CONTROL] dropped', cleanTurnText('[SYSTEM — SILENT CONTROL MESSAGE] do not reply') === null)
ok('recalled_context block stripped', cleanTurnText('<recalled_context k="5">\n[1] (main L3 · user)\nold hit\n</recalled_context>\nreal question here') === 'real question here')
ok('system-reminder block stripped', cleanTurnText('<system-reminder>\nnoise\n</system-reminder>\nactual words') === 'actual words')
ok('task-notification dropped', cleanTurnText('<task-notification>\n<task-id>x</task-id>\n</task-notification>') === null)
ok('plain speech unchanged (fillers kept)', cleanTurnText('um, so, uh, can we ship it?') === 'um, so, uh, can we ship it?')
ok('inline tag mention kept', cleanTurnText('the <system-reminder> tag is noisy') === 'the <system-reminder> tag is noisy')
ok('secret redacted in user turn', (() => {
  const out = cleanTurnText(T + 'my key is sk-ant-api03-' + 'A'.repeat(30) + ' ok') || ''
  return out.includes('[REDACTED-ANTHROPIC-KEY]') && !out.includes('AAAAAAAAAA')
})())
ok('empty / whitespace -> null', cleanTurnText('   ') === null && cleanTurnText(T) === null)
ok('assistant turn passes through (redacted)', cleanTurnText('Here is the plan.', 'assistant') === 'Here is the plan.')

// sanitizeRecord itself also handles the inner [time:] and time-before-tail order
ok('sanitizeRecord: inner time tag after unwrap', sanitizeRecord({ text: interrupted(T + 'x y z'), timestamp: '' }).record?.text === 'x y z')
ok('sanitizeRecord: time tag before tail', sanitizeRecord({ text: T + tail + '\n\nhi', timestamp: '' }).record?.text === 'hi')
ok('sanitizeRecord: [favorited] dropped', sanitizeRecord({ text: '[favorited] The user favorited x', timestamp: '' }).action === 'drop')

// ── 2. getSessionPreview via listAllClaudeSessions + manifest ────────────────
const { listAllClaudeSessions, invalidateSessionListCache, getClaudeProjectsDir } = await import('../src/config.js')
const SLUG = '-tmp-osborn-l2a-preview'
const projDir = join(getClaudeProjectsDir(), SLUG)
mkdirSync(projDir, { recursive: true })
const ts = (m: number) => `2026-11-06T16:${String(m).padStart(2, '0')}:00.000Z`
const u = (t: string | any[], m: number) => JSON.stringify({ type: 'user', timestamp: ts(m), message: { role: 'user', content: Array.isArray(t) ? t : [{ type: 'text', text: t }] } })
const uStr = (t: string, m: number) => JSON.stringify({ type: 'user', timestamp: ts(m), message: { role: 'user', content: t } })
const a = (t: string, m: number, id = 'msg_' + m) => JSON.stringify({ type: 'assistant', timestamp: ts(m), message: { id, role: 'assistant', content: [{ type: 'text', text: t }] } })
const aTool = (m: number) => JSON.stringify({ type: 'assistant', timestamp: ts(m), message: { id: 'tool_' + m, role: 'assistant', content: [{ type: 'tool_use', id: 't' + m, name: 'Bash', input: { command: 'ls' } }] } })
const uToolResult = (m: number) => JSON.stringify({ type: 'user', timestamp: ts(m), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' + m, content: 'file.txt' }] } })
const sys = (m: number) => JSON.stringify({ type: 'system', timestamp: ts(m), subtype: 'x' })

const SID = 'bbbb0001-0000-4000-8000-000000000001'
writeFileSync(join(projDir, `${SID}.jsonl`), [
  JSON.stringify({ type: 'summary', cwd: '/tmp/osborn-l2a-preview' }),
  u('[welcome-back] The user just returned after 2 days away.', 1),
  u(T + 'Fix the dashboard titles please', 2),
  a('On it.', 3),
  aTool(4), uToolResult(5), aTool(6), uToolResult(7),
  a('Titles are now clean.', 8, 'msg_8'),
  a('(continued same message)', 8, 'msg_8'),
  sys(9),
  u(tail + '\n\n' + interrupted(T + 'and what about the counts in the list?'), 10),
  a('Counts are fixed too.', 11),
  u(T + '[favorited] The user favorited the file plan.md.', 12),
  JSON.stringify({ type: 'system', subtype: 'noise' }),
].join('\n') + '\n')

const SID2 = 'bbbb0002-0000-4000-8000-000000000002'
writeFileSync(join(projDir, `${SID2}.jsonl`), [
  JSON.stringify({ type: 'summary', cwd: '/tmp/osborn-l2a-preview' }),
  JSON.stringify({ type: 'ai-title', aiTitle: 'Recover lost session after crash', sessionId: SID2 }),
  uStr('plain string content first turn', 1),
  a('reply one', 2),
  uStr('plain string content second turn', 3),
  a('reply two', 4),
].join('\n') + '\n')

const list = await listAllClaudeSessions()
const byId = new Map(list.filter((s: any) => s.projectSlug === SLUG).map((s: any) => [s.sessionId, s]))
const s1: any = byId.get(SID)
const s2: any = byId.get(SID2)
ok('preview: session listed', !!s1 && !!s2)
ok('preview: title = first clean user turn', s1?.title === 'Fix the dashboard titles please', JSON.stringify(s1?.title))
ok('preview: lastMessage = last CLEAN user turn (sanitize before truncate)', s1?.lastMessage === 'and what about the counts in the list?', JSON.stringify(s1?.lastMessage))
ok('preview: corrected turn count (2 user + 3 assistant; no tool round-trips, no notices, split message once)', s1?.messageCount === 5, String(s1?.messageCount))
ok('preview: firstTs = first record timestamp', s1?.firstTs === ts(1), String(s1?.firstTs))
ok('preview: lastActivityAt = last real user/assistant record', s1?.lastActivityAt === ts(11), String(s1?.lastActivityAt))
ok('preview: no wrapper text in title/lastMessage', !LEAK_RE.test(String(s1?.title) + String(s1?.lastMessage)))
ok('preview: ai-title preferred for title', s2?.title === 'Recover lost session after crash', JSON.stringify(s2?.title))
ok('preview: string-content user turns counted + lastMessage', s2?.messageCount === 4 && s2?.lastMessage === 'plain string content second turn', `${s2?.messageCount} ${JSON.stringify(s2?.lastMessage)}`)

const manifestPath = join(HOME, '.claude', 'session-manifest.json')
const manifestRaw = readFileSync(manifestPath, 'utf-8')
const manifest = JSON.parse(manifestRaw)
const e1 = manifest.entries[join(projDir, `${SID}.jsonl`)]
ok('manifest: version bumped to 2', manifest.v === 2, String(manifest.v))
ok('manifest: entry carries title/lastActivityAt/firstTs', e1?.title === s1?.title && e1?.lastActivityAt === ts(11) && e1?.firstTs === ts(1))
ok('manifest export: no <session_tail / wrapper text', !LEAK_RE.test(manifestRaw))
invalidateSessionListCache()
const again = await listAllClaudeSessions()
const r1: any = again.find((s: any) => s.sessionId === SID)
ok('manifest: cold read returns same title/fields', r1?.title === s1?.title && r1?.lastActivityAt === s1?.lastActivityAt && r1?.messageCount === s1?.messageCount)

// A v1 manifest (old shape, no title) must be ignored, not served.
writeFileSync(manifestPath, JSON.stringify({ v: 1, entries: { [join(projDir, `${SID}.jsonl`)]: { ...e1, title: undefined, lastMessage: '[time: x] stale', messageCount: 9999 } } }))
invalidateSessionListCache()
const afterV1 = (await listAllClaudeSessions()).find((s: any) => s.sessionId === SID) as any
ok('manifest: stale v1 manifest ignored', afterV1?.messageCount === 5 && afterV1?.lastMessage === s1?.lastMessage)

// ── 3. recall store: string-content user rows + recentRows ordering/source ──
const { openStore, recentRows, getStorePath, updateSessionStore } = await import('../src/session-store.js')
const { projectPathToSlug } = await import('../src/session-access.js')
const cfg = mkdtempSync(join(tmpdir(), 'osborn-l2a-store-'))
process.env.CLAUDE_CONFIG_DIR = cfg
const wd = join(cfg, 'proj')
const sid = 'sess-l2a-' + Math.random().toString(36).slice(2, 8)
const pdir = join(cfg, 'projects', projectPathToSlug(wd))
mkdirSync(pdir, { recursive: true })
writeFileSync(join(pdir, `${sid}.jsonl`), [
  JSON.stringify({ type: 'user', timestamp: ts(1), sessionId: sid, message: { role: 'user', content: 'string content user turn' } }),
  JSON.stringify({ type: 'assistant', timestamp: ts(2), sessionId: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'array assistant' }] } }),
].join('\n') + '\n')
await updateSessionStore(sid, wd)
{
  const db = openStore(getStorePath(sid, wd), { readonly: true })
  try {
    const rows = recentRows(db, 10, ['user', 'assistant'])
    ok('store: string-content user row indexed', rows.some((r: any) => r.msgType === 'user' && r.text === 'string content user turn'), JSON.stringify(rows.map((r: any) => r.text)))
  } finally { db.close() }
}
{
  // Out-of-order ids vs timestamps + a sub-agent source: recentRows orders by ts DESC
  // and can be scoped to the main source.
  const db = openStore(getStorePath(sid, wd))
  const ins = db.prepare(`INSERT INTO content (source, line_num, byte_offset, ts, msg_type, model, git_branch, cwd, tool_name, blob) VALUES (?,?,?,?,?,?,?,?,?,?)`)
  ins.run('main', 10, 0, '2026-11-06T18:00:00.000Z', 'user', null, null, null, null, brotliCompressSync(Buffer.from('NEWEST by ts')))
  ins.run('main', 11, 0, '2025-09-10T22:49:35.000Z', 'user', null, null, null, null, brotliCompressSync(Buffer.from('OLD Sept row inserted late')))
  ins.run('agent-x', 12, 0, '2026-11-06T19:00:00.000Z', 'assistant', null, null, null, null, brotliCompressSync(Buffer.from('subagent row')))
  db.close()
  const rdb = openStore(getStorePath(sid, wd), { readonly: true })
  try {
    const all = recentRows(rdb, 3, ['user', 'assistant'])
    ok('recentRows: ts DESC (not insertion id)', all[0]?.text === 'subagent row' && all[1]?.text === 'NEWEST by ts' && !all.some((r: any) => r.text.startsWith('OLD Sept')), JSON.stringify(all.map((r: any) => r.text)))
    const main = recentRows(rdb, 2, ['user', 'assistant'], { sources: ['main'] })
    ok('recentRows: source filter (main only)', main.length === 2 && main.every((r: any) => r.source === 'main') && main[0].text === 'NEWEST by ts', JSON.stringify(main.map((r: any) => r.text)))
  } finally { rdb.close() }
}

rmSync(projDir, { recursive: true, force: true })
rmSync(cfg, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
