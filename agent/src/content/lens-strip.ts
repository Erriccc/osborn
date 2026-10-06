/**
 * lens-strip.ts — strip every INJECTED / SUMMARISED context from a raw
 * session.db conversation row before it can reach the content lens. Pure.
 *
 * The lens must see only what the person and the assistant actually said.
 * Harness injections live in USER-type rows (the SDK/pipeline prepends or
 * appends them to the real utterance), so the block strippers run on user rows
 * only — assistant text is never altered here (it may legitimately mention a
 * tag name; secret/client redaction still applies to it downstream).
 *
 * Kinds (counted per affected row):
 *   compaction-summary  "This session is being continued from a previous conversation…",
 *                       or a line-start "=== HANDOFF_STATE ===" / "=== DECISIONS ===" style section header → row dropped
 *                       (a bare mention of HANDOFF_STATE in real speech is kept)
 *   silent-control      "[SYSTEM — SILENT CONTROL MESSAGE…]" orchestrator nudges → row dropped
 *   session-tail        <session_tail>…</session_tail> blocks (post-compaction replay)
 *   recalled-context    <recalled_context>…</recalled_context> blocks (recall injection)
 *   system-reminder     <system-reminder…>…</system-reminder> blocks
 *   turn-shape          the turn-shape reminder text (prompts/turn-shape-reminder.md)
 *   task-notification   <task-notification>…</task-notification> blocks
 *   hook-context        UserPromptSubmit hook additional context (<user-prompt-submit-hook>, labelled lines)
 * [INTERRUPTED]/[CONTEXT] wrappers are unwrapped afterwards by sanitizeRecord
 * (transcript-sanitizer.ts), which keeps only the user's own quoted words.
 */

export const STRIP_KINDS = [
  'compaction-summary',
  'silent-control',
  'session-tail',
  'recalled-context',
  'system-reminder',
  'turn-shape',
  'task-notification',
  'hook-context',
] as const
export type StripKind = (typeof STRIP_KINDS)[number]

export interface StripResult {
  /** Remaining text (trimmed), or null when the whole row was injected content. */
  text: string | null
  kinds: StripKind[]
}

const COMPACTION_LEAD_RE = /^\s*(?:\[time:[^\]]*\]\s*)?(?:This session is being continued from a previous conversation|Conversation compacted\b)/i
/** Only a line-start `=== SECTION ===` header is compaction evidence; a bare mention of a section name is speech. */
const COMPACTION_SECTION_RE = /^[ \t]*===[ \t]*(?:DECISIONS|GOTCHAS|LEARNINGS|HANDOFF[_ ]STATE|OPEN QUESTIONS|NEXT STEPS)[ \t]*===[ \t]*$/m
const SILENT_CONTROL_RE = /^\s*(?:\[time:[^\]]*\]\s*)?\[SYSTEM\s*[—–-]+\s*SILENT CONTROL MESSAGE/i

/**
 * Paired blocks; open tags may carry attributes. An UNTERMINATED opening tag swallows
 * the rest of the row only when it starts the row or a line — an inline mention
 * ("the <system-reminder> tag is noisy") is the person's own words and is kept.
 */
const BLOCKS: { kind: StripKind; open: RegExp; close: RegExp }[] = [
  { kind: 'session-tail', open: /<session_tail\b[^>]*>/g, close: /<\/session_tail>/ },
  { kind: 'recalled-context', open: /<recalled_context\b[^>]*>/g, close: /<\/recalled_context>/ },
  { kind: 'system-reminder', open: /<system-reminder\b[^>]*>/g, close: /<\/system-reminder>/ },
  { kind: 'task-notification', open: /<task-notification\b[^>]*>/g, close: /<\/task-notification>/ },
  { kind: 'hook-context', open: /<user-prompt-submit-hook\b[^>]*>/g, close: /<\/user-prompt-submit-hook>/ },
]
/** What may precede an unterminated open tag on its line for it to count as line-start. */
const LINE_START_PREFIX_RE = /^\s*(?:\[time:[^\]]*\]\s*)?$/

