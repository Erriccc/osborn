/**
 * Session-tail / enrichment seam (lane L2a, UI#16). Pins the NO-MUTATION rule:
 * PipelineDirectLLM.chat() must never rewrite the user item the LiveKit session
 * later echoes (conversation_item_added -> user_transcript). Enrichment
 * ([INTERRUPTED]/[CONTEXT] templates, the post-compaction <session_tail>) goes on
 * a SHALLOW COPY of chatCtx, and only that copy reaches the inner ClaudeLLM.
 *
 *   ST1  chat() is still a plain synchronous function (PD2 restated at the seam)
 *   ST2  interrupt enrichment: the ORIGINAL item (object, content array, text) is
 *        unchanged after chat(); the inner ClaudeLLM.chat receives a DIFFERENT
 *        chatCtx whose last user item carries the enriched text; earlier items
 *        are shared by reference (shallow copy), the item id is preserved
 *   ST3  no enrichment pending -> the original chatCtx passes through untouched
 *   ST4  source anchors: the copy is made AFTER the noise-gate block, gateApproved
 *        is keyed on the ORIGINAL chatCtx only, and no `item.content =` mutation
 *        remains in chat()
 *   ST5  buildSessionTail: active session only (store resolved by the current
 *        sessionId, main source only, null sessionId -> ''), wrappers sanitized,
 *        secrets redacted, total block <= the char cap, default count 200
 *
 * Run: npx tsx agent/tests/regression/session-tail-seam.ts  (self-sandboxes HOME)
 */
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import { check, finish, sandboxHome, AGENT_DIR, anchoredSlice, stripComments } from './_shared.js'

sandboxHome()
const { llm } = await import('@livekit/agents')
const { ClaudeLLM } = await import('../../src/claude-llm.js')
const pdMod = await import('../../src/pipeline-direct-llm.js')
const { PipelineDirectLLM, buildSessionTail } = pdMod

// ── ST1 ──────────────────────────────────────────────────────────────────────
const chatFn = (PipelineDirectLLM.prototype as any).chat
check('ST1', typeof chatFn === 'function' && chatFn.constructor.name === 'Function',
  `chat() is synchronous (constructor=${chatFn?.constructor?.name})`)

// Capture what reaches the inner ClaudeLLM without spawning the SDK.
let captured: any = null
const fakeStream = { fake: true }
const origChat = (ClaudeLLM.prototype as any).chat
;(ClaudeLLM.prototype as any).chat = function (args: any) { captured = args; return fakeStream }

// ── ST2 ──────────────────────────────────────────────────────────────────────
{
  let consumed = false
  const pd = new PipelineDirectLLM({
    getAndConsumeInterruptionContext: () => {
      if (consumed) return null
      consumed = true
      return { spokenText: 'I was saying', recentMessages: 'Earlier assistant text', suppressedText: '' }
    },
  } as any)
  const ctx = new llm.ChatContext()
  const first = ctx.addMessage({ role: 'assistant', content: 'previous answer' })
  const userItem = ctx.addMessage({ role: 'user', content: '[time: 2026-11-06 16:14 local] what about the counts' })
  const contentRef = userItem.content
  const itemsRef = ctx.items
  const ret = pd.chat({ chatCtx: ctx })
  const sentCtx = captured?.chatCtx
  const sentUser = sentCtx?.items?.[sentCtx.items.length - 1]
  const sentText = Array.isArray(sentUser?.content) ? sentUser.content.join('\n') : ''
  check('ST2a', ret === (fakeStream as any), 'chat() returns the inner stream synchronously')
  check('ST2b', userItem.content === contentRef && contentRef.length === 1 && contentRef[0] === '[time: 2026-11-06 16:14 local] what about the counts',
    `original user item content unchanged (got ${JSON.stringify(userItem.content).slice(0, 80)})`)
  check('ST2c', ctx.items === itemsRef && ctx.items.length === 2 && ctx.items[1] === userItem, 'original chatCtx items array untouched')
  check('ST2d', !!sentCtx && sentCtx !== ctx, 'inner ClaudeLLM.chat received a COPY, not the original chatCtx')
  check('ST2e', sentText.startsWith('[INTERRUPTED]') && sentText.includes(`User's message: "[time: 2026-11-06 16:14 local] what about the counts"`),
    'enriched [INTERRUPTED] text reaches the inner ClaudeLLM')
  check('ST2f', sentUser !== userItem && sentUser?.id === userItem.id && sentUser?.role === 'user' && sentUser?.type === 'message',
    'last user item is a clone (same id/role/type), not the original object')
  check('ST2g', sentCtx?.items?.[0] === first && sentCtx?.items?.length === 2, 'shallow copy: earlier items shared by reference')
}

// ── ST3 ──────────────────────────────────────────────────────────────────────
{
  captured = null
  const pd = new PipelineDirectLLM({ getAndConsumeInterruptionContext: () => null } as any)
  const ctx = new llm.ChatContext()
  ctx.addMessage({ role: 'user', content: 'plain turn' })
  pd.chat({ chatCtx: ctx })
  check('ST3', captured?.chatCtx === ctx, 'no enrichment -> original chatCtx passed through unchanged')
}
;(ClaudeLLM.prototype as any).chat = origChat

