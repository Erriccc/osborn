/**
 * transcript-sanitizer.ts
 * ------------------------------------------------------------------------
 * STANDALONE, OFFLINE transcript sanitizer for the Osborn content pipeline.
 *
 * This module is NOT wired into the live voice runtime. It is a pure,
 * importable function + a CLI. It reads a saved transcript (session JSONL
 * today; arbitrary text / media later) and emits clean, per-utterance
 * USER-speech records with live credentials masked out.
 *
 * It only *references* the live agent's marker formats (read-only) to stay
 * faithful to what the runtime actually writes:
 *   - [INTERRUPTED] / [CONTEXT] templates ....... pipeline-direct-llm.ts
 *   - <session_tail> post-compaction block ...... pipeline-direct-llm.ts (buildSessionTail)
 * Do NOT import from the live agent here — the anchors are inlined as
 * verified string constants so this module stays self-contained.
 *
 * ========================= ARCHITECTURE =========================
 * Two cleanly separated layers:
 *
 *   (1) INPUT ADAPTERS  — format-specific. Their ONLY job is to parse a
 *       source and YIELD normalized raw records: { text, timestamp, speaker? }.
 *       The core never sees JSONL / text / media specifics.
 *         - sessionJsonlAdapter(path)   -> reads a Claude session .jsonl
 *         - plainTextAdapter(text, ...)  -> reads a raw pasted transcript
 *         - mediaAdapter (STUB)          -> would TRANSCRIBE audio/video first
 *
 *   (2) CLEANING CORE   — fully source-independent and PURE. Runs identically
 *       whether the text came from JSONL, a pasted string, or a future STT
 *       transcript of an MP4. Applies the verified drop/unwrap/strip ruleset
 *       and the secret-redaction mask list, and returns SanitizedRecord[].
 * ================================================================
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ============================================================================
// Shared types (the contract between adapters and the core)
// ============================================================================

/** Normalized raw record produced by ANY adapter and consumed by the core. */
export interface RawRecord {
  /** Raw utterance text, exactly as stored/transcribed (may still be wrapped in a template). */
  text: string
  /** ISO-8601 timestamp for the utterance. */
  timestamp: string
  /** Optional speaker label (e.g. "user"). Informational only; the core keeps all real utterances. */
  speaker?: string
}

/** A cleaned, per-utterance speech record emitted by the core. */
export interface SanitizedRecord {
  /** Cleaned utterance text (unwrapped, stripped, secret-masked). */
  text: string
  /** ISO-8601 timestamp carried through from the source entry. */
  timestamp: string
  /**
   * Who produced the utterance. Carried through from the adapter so downstream
   * knows who said what. Defaults to 'user' when the adapter did not label it.
   */
  speaker: 'user' | 'assistant'
  /** True if the text was unwrapped from an [INTERRUPTED] / [CONTEXT] template. */
  wrapped: boolean
  /**
   * Placeholder flag for downstream rendering. Original audio is treated as
   * OPTIONAL — renderers fall back to text when it's absent. We only CARRY the
   * flag here; no audio logic is implemented in this module. Defaults to false.
   */
  audioAvailable?: boolean
}

export type SanitizeAction = 'clean' | 'unwrap' | 'drop'

/** Per-record result, exposing WHY a record was kept/dropped (for stats/tests). */
export interface SanitizeOutcome {
  record: SanitizedRecord | null
  action: SanitizeAction
}

export interface SanitizeStats {
  /** Raw records handed to the core (text-bearing utterances). */
  input: number
  dropped: number
  unwrapped: number
  /** Kept with no template unwrap (plain passthrough after strip/redact). */
  clean: number
}

/**
 * Adapter contract. Every input format — JSONL, plain text, and (future)
 * transcribed audio/video — resolves to the SAME normalized record stream.
 */
export type TranscriptAdapter = () => RawRecord[]

// ============================================================================
// SECRET REDACTION (source-independent, runs on the FINAL kept text)
// ----------------------------------------------------------------------------
// These transcripts contain LIVE credentials (a real npm token was found in
// session c97588f4). We MASK, never drop — the surrounding sentence stays
// intact so the utterance remains readable.
//
// Length floors matter: benign prose legitimately contains bare substrings
// like "task-budgets" (has "sk-"), "fo1_/sbp_/xox/Bearer patterns", etc. The
// floors ensure we only mask real key-shaped tokens and never mangle words.
// ============================================================================

