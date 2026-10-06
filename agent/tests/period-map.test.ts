// Period-map tests: strip of injected context, block selection, quote verification.
// Run: npx tsx agent/tests/period-map.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import Database from 'better-sqlite3'

const tmp = mkdtempSync(join(tmpdir(), 'period-test-'))
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude')
const deny = join(tmp, 'deny.json')
writeFileSync(deny, JSON.stringify({ terms: { '[client]': ['Audos'] } }))
process.env.OSBORN_LENS_DENYLIST = deny
delete process.env.OSBORN_LENS_INCLUDE_SUBAGENTS

const { stripInjected } = await import('../src/content/lens-strip.js')
const { loadConversationRows } = await import('../src/content/lens-db.js')
const { loadClientRedactor } = await import('../src/content/lens-redact.js')
const { selectBlock, parseSince, lastBoundaryStart } = await import('../src/content/lens-period-block.js')
const { isCompactionBoundaryHead, readCompactionBoundaries } = await import('../src/content/lens-period-boundaries.js')
const { readPeriodMap, periodPrompt, attachAudio } = await import('../src/content/lens-period.js')
const { Budget } = await import('../src/content/lens-model.js')
const { runPeriodMap } = await import('../src/content/period-run.js')

let pass = 0
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

const REAL_USER = 'Okay so the WebSocket video failed, um, it feels like actions not a story'
const REAL_ASSIST = 'The block now holds raw conversation only; I removed the <session_tail> mention from the docs.'
const TURN_SHAPE = 'You are thinking with this person, not for them. You are a peer.\n\n[TURN-SHAPE REMINDER — re-anchor]\n0. MIRROR FIRST.\n9. The conversation IS the work. The user is a peer thinking with you, not pressing buttons.'
const FAKE_NPM = 'npm_' + 'A1b2C3d4'.repeat(4) + 'XyZw'

// [msg_type, text, ts minute]
const rows: [string, string][] = [
  ['user', 'Before compaction: we started the lens with Audos data here'],                                        // 1
  ['assistant', 'Earlier assistant reply about the old period'],                                                   // 2
  ['user', `<session_tail>\n2026-01-01T09:00  Assistant: replayed old stuff\n</session_tail>\n\n${REAL_USER}`],     // 3 boundary
  ['user', 'This session is being continued from a previous conversation that ran out of context. Summary: ...'],  // 4
  ['user', 'Recap block\n=== HANDOFF_STATE ===\nworking on x\n=== DECISIONS ===\n- y'],                              // 5
  ['user', `Let's keep client names redacted <recalled_context>\nRelevant PRIOR messages\nold hit\n</recalled_context>`], // 6
  ['user', `<system-reminder>\nThe date is today.\n</system-reminder>\nRun it on the most recent period please`],    // 7
  ['user', `${TURN_SHAPE}\n\nNo summaries, we need the raw material`],                                               // 8
  ['user', '[SYSTEM — SILENT CONTROL MESSAGE. Do NOT narrate.] The writer sub-agent just finished.'],                // 9
  ['user', '<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>'],        // 10
  ['user', 'UserPromptSubmit hook additional context: machine load ok\nrecall hits follow\n\nCheck the egress scoping next'], // 11
  ['user', '[INTERRUPTED] The user interrupted your response mid-speech.\n\nWhat the user heard before cutoff:\n"Assistant spoken words"\n\nYour recent messages:\nassistant text HANDOFF_STATE mention\n\nUser\'s message: "No, no, from the same session ID"\n\nCONTEXT PRESERVATION (READ THIS):\nblah'], // 12
  ['user', '[CONTEXT] You generated speech while the user was already talking. None of it played.\n\nWhat the user is saying now:\n"That is where the timeline matters"\n\nText you produced that the user did NOT hear:\n"unheard agent text"\n\nCONTEXT PRESERVATION (READ THIS):\nx'], // 13
  ['assistant', REAL_ASSIST],                                                                                       // 14
  ['assistant', `Set the token ${FAKE_NPM} for Audos deploys`],                                                     // 15
  ['tool_use', 'TOOL_USE_PAYLOAD never read'],                                                                     // 16
  ['tool_result', 'TOOL_RESULT_PAYLOAD never read'],                                                               // 17
  ['thinking', 'THINKING never read'],                                                                             // 18
  ['user', 'Great, the clipper idea finally clicked for me, ship the period map'],                                  // 19
]
const pd = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-zz-period')
const sid = 'period-test-session'
mkdirSync(join(pd, 'osb', sid), { recursive: true })
const dbPath = join(pd, 'osb', sid, 'session.db')
const db = new Database(dbPath)
db.exec(`CREATE TABLE content(id INTEGER PRIMARY KEY, source TEXT, line_num INT, byte_offset INT, ts TEXT, msg_type TEXT, model TEXT, git_branch TEXT, cwd TEXT, tool_name TEXT, blob BLOB)`)
const ins = db.prepare('INSERT INTO content(source, ts, msg_type, blob) VALUES (?,?,?,?)')
rows.forEach(([type, text], i) => ins.run('main', new Date(Date.UTC(2026, 0, 1, 10, i)).toISOString(), type, brotliCompressSync(Buffer.from(text))))
ins.run('agent-abcd1234', '2026-01-01T10:30:00.000Z', 'user', brotliCompressSync(Buffer.from('SUBAGENT prompt never read')))
db.close()

