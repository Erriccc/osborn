/**
 * transcript-clean.ts — client-safe, pure display cleaner for session text
 * (titles, previews, chat bubbles, history rows).
 *
 * This is the frontend port of the agent's shared transcript sanitizer
 * (agent/src/content/transcript-sanitizer.ts `cleanTurnText` +
 * agent/src/content/lens-strip.ts). The frontend cannot import agent code, so the
 * rules are mirrored here; keep the two in step. It strips the pipeline wrapper
 * text that must never be rendered:
 *   - the `[time: YYYY-MM-DD HH:MM local]` tag the composer prepends to typed turns
 *   - `<session_tail>`, `<recalled_context>`, `<system-reminder>`,
 *     `<task-notification>`, `<user-prompt-submit-hook>` blocks
 *   - the `[INTERRUPTED]` / `[CONTEXT]` templates (keeps only the user's words)
 *   - client/system notices: `[SYSTEM…]`, `[favorited]`, `[welcome-back]`,
 *     `[liked]`, `[SCRIPT]`/`[PROACTIVE]`/`[NOTIFICATION]`, compaction summaries,
 *     `[Request interrupted…]`, `[EMERGENCY STOP]`, `[BACKGROUND_INIT]`
 * Differences from the agent on purpose (display, not export): `[MEETING —]`
 * lines are kept (the dashboard formats them), attachment markers are kept
 * (MessageContent renders them), and no secret redaction runs here.
 */

const TIME_PREFIX_RE = /^\[time:[^\]]*\]\s*/

const BLOCK_TAGS = ['session_tail', 'recalled_context', 'system-reminder', 'task-notification', 'user-prompt-submit-hook']

const DROP_PREFIXES: RegExp[] = [
  /^<task-notification>/,
  /^\[Request interrupted by user/,
  /^<local-command-/,
  /^<command-name>/,
  /^\[EMERGENCY STOP\]/,
  /^\[BACKGROUND_INIT\]/,
  /^\[liked\]/,
  /^\[favorited\]/,
  /^\[welcome-back\]/,
  /^\[(?:SCRIPT|PROACTIVE|NOTIFICATION)\]/,
  /^\[SYSTEM(?:\]|\s*[—:-])/,
  /^This session is being continued/,
  /^Conversation compacted\b/,
  /^<system-reminder>/,
]

// Markers of the agent's interruption templates (pipeline-direct-llm.ts). Any of
// these means the text is a wrapper, never the user's own words.
const HARNESS_MARKERS = [
  'CONTEXT PRESERVATION (READ THIS):',
  'What the user heard before cutoff',
  'WHAT THE USER DID NOT HEAR',
  'Text you produced that the user did NOT hear',
  'Text you generated while the user was speaking',
  'RESPOND with speech first',
]

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Remove injected blocks. Paired blocks go anywhere; an unterminated opening tag
 * swallows the rest only when it starts a line (an inline mention is speech). */
function stripBlocks(text: string): string {
  let out = text
  for (const tag of BLOCK_TAGS) {
    const t = escapeRe(tag)
    out = out.replace(new RegExp(`<${t}\\b[^>]*>[\\s\\S]*?<\\/${t}>`, 'g'), '\n')
    out = out.replace(new RegExp(`(^|\\n)[ \\t]*(?:\\[time:[^\\]]*\\][ \\t]*)?<${t}\\b[^>]*>(?![\\s\\S]*<\\/${t}>)[\\s\\S]*$`), '$1')
  }
  return out
}

function unwrapTemplate(text: string): string | null {
  const interrupted = text.match(/User's message:\s*"([\s\S]*?)"\s*(?:\n\s*)*CONTEXT PRESERVATION \(READ THIS\):/)
  if (interrupted) return interrupted[1]
  const context = text.match(/What the user is saying now:\s*\n\s*"([\s\S]*?)"\s*(?:\n\s*)*Text you produced that the user did NOT hear:/)
  if (context) return context[1]
  // Fallbacks (template cut short): quote closed at end of a line / the text.
  const loose = text.match(/(?:User's message|What the user is saying now):\s*"([\s\S]*?)"\s*(?:\n|$)/)
  if (loose) return loose[1]
  // Truncated wrapper: the closing quote (and the trailing CONTEXT/"Text you
  // produced" anchor) was cut off mid-turn — a LONG user turn served over a
  // path that truncates the raw enriched message before the words finish.
  // Without this the whole bubble is dropped (bug: "long spoken turns missing —
  // cut before the words"). Recover whatever user words survive after the
  // opening quote so the partial turn still renders. Only reached once `wrapped`
  // is set, so it never touches a normal turn. Mirrors the agent sanitizer's
  // open-ended `User's message: "…"$` fallback (transcript-sanitizer.ts).
  const openEnded = text.match(/(?:User's message|What the user is saying now):[ \t]*\n?[ \t]*"([\s\S]+)$/)
  if (openEnded) return openEnded[1].replace(/"\s*$/, '')
  return null
}

function isDropped(text: string): boolean {
  return DROP_PREFIXES.some((re) => re.test(text))
}

/**
 * Strip pipeline wrappers from one turn's text. Returns the user's/assistant's
 * actual words, or null when nothing real remains (a notice, a bare tail, an
 * unrecoverable template). Pure.
 */
export function stripSessionWrappers(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  let out = text
  // Leading tag and leading blocks in any order, until stable.
  for (let prev = ''; prev !== out; ) {
    prev = out
    out = stripBlocks(out).trimStart().replace(TIME_PREFIX_RE, '')
  }
  out = out.trim()
  if (!out) return null
  if (isDropped(out)) return null

  const wrapped = /^\[(?:INTERRUPTED|CONTEXT)\]/.test(out) || HARNESS_MARKERS.some((m) => out.includes(m))
  if (wrapped) {
    const inner = unwrapTemplate(out)
    if (inner === null) return null
    out = inner.trimStart().replace(TIME_PREFIX_RE, '').trim()
    if (!out || isDropped(out)) return null
  }
  // A block stripped mid-text can leave a bare trailing marker behind.
  out = out.replace(/\s*\[INTERRUPTED\]\s*$/, '').trim()
  return out || null
}

function formatFallbackDate(date?: Date | string | number | null): string {
  if (date === undefined || date === null || date === '') return 'untitled'
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return 'untitled'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * Display-safe session text. Never returns an empty string: when nothing real
 * remains it falls back to "Voice session - <date>" (date of the session, when
 * known). Use for titles and previews; use stripSessionWrappers when a caller
 * needs to know that a turn was notice-only.
 */
export function cleanSessionText(text: string | null | undefined, date?: Date | string | number | null): string {
  return stripSessionWrappers(text) ?? `Voice session - ${formatFallbackDate(date)}`
}