interface SecretRule {
  kind: string
  /** Global regex. Capture groups allowed; `replace` controls the substitution. */
  re: RegExp
  replace: string
}

/**
 * Order matters. Specific, high-confidence token shapes run FIRST so their KIND
 * label wins; the broad `*_API_KEY=/_SECRET=/_TOKEN=` assignment rule runs LAST
 * to catch any leftover generic value assignment (and skips already-redacted
 * values via a negative lookahead).
 */
export const SECRET_RULES: SecretRule[] = [
  // npm registry auth line (contains an npm_ token; redact the whole value).
  {
    kind: 'NPM-AUTH',
    re: /\/\/registry\.npmjs\.org\/:_authToken=[^\s"'`]+/g,
    replace: '//registry.npmjs.org/:_authToken=[REDACTED-NPM-AUTH]',
  },
  // npm granular/automation token: npm_ + 36 base62 chars.
  { kind: 'NPM-TOKEN', re: /npm_[A-Za-z0-9]{36}/g, replace: '[REDACTED-NPM-TOKEN]' },
  // Fly.io macaroon tokens. A real token is a COMMA-SEPARATED list of
  // segments ("FlyV1 fm2_<a>,fm2_<b>,fm2_<c>"); redact the WHOLE list, not just
  // the first segment (the segment char class has no comma, so the old rule
  // stopped at the first "," and leaked the rest).
  {
    kind: 'FLY-TOKEN',
    re: /FlyV1\s+fm[12]_[A-Za-z0-9/+_=-]+(?:\s*,\s*fm[12]_[A-Za-z0-9/+_=-]+)*/g,
    replace: '[REDACTED-FLY-TOKEN]',
  },
  // Standalone Fly macaroon segment without the FlyV1 prefix (floor skips bare
  // "fm2_" word mentions).
  {
    kind: 'FLY-TOKEN',
    re: /(?<![A-Za-z0-9])fm[12]_[A-Za-z0-9/+_=-]{20,}/g,
    replace: '[REDACTED-FLY-TOKEN]',
  },
  // Fly GraphQL fo1_ token (floor skips bare "fo1_" word mentions).
  { kind: 'FLY-TOKEN', re: /fo1_[A-Za-z0-9/+_=-]{20,}/g, replace: '[REDACTED-FLY-TOKEN]' },
  // Supabase personal access token (real = 40 hex; floor skips "sbp_/" prose).
  { kind: 'SUPABASE-PAT', re: /sbp_[A-Za-z0-9]{20,}/g, replace: '[REDACTED-SUPABASE-PAT]' },
  // PEM private key blocks (multiline). Terminated block first, then a
  // truncated/unterminated block (header + base64 body, literal "\n" allowed).
  {
    kind: 'PEM-PRIVATE-KEY',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '[REDACTED-PEM-PRIVATE-KEY]',
  },
  {
    kind: 'PEM-PRIVATE-KEY',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\sA-Za-z0-9+/=]|\\n)*/g,
    replace: '[REDACTED-PEM-PRIVATE-KEY]',
  },
  // Anthropic keys: sk-ant-api03-…, sk-ant-oat01-… (MUST run before OPENAI-KEY).
  { kind: 'ANTHROPIC-KEY', re: /sk-ant-[A-Za-z0-9_-]{20,}/g, replace: '[REDACTED-ANTHROPIC-KEY]' },
  // OpenRouter / OpenAI prefixed keys whose body contains _ or - (sk-or-v1-, sk-proj-, sk-svcacct-).
  {
    kind: 'OPENAI-KEY',
    re: /\bsk-(?:or-v1-|or-|proj-|svcacct-)[A-Za-z0-9_-]{20,}/g,
    replace: '[REDACTED-OPENAI-KEY]',
  },
  // OpenAI / OpenRouter keys (sk-, sk-or-, sk-proj-). Floor skips "task-budgets".
  { kind: 'OPENAI-KEY', re: /sk-(?:or-|proj-)?[A-Za-z0-9]{20,}/g, replace: '[REDACTED-OPENAI-KEY]' },
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ (+ fine-grained github_pat_).
  { kind: 'GITHUB-TOKEN', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, replace: '[REDACTED-GITHUB-TOKEN]' },
  { kind: 'GITHUB-TOKEN', re: /\bgithub_pat_[A-Za-z0-9_]{30,}/g, replace: '[REDACTED-GITHUB-TOKEN]' },
  // Google API key.
  { kind: 'GOOGLE-API-KEY', re: /AIza[0-9A-Za-z_-]{35}/g, replace: '[REDACTED-GOOGLE-API-KEY]' },
  // Fireworks AI key: fw_ + ~24 base62 chars. Floor of 20 pure alphanumerics
  // skips snake_case identifiers like "fw_key" / "fw_test_script".
  {
    kind: 'FIREWORKS-KEY',
    re: /(?<![A-Za-z0-9_])fw_[A-Za-z0-9]{20,}/g,
    replace: '[REDACTED-FIREWORKS-KEY]',
  },
  // Soniox project key: snx_proj_ + key body (floor skips bare prefix mentions).
  {
    kind: 'SONIOX-KEY',
    re: /(?<![A-Za-z0-9_])snx_proj_[A-Za-z0-9_-]{20,}/g,
    replace: '[REDACTED-SONIOX-KEY]',
  },
  // JWTs (header.payload.signature, base64url).
  {
    kind: 'JWT',
    re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replace: '[REDACTED-JWT]',
  },
  // API-key headers: x-api-key, x-goog-api-key (Gemini REST), and generic api-key
  // (Azure etc.) — curl -H, JSON headers, raw HTTP. Keeps the header name, masks
  // the value. Floor of 8 skips prose like "x-api-key: header".
  {
    kind: 'X-API-KEY',
    // (?!\$) skips $VAR / ${var} references — not secrets, just noise.
    re: /(\b(?:x-goog-|x-)?api-key["'`]?\s*[:=]\s*["'`]?)(?!\[REDACTED|\$)[^\s"'`,;}]{8,}/gi,
    replace: '$1[REDACTED-API-KEY]',
  },
  // Authorization header (optional Bearer/Basic/Token scheme). Keeps name +
  // scheme, masks the credential.
  {
    kind: 'AUTH-HEADER',
    re: /(Authorization["'`]?\s*:\s*["'`]?(?:(?:Bearer|Basic|Token)\s+)?)(?!\[REDACTED|\$)[^\s"'`,;}]{8,}/gi,
    replace: '$1[REDACTED-AUTH]',
  },
  // Slack tokens xoxb-/xoxa-/xoxp-/xoxr-/xoxs- (floor skips "xox/" prose).
  { kind: 'SLACK-TOKEN', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replace: '[REDACTED-SLACK-TOKEN]' },
  // AWS access key id.
  { kind: 'AWS-KEY', re: /\bAKIA[0-9A-Z]{16}\b/g, replace: '[REDACTED-AWS-KEY]' },
  // Generic Bearer token (keep the word "Bearer"; floor skips "Bearer patterns").
  { kind: 'BEARER', re: /Bearer\s+[A-Za-z0-9._\-+/=]{20,}/g, replace: 'Bearer [REDACTED-TOKEN]' },
  // Generic *_API_KEY= / *_SECRET= / *_TOKEN= / *_ACCESS_KEY= / *_PASSWORD= assignments.
  // Keeps NAME= and any surrounding quote; masks only the value. Skips values
  // already replaced by a specific rule above (negative lookahead on [REDACTED).
  {
    kind: 'ENV-SECRET',
    re: /\b([A-Za-z0-9_]*(?:API_KEY|SECRET|ACCESS_KEY|PASSWORD|TOKEN))(\s*=\s*)(["'`“”]?)(?!\[REDACTED)([^\s"'`“”]{6,})\3/g,
    replace: '$1$2$3[REDACTED-ENV-SECRET]$3',
  },
]

/**
 * Conservative high-entropy fallback, applied to ASSISTANT records only (the
 * assistant echoes tool output, so unknown-vendor keys can leak there). Matches
 * a standalone 32+ char token of [A-Za-z0-9_+=-] that has at least one
 * uppercase, one lowercase, and four digits. Mixed-case + digit floor skips
 * git SHAs / sha256 hex / UUIDs (lowercase) and CONSTANT_NAMES (no lowercase);
 * the "/" and "." boundaries skip paths and dotted identifiers. Measured 0 hits
 * across 2508 real assistant records in session c97588f4 (no false positives).
 */
export const HIGH_ENTROPY_RULE: SecretRule = {
  kind: 'HIGH-ENTROPY',
  re: /(?<![A-Za-z0-9_+=\/.\[-])(?=[A-Za-z0-9_+=-]*[A-Z])(?=[A-Za-z0-9_+=-]*[a-z])(?=(?:[A-Za-z0-9_+=-]*\d){4})[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=\/.\]-])/g,
  replace: '[REDACTED-HIGH-ENTROPY]',
}

export interface SecretScanOptions {
  /** Treat as an assistant record: also apply the high-entropy fallback. */
  assistant?: boolean
}

function rulesFor(opts: SecretScanOptions = {}): SecretRule[] {
  return opts.assistant ? [...SECRET_RULES, HIGH_ENTROPY_RULE] : SECRET_RULES
}

/** Mask every secret-shaped substring in `text`. Pure. */
export function redactSecrets(text: string, opts: SecretScanOptions = {}): string {
  let out = text
  for (const rule of rulesFor(opts)) {
    out = out.replace(rule.re, rule.replace)
  }
  return out
}

/**
 * Detector used by the verification harness: returns the list of secret KINDs
 * that STILL match `text`. The authoritative "no secret survives" invariant is
 * `detectSecrets(output).length === 0`. This is precise (uses the same shapes
 * as redaction) rather than a naive substring scan, which would false-positive
 * on benign prose like "task-budgets" or "fo1_/sbp_/xox/Bearer patterns".
 */
export function detectSecrets(
  text: string,
  opts: SecretScanOptions = {}
): { kind: string; match: string }[] {
  const hits: { kind: string; match: string }[] = []
  for (const rule of rulesFor(opts)) {
    // Fresh regex so lastIndex state never leaks between calls.
    const re = new RegExp(rule.re.source, rule.re.flags)
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      // The ENV-SECRET rule legitimately leaves a "NAME=[REDACTED-...]" shell;
      // that is NOT a surviving secret, so ignore matches whose value is already redacted.
      if (m[0].includes('[REDACTED')) {
        if (m.index === re.lastIndex) re.lastIndex++
        continue
      }
      hits.push({ kind: rule.kind, match: m[0] })
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }
  return hits
}

// ============================================================================
// VERIFIED STRIP / UNWRAP RULESET (source-independent, pure)
// Grounded in real analysis of session c97588f4. Anchors confirmed against
// pipeline-direct-llm.ts (read-only) and against the live JSONL.
// ============================================================================

/** Rule 1 — leading markers whose entries are DROPPED whole. */
const DROP_PREFIXES: RegExp[] = [
  /^<task-notification>/,
  /^\[Request interrupted by user/, // includes the "... for tool use]" variant
  /^<local-command-/,
  /^<command-name>/,
  /^\[EMERGENCY STOP\]/,
  /^\[BACKGROUND_INIT\]/,
  /^\[liked\]/,
  /^\[SYSTEM\]/,
  /^\[MEETING —/,
  /^This session is being continued/,
  /^<system-reminder>/,
  // Pasted "[hh:mm] System:/You:/Osborn:" transcript blocks.
  /^\[\d{1,2}:\d{2}\]\s+(System|You|Osborn):/,
]

// Rule 2 anchors — [INTERRUPTED] template (pipeline-direct-llm.ts ~L257-275).
const INTERRUPTED_PREFIX = '[INTERRUPTED]'
// Rule 3 anchors — [CONTEXT] template (pipeline-direct-llm.ts ~L293-298).
const CONTEXT_PREFIX = '[CONTEXT]'

/** Rule 4 — leading "[time: YYYY-MM-DD HH:MM local] " prefix. */
const TIME_PREFIX_RE = /^\[time:[^\]]*\]\s*/

/**
 * Rule 5b (CONFIRMED). The source analysis flagged the post-compaction session
 * tail as UNVERIFIED. We confirmed the exact anchor in pipeline-direct-llm.ts:
 * buildSessionTail() wraps the block as `<session_tail> ... </session_tail>` and
 * PREPENDS it (+ "\n\n") to the next real user turn. So we strip a LEADING
 * <session_tail>...</session_tail> block and re-process the remainder (which may
 * itself be an [INTERRUPTED]/[CONTEXT] template or a plain utterance).
 */
const SESSION_TAIL_RE = /^<session_tail>[\s\S]*?<\/session_tail>\s*/

/** Rule 2 — unwrap [INTERRUPTED]: keep only the quoted `User's message: "…"`. */
function unwrapInterrupted(text: string): string | null {
  // User's message line sits just before the CONTEXT PRESERVATION line.
  const m = text.match(/User's message:\s*"([\s\S]*?)"\s*(?:\n\s*)*CONTEXT PRESERVATION \(READ THIS\):/)
  if (m) return m[1]
  // Defensive fallback: quote with no trailing CONTEXT PRESERVATION anchor.
  const m2 = text.match(/User's message:\s*"([\s\S]*?)"\s*$/)
  return m2 ? m2[1] : null
}

/**
 * Rule 3 — unwrap [CONTEXT] (suppressed-text template): keep only the text after
 * `What the user is saying now:\n"` up to the closing quote that precedes
 * `Text you produced that the user did NOT hear:`. Everything else in the
 * template is AGENT speech and is discarded.
 */
function unwrapContext(text: string): string | null {
  const m = text.match(
    /What the user is saying now:\s*\n\s*"([\s\S]*?)"\s*(?:\n\s*)*Text you produced that the user did NOT hear:/
  )
  if (m) return m[1]
  const m2 = text.match(/What the user is saying now:\s*\n\s*"([\s\S]*?)"\s*$/)
  return m2 ? m2[1] : null
}

/** Rule 5 — strip trailing attachment blocks. Loops until stable. Pure. */
function stripTrailingAttachments(text: string): string {
  let prev: string
  let out = text
  const patterns: RegExp[] = [
    // [File: ...], [Image: ...], [Image attached: ...] possibly with a (url) tail.
    /\s*\n*\[(?:File|Image)(?: attached)?:[^\]\n]*\](?:\([^)\n]*\))?\s*$/,
    /\s*\[(?:File|Image)(?: attached)?:[^\]\n]*\](?:\([^)\n]*\))?\s*$/,
    // [Image #N]
    /\s*\n*\[Image #\d+\]\s*$/,
    // "… [full content in attached file]" tail
    /\s*(?:…|\.\.\.)?\s*\[full content in attached file\]\s*$/,
  ]
  do {
    prev = out
    for (const re of patterns) out = out.replace(re, '')
  } while (out !== prev)
  return out
}

/**
 * CORE per-record sanitizer. Pure and source-independent: identical behavior
 * whether `raw.text` came from JSONL, pasted text, or a future STT transcript.
 *
 * Pipeline order:
 *   A. strip leading <session_tail> block (5b)         -> reprocess remainder
 *   B. strip leading [time: …] prefix (4)
 *   C. DROP whole entry if it leads with a drop marker (1)
 *   D. UNWRAP [INTERRUPTED] (2) / [CONTEXT] (3)         -> wrapped=true
 *   E. strip trailing attachment blocks (5)
 *   F. redact secrets (6)
 *   G. trim; drop if empty
 * Rule 7: filler words ("um", "uh", stutters) are NEVER normalized.
 * Rule 7b: nothing in the source cleanly marks voice-vs-typed, so we do NOT
 *          filter on that — every real utterance is included.
 */
export function sanitizeRecord(raw: RawRecord): SanitizeOutcome {
  let text = raw.text ?? ''
  let wrapped = false

  // A. Leading post-compaction session tail (confirmed anchor).
  text = text.replace(SESSION_TAIL_RE, '')

  // B. Leading [time: …] prefix.
  text = text.replace(TIME_PREFIX_RE, '')

  const lead = text.trimStart()

  // C. Drop markers.
  for (const re of DROP_PREFIXES) {
    if (re.test(lead)) return { record: null, action: 'drop' }
  }

  // D. Unwrap templates.
  if (lead.startsWith(INTERRUPTED_PREFIX)) {
    const inner = unwrapInterrupted(lead)
    if (inner === null) return { record: null, action: 'drop' } // malformed template, no user text
    text = inner
    wrapped = true
  } else if (lead.startsWith(CONTEXT_PREFIX)) {
    const inner = unwrapContext(lead)
    if (inner === null) return { record: null, action: 'drop' }
    text = inner
    wrapped = true
  }

  // E. Trailing attachments.
  text = stripTrailingAttachments(text)

  // F. Secret redaction (on the final kept text). Assistant records also get
  // the high-entropy fallback (they echo tool output).
  text = redactSecrets(text, { assistant: raw.speaker === 'assistant' })

  // G. Trim; drop if nothing real remains.
  text = text.trim()
  if (!text) return { record: null, action: 'drop' }

  const speaker: 'user' | 'assistant' = raw.speaker === 'assistant' ? 'assistant' : 'user'
  return {
    record: { text, timestamp: raw.timestamp, speaker, wrapped, audioAvailable: false },
    action: wrapped ? 'unwrap' : 'clean',
  }
}

/** Run the core over a record stream and return kept SanitizedRecords. Pure. */
export function sanitizeTranscript(records: Iterable<RawRecord>): SanitizedRecord[] {
  const out: SanitizedRecord[] = []
  for (const r of records) {
    const { record } = sanitizeRecord(r)
    if (record) out.push(record)
  }
  return out
}

/** Like sanitizeTranscript but also returns drop/unwrap/clean counts. Pure. */
export function sanitizeTranscriptDetailed(
  records: Iterable<RawRecord>
): { records: SanitizedRecord[]; stats: SanitizeStats } {
  const out: SanitizedRecord[] = []
  const stats: SanitizeStats = { input: 0, dropped: 0, unwrapped: 0, clean: 0 }
  for (const r of records) {
    stats.input++
    const { record, action } = sanitizeRecord(r)
    if (action === 'drop') stats.dropped++
    else if (action === 'unwrap') stats.unwrapped++
    else stats.clean++
    if (record) out.push(record)
  }
  return { records: out, stats }
}

// ============================================================================
// INPUT ADAPTERS — format-specific parsing, quarantined from the core.
// ============================================================================

/**
 * Extract an utterance's text from a Claude session JSONL `message.content`,
 * which is either a string OR an array of content parts.
 *   - string           -> the utterance itself
 *   - array w/ text     -> concatenation of its "text" parts (a real utterance)
 *   - array w/o text    -> tool_result / image / document only -> SKIP (null)
 */
function extractJsonlText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = content
      .filter((p: any) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text as string)
    return texts.length ? texts.join('\n') : null
  }
  return null
}