/** Turn-shape reminder: first line of prompts/turn-shape-reminder.md (or its header) → its last line. */
const TURN_SHAPE_START = /You are thinking with this person, not for them\.|\[TURN-SHAPE REMINDER\b[^\]]*\]/
const TURN_SHAPE_END = /The user is a peer thinking with you, not pressing buttons\.?/

/** Labelled hook-context paragraphs as Claude Code renders them in transcripts. */
const HOOK_LINE_RE = /^[ \t]*(?:UserPromptSubmit|SessionStart|PreToolUse|PostToolUse)(?::[^\n]*)? hook additional context:[^\n]*(?:\n(?![ \t]*\n)[^\n]*)*/gim

function stripBlock(text: string, open: RegExp, close: RegExp): { text: string; hit: boolean } {
  let out = text
  let hit = false
  let from = 0
  for (let guard = 0; guard < 50; guard++) {
    open.lastIndex = from
    const o = open.exec(out)
    if (!o) break
    const after = o.index + o[0].length
    const c = close.exec(out.slice(after))
    const lineStart = out.lastIndexOf('\n', o.index - 1) + 1
    const atLineStart = LINE_START_PREFIX_RE.test(out.slice(lineStart, o.index))
    // An inline open whose "close" belongs to a later, re-opened block is a mention, not a block.
    const reopened = c ? new RegExp(open.source).test(out.slice(after, after + c.index)) : false
    let end: number
    if (c && (atLineStart || !reopened)) {
      end = after + c.index + c[0].length
    } else if (!c && atLineStart) {
      end = out.length
    } else {
      from = after // inline mention: keep it
      continue
    }
    hit = true
    out = out.slice(0, o.index) + '\n' + out.slice(end)
    from = o.index
  }
  open.lastIndex = 0
  return { text: out, hit }
}

/** Strip injected context from one row. Assistant rows pass through unchanged. */
export function stripInjected(raw: string, speaker: 'user' | 'assistant'): StripResult {
  const text0 = raw ?? ''
  if (speaker !== 'user') return { text: text0.trim() || null, kinds: [] }
  const kinds: StripKind[] = []
  // Whole-row injections first (no genuine user words in them).
  if (SILENT_CONTROL_RE.test(text0)) return { text: null, kinds: ['silent-control'] }
  let text = text0
  for (const b of BLOCKS) {
    const r = stripBlock(text, b.open, b.close)
    if (r.hit) {
      text = r.text
      kinds.push(b.kind)
    }
  }
  // A compaction summary is judged on what is left once replay blocks are gone.
  // [INTERRUPTED]/[CONTEXT] wrappers quote the assistant's own recent messages, which may
  // mention these markers — those rows are unwrapped by sanitizeRecord instead, never dropped here.
  const wrapper = /^\s*(?:\[time:[^\]]*\]\s*)?\[(?:INTERRUPTED|CONTEXT)\]/.test(text)
  if (COMPACTION_LEAD_RE.test(text) || (!wrapper && COMPACTION_SECTION_RE.test(text))) return { text: null, kinds: [...kinds, 'compaction-summary'] }
  if (SILENT_CONTROL_RE.test(text)) return { text: null, kinds: [...kinds, 'silent-control'] }
  const ts = TURN_SHAPE_START.exec(text)
  if (ts) {
    const rest = text.slice(ts.index)
    const te = TURN_SHAPE_END.exec(rest)
    const end = te ? ts.index + te.index + te[0].length : text.length
    text = text.slice(0, ts.index) + '\n' + text.slice(end)
    kinds.push('turn-shape')
  }
  const hooked = text.replace(HOOK_LINE_RE, '')
  if (hooked !== text) {
    text = hooked
    if (!kinds.includes('hook-context')) kinds.push('hook-context')
  }
  const out = text.replace(/\n{3,}/g, '\n\n').trim()
  return { text: out || null, kinds }
}