const red = loadClientRedactor(pd)
const load = loadConversationRows(dbPath, 0, red.redact)
const byId = new Map(load.records.map(r => [r.id, r]))

// ---- strip: each kind ----
await t('session_tail stripped, user words after it kept verbatim', () => {
  assert.equal(byId.get(3)?.text, REAL_USER)
})
await t('compaction summary ("This session is being continued…") dropped', () => assert.ok(!byId.has(4)))
await t('compaction summary with HANDOFF_STATE / === DECISIONS === dropped', () => assert.ok(!byId.has(5)))
await t('<recalled_context> block stripped', () => assert.equal(byId.get(6)?.text, "Let's keep client names redacted"))
await t('<system-reminder> block stripped', () => assert.equal(byId.get(7)?.text, 'Run it on the most recent period please'))
await t('turn-shape reminder text stripped', () => assert.equal(byId.get(8)?.text, 'No summaries, we need the raw material'))
await t('[SYSTEM — SILENT CONTROL MESSAGE] row dropped', () => assert.ok(!byId.has(9)))
await t('task-notification row dropped', () => assert.ok(!byId.has(10)))
await t('hook additional context stripped', () => assert.equal(byId.get(11)?.text, 'Check the egress scoping next'))
await t('[INTERRUPTED] → only the user\'s words (not dropped for HANDOFF_STATE in quoted assistant text)', () =>
  assert.equal(byId.get(12)?.text, 'No, no, from the same session ID'))