/** Options controlling which speaker turns the JSONL adapter emits. */
export interface SessionJsonlAdapterOptions {
  /**
   * Also emit the assistant's TEXT turns (the sharpest findings often live in
   * assistant replies). Only `type:"text"` parts are extracted — tool_use,
   * tool_result, and thinking blocks are stripped as noise by `extractJsonlText`.
   * Assistant text is still run through the SAME secret-redaction core (it can
   * contain commands it ran / tokens in pasted output). Defaults to true.
   * Set false for the user-only path (keeps the original behavior, backward compatible).
   */
  includeAssistant?: boolean
}

/**
 * sessionJsonlAdapter — reads a Claude session .jsonl and yields normalized
 * raw records. By default it emits text-bearing `type:"user"` AND `type:"assistant"`
 * entries, each tagged with `speaker`. tool_result / image-only / tool_use-only /
 * thinking-only entries are skipped (they carry no spoken utterance).
 *
 * Pass `{ includeAssistant: false }` for the original user-only behavior.
 */
export function sessionJsonlAdapter(
  filePath: string,
  opts: SessionJsonlAdapterOptions = {}
): RawRecord[] {
  const includeAssistant = opts.includeAssistant !== false
  const raw = readFileSync(filePath, 'utf8')
  const lines = raw.split('\n')
  const out: RawRecord[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: any
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    const type = obj?.type
    const isUser = type === 'user'
    const isAssistant = type === 'assistant'
    if (!isUser && !(isAssistant && includeAssistant)) continue
    // Same text extractor for both: keeps only `type:"text"` parts, which
    // discards tool_use / tool_result / thinking blocks as noise.
    const text = extractJsonlText(obj?.message?.content)
    if (text === null) continue
    out.push({
      text,
      timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : '',
      speaker: isAssistant ? 'assistant' : 'user',
    })
  }
  return out
}