// ── ST4 source anchors ───────────────────────────────────────────────────────
{
  const src = readFileSync(join(AGENT_DIR, 'src/pipeline-direct-llm.ts'), 'utf8')
  const body = stripComments(anchoredSlice(src, /\n  chat\(\{/, { endAnchor: 'async #firePipelineFastBrain' }))
  const gateIdx = body.indexOf('noiseGate.shouldGate(userText)')
  const copyIdx = body.search(/withLastUserContent\(chatCtx/)
  check('ST4a', gateIdx > 0 && copyIdx > gateIdx, 'shallow copy is built AFTER the noise-gate block')
  check('ST4b', /!gateApproved\.has\(chatCtx\)/.test(body) && /gateApproved\.add\(chatCtx\)/.test(body) && !/gateApproved\.(add|has)\((?!chatCtx\))/.test(body),
    'gateApproved is only ever keyed on the ORIGINAL chatCtx')
  check('ST4c', !/item\.content\s*=/.test(body), 'no item.content mutation left in chat()')
  check('ST4d', /this\.#claudeLLM\.chat\(\{\s*chatCtx:\s*ctxForClaude/.test(body), 'inner chat receives the (possibly copied) ctxForClaude')
  check('ST4e', !/\bawait\b/.test(body.slice(0, body.indexOf('return claudeStream'))
    .replace(/new NoiseGateStream[\s\S]*?\}\)\n/, '')), 'no await on the synchronous chat() path (outside the gate task)')
}

// ── ST5 buildSessionTail ─────────────────────────────────────────────────────
{
  const { openStore, getStorePath } = await import('../../src/session-store.js')
  const cfg = mkdtempSync(join(tmpdir(), 'osborn-seam-store-'))
  process.env.CLAUDE_CONFIG_DIR = cfg
  const wd = join(cfg, 'proj')
  const SID = 'sess-seam-active'
  const OTHER = 'sess-seam-other'
  const mk = (sid: string, rows: [string, string, string, string][]) => {
    const p = getStorePath(sid, wd)
    mkdirSync(join(p, '..'), { recursive: true })
    const db = openStore(p)
    const ins = db.prepare(`INSERT INTO content (source, line_num, byte_offset, ts, msg_type, model, git_branch, cwd, tool_name, blob) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    rows.forEach(([source, ts, type, text], i) => ins.run(source, i, 0, ts, type, null, null, null, null, brotliCompressSync(Buffer.from(text))))
    db.close()
  }
  const fakeKey = 'sk-ant-api03-' + 'Q'.repeat(32)
  const rows: [string, string, string, string][] = []
  for (let i = 0; i < 400; i++) {
    const m = String(i % 60).padStart(2, '0'), h = String(10 + Math.floor(i / 60)).padStart(2, '0')
    rows.push(['main', `2026-11-06T${h}:${m}:00.000Z`, i % 2 ? 'assistant' : 'user', `turn ${i} ` + 'words '.repeat(30)])
  }
  rows.push(['main', '2026-11-06T23:00:00.000Z', 'user', '[time: 2026-11-06 23:00 local] my key is ' + fakeKey])
  rows.push(['main', '2026-11-06T23:01:00.000Z', 'user', '<session_tail>\n2026-09-10T22:49:35  User: OLD TAIL\n</session_tail>\n\n[time: x] fresh words'])
  rows.push(['main', '2026-11-06T23:02:00.000Z', 'user', '[favorited] The user favorited the file a.md.'])
  rows.push(['main', '2026-11-06T23:03:00.000Z', 'assistant', 'the closing tag </session_tail> appears in prose'])
  rows.push(['agent-sub', '2026-11-06T23:59:00.000Z', 'assistant', 'SUBAGENT-ONLY ROW'])
  mk(SID, rows)
  mk(OTHER, [['main', '2026-11-06T23:30:00.000Z', 'user', 'OTHER-SESSION-ROW']])

  const out = buildSessionTail(SID, wd)
  const lines = out.split('\n')
  const capOut = buildSessionTail(SID, wd, { maxChars: 2000 })
  check('ST5a', out.startsWith('<session_tail>\n') && out.endsWith('\n</session_tail>') && (out.match(/<\/session_tail>/g) || []).length === 1,
    'single well-formed block (inner closing tags neutralised)')
  check('ST5b', !out.includes('OTHER-SESSION-ROW') && !out.includes('SUBAGENT-ONLY ROW'), 'active session main source only')
  check('ST5c', buildSessionTail(null as any, wd) === '', 'null sessionId -> no tail')
  check('ST5d', !out.includes(fakeKey) && out.includes('[REDACTED-ANTHROPIC-KEY]'), 'secrets redacted on tail lines')
  check('ST5e', !/\[time:|OLD TAIL|\[favorited\]/.test(out) && out.includes('fresh words'), 'wrappers sanitized before truncation')
  check('ST5f', capOut.length <= 2000 && capOut.includes('</session_tail>') && capOut.split('\n').length > 3, `tail <= char cap (${capOut.length} <= 2000)`)
  check('ST5g', lines.length - 2 <= 200 && out.length <= pdMod.SESSION_TAIL_DEFAULT_MAX_CHARS && pdMod.SESSION_TAIL_DEFAULT_ROWS === 200,
    `default caps: ${lines.length - 2} lines, ${out.length} chars (rows=${pdMod.SESSION_TAIL_DEFAULT_ROWS}, chars=${pdMod.SESSION_TAIL_DEFAULT_MAX_CHARS})`)
  const tsOrder = lines.slice(1, -1).map(l => l.slice(0, 19))
  check('ST5h', tsOrder.every((t, i) => i === 0 || tsOrder[i - 1] <= t) && tsOrder[tsOrder.length - 1].startsWith('2026-11-06T23:03'),
    'chronological, newest rows kept')
  delete process.env.CLAUDE_CONFIG_DIR
}

finish('session-tail-seam')