await t('[CONTEXT] → only the user\'s words', () => assert.equal(byId.get(13)?.text, 'That is where the timeline matters'))
await t('genuine assistant text kept verbatim (even mentioning a tag)', () => assert.equal(byId.get(14)?.text, REAL_ASSIST))
await t('genuine user text kept verbatim', () => assert.equal(byId.get(19)?.text, rows[18][1]))
await t('no tool calls / results / thinking / sub-agent rows', () => {
  const all = load.records.map(r => r.text).join('\n')
  for (const s of ['TOOL_USE_PAYLOAD', 'TOOL_RESULT_PAYLOAD', 'THINKING', 'SUBAGENT']) assert.ok(!all.includes(s), s)
})
await t('no injected marker survives anywhere', () => {
  const all = load.records.map(r => r.text).join('\n')
  for (const s of ['replayed old stuff', 'Relevant PRIOR', 'The date is today', 'TURN-SHAPE', 'SILENT CONTROL', 'task-id', 'machine load', 'unheard agent text', 'Assistant spoken words', 'HANDOFF_STATE ==='])
    assert.ok(!all.includes(s), s)
})
await t('per-kind strip counts', () => {
  const s = load.stats.stripped
  for (const k of ['session-tail', 'compaction-summary', 'recalled-context', 'system-reminder', 'turn-shape', 'silent-control', 'task-notification', 'hook-context', 'interrupted-unwrapped', 'context-unwrapped'])
    assert.ok((s[k] ?? 0) >= 1, `${k}: ${JSON.stringify(s)}`)
  assert.equal(s['compaction-summary'], 2)
})
await t('secret + client redaction still applied', () => {
  const x = byId.get(15)!.text
  assert.ok(!x.includes(FAKE_NPM) && x.includes('[REDACTED'), x)
  assert.ok(!x.includes('Audos') && x.includes('[client]'), x)
  assert.ok(!byId.get(1)!.text.includes('Audos'))
})
await t('stripInjected leaves assistant rows untouched', () => {
  const s = '<system-reminder>x</system-reminder> literal'
  assert.equal(stripInjected(s, 'assistant').text, s)
})