/**
 * plainTextAdapter — reads an arbitrary pasted transcript / .txt. Utterances
 * are split on blank lines (one normalized record per paragraph). There are no
 * per-utterance timestamps in raw text, so a single `baseTimestamp` (default:
 * now) is carried on every record. The cleaning core treats these identically
 * to JSONL-sourced records.
 */
export function plainTextAdapter(
  text: string,
  opts: { baseTimestamp?: string; speaker?: string } = {}
): RawRecord[] {
  const ts = opts.baseTimestamp ?? new Date().toISOString()
  return text
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => ({ text: chunk, timestamp: ts, speaker: opts.speaker }))
}

/**
 * mediaAdapter — STUB. The processor's input is format-agnostic: raw text, an
 * audio file, or a video (MP4) must all resolve to the SAME normalized record
 * stream the core consumes. A media adapter's job is to TRANSCRIBE the media to
 * text FIRST, then emit `{ text, timestamp, speaker? }` records.
 *
 * Transcription is intentionally NOT implemented in this first cut — it is a
 * separate unit that needs an STT call. The platform already uses
 * Soniox/Deepgram (see agent/src/voice-io.ts); wire that in here later.
 */
export interface MediaAdapterOptions {
  /** Path to an audio or video (e.g. .mp4/.wav/.m4a) file to transcribe. */
  filePath: string
  /** Future: STT provider selection, diarization toggle, language, etc. */
  provider?: 'soniox' | 'deepgram'
}

