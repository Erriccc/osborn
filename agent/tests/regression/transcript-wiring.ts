/**
 * Transcript wiring, agent side (lane L2b). Pins how index.ts / config.ts use
 * the shared sanitizer (cleanTurnText) on every path that shows past or echoed
 * text, and the favorite_changed control message (UI#21).
 *
 *   TW1  /sessions + sessions_list carry title / firstTs / lastActivityAt
 *   TW2  /session-messages + prior_messages: sanitize BEFORE truncating,
 *        over-fetch so dropped rows don't shrink the page (real recall store)
 *   TW3  user_transcript echo: sanitized ([time:] gone), clientMsgId preserved,
 *        attachments kept, notices dropped
 *   TW4  favorite_changed: gated control type, queued as hidden context for the
 *        next turn (never user_text), legacy [favorited] user_text diverted,
 *        reaches the inner ClaudeLLM on a COPY, chat() still sync
 *   TW5  config.ts getSessionSummary / getConversationHistory use the shared
 *        accumulator / sanitizer (corrected count, clean text, full page)
 *
 * Run: npx tsx agent/tests/regression/transcript-wiring.ts  (self-sandboxes HOME)
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import { check, finish, sandboxHome, AGENT_DIR, anchoredSlice, stripComments } from './_shared.js'

sandboxHome()
const cfgDir = mkdtempSync(join(tmpdir(), 'osborn-tw-'))
process.env.CLAUDE_CONFIG_DIR = cfgDir

const tw = await import('../../src/transcript-wiring.js')
const { cleanTurnText } = await import('../../src/content/transcript-sanitizer.js')
const { checkControlSender, CONTROL_MESSAGE_TYPES, READ_ONLY_MESSAGE_TYPES } = await import('../../src/data-sender-auth.js')
const indexSrc = readFileSync(join(AGENT_DIR, 'src/index.ts'), 'utf8')
const indexCode = stripComments(indexSrc)

// ── TW1 session list entry ───────────────────────────────────────────────────
{
  const e = tw.sessionListEntry({
    sessionId: 's1', projectSlug: '-p', projectPath: '/p', cwd: '/p', timestamp: new Date('2026-11-07T01:00:00Z'),
    lastMessage: 'last', title: 'Clean title', messageCount: 4, firstTs: '2026-11-06T10:00:00Z',
    lastActivityAt: '2026-11-07T00:59:00Z', fileSize: 123,
  })
  check('TW1a', e.title === 'Clean title' && e.firstTs === '2026-11-06T10:00:00Z' && e.lastActivityAt === '2026-11-07T00:59:00Z',
    'entry carries title + firstTs + lastActivityAt')
  check('TW1b', e.timestamp === '2026-11-07T01:00:00.000Z' && e.lastMessage === 'last' && e.messageCount === 4 && e.fileSize === 123 && e.sessionId === 's1',
    'existing fields unchanged (timestamp ISO, lastMessage, messageCount, fileSize)')
  const sessionsRoute = anchoredSlice(indexSrc, "url.pathname === '/sessions')", { endAnchor: "url.pathname === '/session-messages'" })
  const listHandler = anchoredSlice(indexSrc, "data.type === 'list_sessions'", { endAnchor: "data.type === 'resume_session'" })
  check('TW1c', /sessions\.map\(sessionListEntry\)/.test(sessionsRoute) && /sessions\.map\(sessionListEntry\)/.test(listHandler),
    '/sessions and sessions_list both map through sessionListEntry')
}

// ── TW2 history paths ────────────────────────────────────────────────────────
{
  // Pure: notices dropped and replaced by over-fetching.
  const rows: { msgType: string; text: string; ts: string }[] = []
  for (let i = 0; i < 30; i++) rows.push({ msgType: i % 2 ? 'assistant' : 'user', text: `real ${i}`, ts: `t${String(i).padStart(3, '0')}` })
  for (let i = 30; i < 60; i++) rows.push({ msgType: 'user', text: '[favorited] The user favorited the file x.md.', ts: `t${i}` })
  const newestFirst = rows.slice().reverse()
  const asked: number[] = []
  const fetch = (n: number) => { asked.push(n); return newestFirst.slice(0, n) }
  const page = tw.cleanHistoryRows(fetch, 10, 800)
  check('TW2a', page.length === 10 && page.every(m => m.content.startsWith('real ')), `full page of real rows despite 30 newest notices (got ${page.length})`)
  check('TW2b', page[0].content === 'real 20' && page[9].content === 'real 29', 'newest rows kept, chronological order')
  check('TW2c', asked.length > 1 && asked[0] === 30, `over-fetched (asked ${asked.join(',')})`)

  // Sanitize BEFORE truncating: [INTERRUPTED] puts the user's words last.
  const interrupted = [
    '[INTERRUPTED] The user interrupted your response mid-speech.', '', 'What the user heard before cutoff:',
    `"${'blah '.repeat(300)}"`, '', `User's message: "[time: 2026-11-07 01:00 local] keep the counts"`, '',
    'CONTEXT PRESERVATION (READ THIS):', 'rest',
  ].join('\n')
  const p2 = tw.cleanHistoryRows(() => [{ msgType: 'user', text: interrupted, ts: 'x' }], 5, 40)
  check('TW2d', p2.length === 1 && p2[0].content === 'keep the counts', `wrapper unwrapped before truncation (got ${JSON.stringify(p2[0]?.content)})`)
  const p3 = tw.cleanHistoryRows(() => [{ msgType: 'assistant', text: 'y'.repeat(2000), ts: '' }], 5, 800)
  check('TW2e', p3.length === 1 && p3[0].content.length === 800 && p3[0].ts === null, 'truncated after cleaning; empty ts -> null')
  const exhaustedAsk: number[] = []
  const p4 = tw.cleanHistoryRows((n) => { exhaustedAsk.push(n); return [{ msgType: 'user', text: 'only one', ts: 'a' }] }, 50, 100)
  check('TW2f', p4.length === 1 && exhaustedAsk.length === 1, 'store exhausted -> one fetch, partial page')

  // Real recall store through recentRows.
  const { openStore, getStorePath, recentRows } = await import('../../src/session-store.js')
  const wd = join(cfgDir, 'proj')
  const p = getStorePath('sess-tw', wd)
  mkdirSync(join(p, '..'), { recursive: true })
  const db = openStore(p)
  const ins = db.prepare(`INSERT INTO content (source, line_num, byte_offset, ts, msg_type, model, git_branch, cwd, tool_name, blob) VALUES (?,?,?,?,?,?,?,?,?,?)`)
  const put = (i: number, type: string, text: string) => ins.run('main', i, 0, `2026-11-07T00:${String(i).padStart(2, '0')}:00.000Z`, type, null, null, null, null, brotliCompressSync(Buffer.from(text)))
  put(0, 'user', '[time: 2026-11-07 00:00 local] first real question')
  put(1, 'assistant', 'first answer')
  for (let i = 2; i < 40; i++) put(i, 'user', '<system-reminder>\nnoise\n</system-reminder>')
  put(40, 'user', '[time: 2026-11-07 00:40 local] second real question')
  db.close()
  const rdb = openStore(p, { readonly: true })
  const real = tw.cleanHistoryRows(n => recentRows(rdb, n, ['user', 'assistant']), 3, 1200)
  rdb.close()
  check('TW2g', real.length === 3 && real.map(m => m.content).join('|') === 'first real question|first answer|second real question',
    `real store: tagged/blocked rows cleaned or dropped, page filled (got ${JSON.stringify(real.map(m => m.content))})`)

  const smRoute = stripComments(anchoredSlice(indexSrc, "url.pathname === '/session-messages'", { endAnchor: "url.pathname === '/canvas-token'" }))
  check('TW2h', /cleanHistoryRows\(n => recentRows\(db, n, \['user', 'assistant'\]\), limit, 1200\)/.test(smRoute) && !/\.slice\(0, 1200\)/.test(smRoute),
    '/session-messages uses cleanHistoryRows (no raw slice)')
  const priorIdx = indexCode.indexOf("type: 'prior_messages'")
  const priorBlock = indexCode.slice(Math.max(0, priorIdx - 600), priorIdx)
  check('TW2i', /cleanHistoryRows\(n => recentRows\(db, n, \['user', 'assistant'\]\), 20, 800\)/.test(priorBlock) && !/\.slice\(0, 800\)/.test(priorBlock),
    'prior_messages uses cleanHistoryRows (no raw slice)')
}

// ── TW3 user_transcript echo ─────────────────────────────────────────────────
{
  check('TW3a', tw.userEchoText('[time: 2026-11-07 01:00 local] hello there') === 'hello there', '[time:] tag stripped from the echo')
  check('TW3b', tw.userEchoText('[time: x] [favorited] The user favorited the file a.md.') === null, '[favorited] notice -> no echo')
  check('TW3c', tw.userEchoText('[welcome-back] The user just returned after 2h.') === null, '[welcome-back] notice -> no echo')
  check('TW3d', tw.userEchoText('[SCRIPT] say this') === null && tw.userEchoText('[PROACTIVE] x') === null && tw.userEchoText('[NOTIFICATION] y') === null,
    'voice-injection prefixes still filtered')
  check('TW3e', tw.userEchoText('<noise>') === null && tw.userEchoText('Thank you') === null && tw.userEchoText('ok') === null,
    '<noise>, "thank you" and <3 chars still filtered')
  check('TW3f', tw.userEchoText('plain spoken words') === 'plain spoken words', 'spoken text passes through')

  const tr = new tw.TypedEchoTracker(60_000, 20)
  const raw = '[time: 2026-11-07 01:00 local] ship it'
  tr.register(raw, 'cm-1', '', 1000)
  const hit = tr.take(raw, 2000)
  check('TW3g', hit?.clientMsgId === 'cm-1' && tr.size === 0, 'exact raw match returns clientMsgId and consumes it')
  tr.register('[time: a] same words', 'cm-2', '', 1000)
  check('TW3h', tr.take('[time: b] same words', 2000)?.clientMsgId === 'cm-2', 'falls back to sanitized-text match')
  tr.register('[time: a] late', 'cm-3', '', 1000)
  check('TW3i', tr.take('[time: a] late', 1000 + 61_000) === undefined, 'entries expire after the TTL')
  tr.register('x y z', { evil: 1 }, '', 1000)
  check('TW3j', tr.size === 0, 'non-string clientMsgId ignored')
  const withFile = '[time: a] look\n\n[Image: a.png](https://x/a.png)'
  tr.register(withFile, undefined, '\n\n[Image: a.png](https://x/a.png)', 1000)
  const att = tr.take(withFile, 1500)
  check('TW3k', tw.userEchoText(withFile, att?.attachments) === 'look\n\n[Image: a.png](https://x/a.png)' && att?.clientMsgId === undefined,
    'attachments kept on the typed echo; no clientMsgId when none was sent')

  const send = stripComments(anchoredSlice(indexSrc, 'function sendUserTranscript(', { endAnchor: 'function sendAgentTranscript(' }))
  check('TW3l', /typedEchoes\.take\(transcript\)/.test(send) && /userEchoText\(transcript, typed\?\.attachments\)/.test(send)
    && /type: 'user_transcript', text, clientMsgId/.test(send) && !/text: transcript/.test(send),
    'sendUserTranscript echoes the sanitized text with clientMsgId, never the raw transcript')
  const userText = stripComments(anchoredSlice(indexSrc, "data.type === 'user_text' && currentSession", { endAnchor: "data.type === 'list_sessions'" }))
  const regIdx = userText.indexOf('typedEchoes.register(fullContent, data.clientMsgId')
  check('TW3m', regIdx > 0 && regIdx < userText.indexOf('generateReply'), 'user_text registers clientMsgId before generateReply')
}

// ── TW4 favorite_changed ─────────────────────────────────────────────────────
{
  const CTRL = 'user-owner'
  check('TW4a', CONTROL_MESSAGE_TYPES.has('favorite_changed') && !READ_ONLY_MESSAGE_TYPES.has('favorite_changed'), 'favorite_changed is a gated control type')
  check('TW4b', !checkControlSender('favorite_changed', 'user-other', CTRL).ok && !checkControlSender('favorite_changed', 'meeting-canvas', CTRL).ok
    && checkControlSender('favorite_changed', CTRL, CTRL).ok, 'only the controller may send favorite_changed')

  check('TW4c', JSON.stringify(tw.parseFavoriteChanged({ type: 'favorite_changed', filePath: '/w/a.md', fileName: 'a.md', favorited: true }))
    === JSON.stringify({ filePath: '/w/a.md', fileName: 'a.md', favorited: true }), 'payload parsed')
  check('TW4d', tw.parseFavoriteChanged({ fileName: 'a.md' }) === null && tw.parseFavoriteChanged({ favorited: true }) === null
    && tw.parseFavoriteChanged({ fileName: 'a.md', favorited: 'yes' }) === null, 'malformed payloads rejected')
  const legacy = tw.parseLegacyFavoriteNotice('[time: 2026-11-06 16:32 local] [favorited] The user favorited the file redesign-scope-2026-11-06.md.')
  check('TW4e', legacy?.fileName === 'redesign-scope-2026-11-06.md' && legacy.favorited === true, `legacy user_text notice recognized (got ${JSON.stringify(legacy)})`)
  check('TW4f', tw.parseLegacyFavoriteNotice('I [favorited] something') === null && tw.parseLegacyFavoriteNotice('[favorited] The user favorited the file a.md. Also do X\nmore') === null,
    'ordinary text is not taken for a legacy notice')

  const q = new tw.ClientNoteQueue()
  q.favoriteChanged({ filePath: '/w/a.md', fileName: 'a.md', favorited: true })
  q.favoriteChanged({ filePath: '/w/b.md', fileName: 'b.md', favorited: true })
  q.favoriteChanged({ filePath: '/w/b.md', fileName: 'b.md', favorited: false })
  const block = q.drain()
  check('TW4g', block.startsWith('<system-reminder>') && block.endsWith('</system-reminder>') && block.includes('a.md') && !block.includes('b.md'),
    'drain: one hidden block; unfavorite cancels a pending note')
  check('TW4h', q.drain() === '' && q.size === 0, 'drain consumes')
  check('TW4i', cleanTurnText(block + '\n\n[time: 2026-11-07 01:00 local] what next', 'user') === 'what next',
    'the sanitizer strips the notice block from history, keeping the user words')

  const favBranch = stripComments(anchoredSlice(indexSrc, "data.type === 'favorite_changed'", { endAnchor: "data.type === 'user_text' && currentSession" }))
  check('TW4j', /clientNotes\.favoriteChanged\(change\)/.test(favBranch) && !/generateReply|sendToFrontend|user_transcript/.test(favBranch),
    'favorite_changed queues context only (no reply, no echo)')
  const userText = stripComments(anchoredSlice(indexSrc, "data.type === 'user_text' && currentSession", { endAnchor: "data.type === 'list_sessions'" }))
  const legIdx = userText.indexOf('parseLegacyFavoriteNotice(')
  check('TW4k', legIdx > 0 && legIdx < userText.indexOf('generateReply') && /clientNotes\.favoriteChanged\(legacyFavorite\)[\s\S]{0,200}return/.test(userText),
    'legacy [favorited] user_text is diverted before generateReply')
  check('TW4l', (indexCode.match(/getAndConsumeClientNotes,/g) || []).length === 2, 'both PipelineDirectLLM constructions get getAndConsumeClientNotes')

  // Pipeline: notes reach the inner ClaudeLLM on a copy; original untouched; meeting chunks skip.
  const { llm } = await import('@livekit/agents')
  const { ClaudeLLM } = await import('../../src/claude-llm.js')
  const { PipelineDirectLLM } = await import('../../src/pipeline-direct-llm.js')
  const chatFn = (PipelineDirectLLM.prototype as any).chat
  check('TW4m', chatFn.constructor.name === 'Function', 'chat() still synchronous')
  let captured: any = null
  const origChat = (ClaudeLLM.prototype as any).chat
  ;(ClaudeLLM.prototype as any).chat = function (args: any) { captured = args; return { fake: true } }
  try {
    const nq = new tw.ClientNoteQueue()
    nq.favoriteChanged({ filePath: 'a.md', fileName: 'a.md', favorited: true })
    const pd = new PipelineDirectLLM({ getAndConsumeInterruptionContext: () => null, getAndConsumeClientNotes: () => nq.drain() } as any)
    const ctx = new llm.ChatContext()
    const item = ctx.addMessage({ role: 'user', content: '[time: x] what next' })
    pd.chat({ chatCtx: ctx })
    const sent = captured?.chatCtx
    const sentText = (sent?.items?.[sent.items.length - 1]?.content || []).join('\n')
    check('TW4o', sent !== ctx && sentText.startsWith('<system-reminder>') && sentText.endsWith('[time: x] what next') && sentText.includes('a.md'),
      'notes prefixed on a COPY that reaches the inner ClaudeLLM')
    check('TW4p', item.content.length === 1 && item.content[0] === '[time: x] what next' && nq.size === 0, 'original item unchanged; notes consumed')
    // With an interrupt template too: notes + template, user words still recoverable.
    nq.favoriteChanged({ filePath: 'c.md', fileName: 'c.md', favorited: true })
    let once = false
    const pd2 = new PipelineDirectLLM({
      getAndConsumeInterruptionContext: () => (once ? null : (once = true, { spokenText: 'heard', recentMessages: 'r', suppressedText: '' })),
      getAndConsumeClientNotes: () => nq.drain(),
    } as any)
    ;(pd2 as any).interruptAgent = async () => {}
    ;(ClaudeLLM.prototype as any).interruptQuery = async () => {}
    const ctx2 = new llm.ChatContext()
    ctx2.addMessage({ role: 'user', content: 'go on' })
    pd2.chat({ chatCtx: ctx2 })
    const t2 = (captured?.chatCtx?.items?.at(-1)?.content || []).join('\n')
    check('TW4q', t2.startsWith('<system-reminder>') && t2.includes('[INTERRUPTED]') && cleanTurnText(t2, 'user') === 'go on',
      'notes compose with the [INTERRUPTED] template; sanitizer recovers the words')
    // Last: a meeting chunk auto-engages the noise gate for the process.
    nq.favoriteChanged({ filePath: 'd.md', fileName: 'd.md', favorited: true })
    const meet = new llm.ChatContext()
    meet.addMessage({ role: 'user', content: '[MEETING — bot1]: Alice: hi' })
    pd.chat({ chatCtx: meet })
    check('TW4n', captured?.chatCtx === meet && nq.size === 1, 'meeting chunk: notes not consumed, ctx untouched')
  } finally {
    ;(ClaudeLLM.prototype as any).chat = origChat
  }
}

// ── TW5 config.ts summary + history ──────────────────────────────────────────
{
  const { getSessionSummary, getConversationHistory, getSessionDir } = await import('../../src/config.js')
  const proj = join(cfgDir, 'tw5-project')
  const dir = getSessionDir(proj)
  mkdirSync(dir, { recursive: true })
  const sid = '0000000a-0000-4000-8000-00000000000a'
  const u = (c: any, extra: any = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content: c }, ...extra })
  const a = (text: string, id: string) => JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }] } })
  const toolUse = (id: string) => JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } })
  const toolResult = () => u([{ type: 'tool_result', tool_use_id: 't', content: 'file body' }])
  const interrupted = `[INTERRUPTED] x\n\nUser's message: "[time: 2026-11-07 01:00 local] ${'q'.repeat(5)} the real ask"\n\nCONTEXT PRESERVATION (READ THIS):\nrest`
  writeFileSync(join(dir, `${sid}.jsonl`), [
    u('[time: 2026-11-07 00:00 local] first question'),
    a('answer part 1', 'm1'), a('answer part 2', 'm1'), toolUse('m2'), toolResult(),
    u('[time: 2026-11-07 00:05 local] [favorited] The user favorited the file a.md.'),
    u('<system-reminder>\nctx\n</system-reminder>'),
    u('meta', { isMeta: true }),
    u(interrupted),
    a('final answer', 'm3'),
  ].join('\n') + '\n')
  const sum = await getSessionSummary(sid, proj)
  // turns: user(first) + assistant m1 (split counted once) + user(interrupted) + assistant m3 = 4
  check('TW5a', sum?.messageCount === 4, `summary uses corrected turn count (got ${sum?.messageCount})`)
  check('TW5b', JSON.stringify(sum?.lastMessages) === JSON.stringify(['first question', 'qqqqq the real ask']),
    `summary lastMessages sanitized, notices/tool rows/meta skipped (got ${JSON.stringify(sum?.lastMessages)})`)
  const hist = await getConversationHistory(sid, proj, 3)
  check('TW5c', hist.length === 3 && hist.map(h => h.content).join('|') === 'answer part 2|qqqqq the real ask|final answer',
    `history: last N real rows, cleaned (got ${JSON.stringify(hist.map(h => h.content))})`)
  const all = await getConversationHistory(sid, proj, 50)
  check('TW5d', !all.some(h => /\[time:|\[favorited\]|system-reminder|tool_result|file body|^meta$/.test(h.content)),
    'history has no tags, notices, injected blocks, tool results or meta rows')
  check('TW5e', all[0]?.content === 'first question' && all[0].role === 'user', 'first row is the clean first question')
}

finish('TRANSCRIPT-WIRING')