// ---- block selection ----
await t('default block starts at the last compaction boundary row', () => {
  const b = selectBlock(load.records, { boundaries: [3], maxTokens: 100_000 })!
  assert.equal(b.firstRowId, 3)
  assert.equal(b.lastRowId, 19)
  assert.equal(b.leftOut, null)
  assert.match(b.basis, /compaction boundary \(row #3\)/)
})
await t('over the cap: most recent rows kept, left-out reported', () => {
  const b = selectBlock(load.records, { boundaries: [], maxTokens: 60 })!
  assert.equal(b.lastRowId, 19)
  assert.ok(b.leftOut && b.leftOut.rows > 0 && b.leftOut.lastRowId < b.firstRowId)
  assert.equal(b.leftOut!.rows + b.records.length, b.periodRows)
})
await t('time range (--since) selects by timestamp', () => {
  const b = selectBlock(load.records, { boundaries: [3], sinceMs: Date.parse('2026-01-01T10:12:00Z'), maxTokens: 100_000 })!
  assert.equal(b.firstRowId, 13)
  assert.ok(Math.abs(parseSince('24h', 1e12) - (1e12 - 86_400_000)) < 1)
})

// ---- fix round 1: compaction evidence must be real, not a mention ----
await t('bare HANDOFF_STATE mention in real speech is kept', () => {
  const s = 'the HANDOFF_STATE section is wrong, fix it'
  const r = stripInjected(s, 'user')
  assert.equal(r.text, s)
  assert.ok(!r.kinds.includes('compaction-summary'))
})
await t('inline "=== DECISIONS ===" (not a line-start header) is kept', () => {
  const s = 'I think the === DECISIONS === header is ugly'
  assert.equal(stripInjected(s, 'user').text, s)
})
await t('line-start "=== HANDOFF_STATE ===" header drops the row', () => {
  const r = stripInjected('Recap\n  === HANDOFF_STATE ===\nworking on x', 'user')
  assert.equal(r.text, null)
  assert.deepEqual(r.kinds, ['compaction-summary'])
})
await t('"being continued from a previous conversation" lead drops the row; mid-row mention kept', () => {
  assert.equal(stripInjected('This session is being continued from a previous conversation. Summary:', 'user').text, null)
  const s = 'Why does it say this session is being continued from a previous conversation?'
  assert.equal(stripInjected(s, 'user').text, s)
})
await t('boundary detector: compaction evidence only at the row start', () => {
  assert.ok(isCompactionBoundaryHead('<session_tail>\nx\n</session_tail>\nhi'))
  assert.ok(isCompactionBoundaryHead('<session_tail since="t">\nx'))
  assert.ok(isCompactionBoundaryHead('  Conversation compacted. Summary follows'))
  assert.ok(isCompactionBoundaryHead('This session is being continued from a previous conversation that ran out'))
  assert.ok(isCompactionBoundaryHead('[time: 10:00] continued from a previous conversation'))
  assert.ok(!isCompactionBoundaryHead('hey, after "Conversation compacted" the lens broke'))
  assert.ok(!isCompactionBoundaryHead('the banner said this was continued from a previous conversation'))
  assert.ok(!isCompactionBoundaryHead('look at <session_tail> in the docs'))
})
await t('readCompactionBoundaries on the fixture: only rows starting with evidence', () => {
  assert.deepEqual(readCompactionBoundaries(dbPath), [3, 4])
})

// ---- fix round 1: tags with attributes, unterminated tags ----
await t('open tags with attributes are stripped (paired)', () => {
  const r1 = stripInjected('<recalled_context source="bm25" k="8">\nold hit\n</recalled_context>\nkeep me', 'user')
  assert.equal(r1.text, 'keep me')
  assert.ok(r1.kinds.includes('recalled-context'))
  const r2 = stripInjected('<task-notification id="abc">\n<status>completed</status>\n</task-notification>\nnext step please', 'user')
  assert.equal(r2.text, 'next step please')
  assert.ok(r2.kinds.includes('task-notification'))
  const r3 = stripInjected('<session_tail since="2026-01-01">\nreplayed\n</session_tail>\nmy words', 'user')
  assert.equal(r3.text, 'my words')
  assert.ok(r3.kinds.includes('session-tail'))
})
await t('unterminated tag at row start / line start swallows the rest', () => {
  assert.equal(stripInjected('<system-reminder>\ninjected forever', 'user').text, null)
  const r = stripInjected('real words first\n<recalled_context k="3">\nrecall junk', 'user')
  assert.equal(r.text, 'real words first')
  assert.ok(r.kinds.includes('recalled-context'))
})
await t('inline mention of an unterminated tag survives', () => {
  const s = 'the <system-reminder> tag is noisy, and <task-notification id=7> too'
  const r = stripInjected(s, 'user')
  assert.equal(r.text, s)
  assert.deepEqual(r.kinds, [])
})
await t('inline mention survives while a later line-start block is still stripped', () => {
  const r = stripInjected('the <session_tail> tag is noisy\n<session_tail>\nreplay\n</session_tail>\nok', 'user')
  assert.equal(r.text, 'the <session_tail> tag is noisy\n\nok')
})

// ---- fix round 1: lastBoundaryStart matches its doc ----
await t('lastBoundaryStart: latest seam at/before the last record, even with few rows after; null when none', () => {
  const recsAll = load.records
  const lastId = recsAll[recsAll.length - 1].id
  assert.equal(lastBoundaryStart(recsAll, [3, lastId]), lastId)
  assert.equal(lastBoundaryStart(recsAll, [lastId + 5, 3]), 3)
  assert.equal(lastBoundaryStart(recsAll, []), null)
  assert.equal(lastBoundaryStart([], [3]), null)
})

// ---- period map verification ----
const recs = load.records
const model = JSON.stringify({
  high_leverage: [
    { title: 'Raw block, no summaries', why: 'removes a class of drift', evidence: 'decided', quotes: [{ row: 8, text: 'No summaries, we need the raw material' }] },
    { title: 'Invented', why: 'x', evidence: 'shipped', quotes: [{ row: 19, text: 'we shipped a billion-dollar feature yesterday' }] },
    { title: 'Bad evidence', why: 'x', evidence: 'planned', quotes: [{ row: 19, text: 'ship the period map' }] },
  ],
  period_goal: { text: 'Build the period map', quotes: [{ row: 19, text: 'ship the period map' }] },
  arc: [{ step: 'failed', what: 'video failed', why: 'no human arc', quotes: [{ row: 3, text: 'the WebSocket video failed' }] }],
  what_worked: { held_up: [{ name: 'redaction', kind: 'approach', why: 'safe', quotes: [{ row: 6, text: 'keep client names redacted' }] }], didnt: [] },
  stories: [
    { title: 'Clipper', why_it_matters: 'y', from_row: 13, to_row: 999, turning_points: [
      { moment: 'click', user_lines: [{ row: 19, text: 'the clipper idea finally clicked for me' }] },
      { moment: 'assistant line', user_lines: [{ row: 14, text: 'The block now holds raw conversation only' }] }] },
    { title: 'Only assistant', why_it_matters: 'z', turning_points: [{ moment: 'm', user_lines: [{ row: 14, text: 'The block now holds raw conversation only' }] }] },
  ],
  angles: [{ title: 'Raw over summaries', demand_question: 'Why do my AI summaries lose the story?', story: 'Clipper', quotes: [{ row: 12, text: 'from the same session ID' }] }],
})
const map = readPeriodMap(model, recs)!
await t('verified quotes kept with row id + speaker from the source row', () => {
  assert.equal(map.highLeverage[0].quotes[0].row, 8)
  assert.equal(map.highLeverage[0].quotes[0].speaker, 'user')
  assert.equal(map.periodGoal?.quotes[0].row, 19)
})
await t('fabricated quote → item dropped; bad evidence → dropped; order kept', () => {
  assert.deepEqual(map.highLeverage.map(h => h.title), ['Raw block, no summaries'])
  assert.ok(map.drops.some(d => d.section === 'high_leverage' && d.item === 'Invented'))
  assert.ok(map.itemsDropped.some(i => i.includes('Bad evidence')))
})
await t('story lines must be the user\'s own; assistant-only story dropped', () => {
  assert.deepEqual(map.stories.map(s => s.title), ['Clipper'])
  assert.equal(map.stories[0].turningPoints.length, 1)
  assert.ok(map.drops.some(d => d.reason === 'not a user line'))
})
await t('anchors clamped to the block and cover verified rows', () => {
  assert.equal(map.anchors[0].from, 13)
  assert.equal(map.anchors[0].to, 19)
  assert.equal(map.anchors[0].audio, undefined)
})
await t('audio is optional: offsets only when an alignment exists', () => {
  attachAudio(map, null)
  assert.equal(map.anchors[0].audio, undefined)
  attachAudio(map, { path: '/r.webm', startIso: '2026-01-01T10:00:00.000Z', approximate: true, basis: 'test' })
  assert.equal(map.anchors[0].audio?.start, '0:12:00')
})
await t('prompt: transcript first, task after', () => {
  const p = periodPrompt('[#1 | ts | user]\nhello', { from: 'a', to: 'b', rows: 1 })
  assert.ok(p.indexOf('</transcript>') < p.indexOf('TASK:') && p.includes('high_leverage'))
})
await t('Budget caps override (period map: 1 call, $0.50)', () => {
  const b = new Budget({ id: 'm', contextLength: 1000, promptPerTok: 1e-6, completionPerTok: 1e-6, verified: false }, { maxCalls: 1, maxCostUsd: 0.5 })
  assert.equal(b.maxCostUsd, 0.5)
  assert.ok(b.take(10, 10))
  assert.ok(!b.take(10, 10))
})
await t('dry run writes review md, refuses the profile path, never writes HWM/profile', async () => {
  await assert.rejects(runPeriodMap({ sessionId: sid, outPath: join(pd, 'content-profile.md'), dry: true }), /content-profile/)
  const out = join(tmp, 'out', 'period.md')
  const r = await runPeriodMap({ sessionId: sid, outPath: out, dry: true })
  assert.equal(r.calls, 0)
  const md = readFileSync(out, 'utf-8')
  assert.ok(md.includes('silent-control') && !md.includes('Audos'), md)
  assert.ok(!existsSync(join(pd, 'content-profile.md')) && !existsSync(join(pd, '.content-lens-hwm.json')))
})

console.log(`\n${pass} passed`)