export function mediaAdapter(_opts: MediaAdapterOptions): RawRecord[] {
  // TODO(media): transcribe audio/video -> text via STT (reuse Soniox/Deepgram
  // from agent/src/voice-io.ts), diarize into speaker turns, then return
  // normalized RawRecord[] with per-segment timestamps. The cleaning core and
  // secret-redaction below consume the result UNCHANGED.
  throw new Error(
    'mediaAdapter is not implemented yet: audio/video transcription (STT) is a separate unit. ' +
      'Use sessionJsonlAdapter or plainTextAdapter for now.'
  )
}

// ============================================================================
// CLI
//   tsx transcript-sanitizer.ts <session.jsonl> [--count] [--json] [--text FILE]
//     (no flag) -> prints cleaned records (timestamp · [wrapped] · text)
//     --count   -> prints a drop/unwrap/clean summary only
//     --json    -> prints the SanitizedRecord[] as JSON
//     --text    -> treat the path as a plain-text transcript, not JSONL
// ============================================================================

function runCli(argv: string[]): number {
  const args = argv.slice(2)
  const flags = new Set(args.filter((a) => a.startsWith('--')))
  const positional = args.filter((a) => !a.startsWith('--'))
  const path = positional[0]

  if (!path) {
    console.error(
      'Usage: tsx transcript-sanitizer.ts <session.jsonl> [--count] [--json] [--text]'
    )
    return 2
  }

  let raws: RawRecord[]
  try {
    if (flags.has('--text')) {
      const fs = require('node:fs') as typeof import('node:fs')
      raws = plainTextAdapter(fs.readFileSync(path, 'utf8'))
    } else {
      raws = sessionJsonlAdapter(path)
    }
  } catch (err) {
    console.error(`Failed to read "${path}": ${(err as Error).message}`)
    return 1
  }

  const { records, stats } = sanitizeTranscriptDetailed(raws)

  if (flags.has('--count')) {
    console.log(`input (text-bearing utterances): ${stats.input}`)
    console.log(`dropped:                         ${stats.dropped}`)
    console.log(`unwrapped (from template):       ${stats.unwrapped}`)
    console.log(`clean passthrough:               ${stats.clean}`)
    console.log(`kept total:                      ${records.length}`)
    return 0
  }

  if (flags.has('--json')) {
    console.log(JSON.stringify(records, null, 2))
    return 0
  }

  for (const r of records) {
    const tag = r.wrapped ? '[wrapped] ' : ''
    console.log(`${r.timestamp} · ${tag}${r.text.replace(/\n/g, ' ')}`)
  }
  return 0
}

// ESM "run as script" guard — only fires when executed directly (tsx/node),
// never when imported.
const isMain = (() => {
  try {
    const { fileURLToPath } = require('node:url')
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()

if (isMain) {
  process.exit(runCli(process.argv))
}
