/**
 * lens-clip-arc.ts — pass two, step 3: "understand what really happened".
 *
 * One model call reads the expanded window(s) (transcript FIRST, instructions
 * AFTER, as lens-model.ts) and returns a human arc. Every beat is carried by the
 * USER'S OWN verbatim lines; facts only support. Each line is then verified
 * deterministically with lens-quotes (same rules as pass one) and the speaker is
 * taken from the matched row, never the model. A "user" line that is really a
 * pasted review/log/doc (text after a paste marker in that row) is demoted to
 * support. A beat left with no verified user line is marked "no user voice".
 */

import { recordView, type DbRecord } from './lens-db.js'
import { buildRecordIndex, looseText, parseJsonObject, verifyQuote, type Quote } from './lens-quotes.js'

export const SINGLE_BEATS = ['goal', 'obstacle', 'attempts', 'turning_point', 'fix', 'payoff'] as const

export interface ArcLine extends Quote {
  /** true = user's own spoken words; false = assistant or pasted text (support only). */
  voice: boolean
  /** Compilation: which clip (A, B, …) the row belongs to. */
  clip?: string
}
export interface ArcBeat {
  beat: string
  summary: string
  clip?: string
  userLines: ArcLine[]
  supportLines: ArcLine[]
  noUserVoice: boolean
  dropped: number
}
export interface Arc {
  title: string
  question: string
  beats: ArcBeat[]
  genuine: { answers: boolean; why: string } | null
  cut: { clip: string; what: string; why: string }[]
  linesDropped: number
  demotedPasted: number
}

/** Paste markers: text at/after one of these in a user row is not the user's own voice. */
const PASTE_MARKER = /\[review\]|(?:^| )#{1,4} \S|\breject:|\bapprove:|\[liked\]|\[disliked\]|<\/?[a-z_]+>|^\[time: [^\]]*\] (?:#|\[)/

/** True when `quote` sits inside pasted material of `rowText` (a review, log, doc) rather than the user's words. */
export function isPastedSpan(rowText: string, quote: string): boolean {
  const row = looseText(rowText)
  const q = looseText(quote)
  const at = row.indexOf(q)
  if (at === -1) return false
  const m = PASTE_MARKER.exec(row)
  if (m && m.index <= at) return true
  return row.length > 4000 && at > 600
}

export interface RawLine { text?: unknown; timestamp?: unknown; row?: unknown }

/**
 * Verify every line of every beat against the window rows. Pure + deterministic.
 * `clipOf` maps a row id to its clip label (compilation).
 */
export function verifyBeats(
  raw: { beat?: unknown; summary?: unknown; clip?: unknown; user_lines?: unknown; support_lines?: unknown }[],
  records: DbRecord[],
  clipOf: (row: number) => string | undefined = () => undefined,
): { beats: ArcBeat[]; dropped: number; demoted: number } {
  const idx = buildRecordIndex(records)
  const byId = new Map(records.map(r => [r.id, r]))
  let dropped = 0
  let demoted = 0
  const beats: ArcBeat[] = []
  for (const b of raw) {
    const name = typeof b?.beat === 'string' ? b.beat.trim() : ''
    if (!name) continue
    const user: ArcLine[] = []
    const support: ArcLine[] = []
    let bd = 0
    const lines = [
      ...(Array.isArray(b.user_lines) ? (b.user_lines as RawLine[]).slice(0, 2) : []),
      ...(Array.isArray(b.support_lines) ? (b.support_lines as RawLine[]).slice(0, 2) : []),
    ]
    const seen = new Set<string>()
    for (const l of lines) {
      const v = verifyQuote(l as any, idx)
      if (!v) { bd++; continue }
      const key = `${v.row}:${looseText(v.text)}`
      if (seen.has(key)) continue
      seen.add(key)
      const src = byId.get(v.row)
      const pasted = v.speaker === 'user' && !!src && isPastedSpan(src.text, v.text)
      if (pasted) demoted++
      const line: ArcLine = { ...v, voice: v.speaker === 'user' && !pasted, clip: clipOf(v.row) }
      if (line.voice && user.length < 2) user.push(line)
      else if (!line.voice && support.length < 2) support.push(line)
    }
    dropped += bd
    beats.push({
      beat: name,
      summary: typeof b.summary === 'string' ? b.summary.trim() : '',
      clip: typeof b.clip === 'string' ? b.clip.trim() : user[0]?.clip ?? support[0]?.clip,
      userLines: user,
      supportLines: support,
      noUserVoice: user.length === 0,
      dropped: bd,
    })
  }
  return { beats, dropped, demoted }
}

const LINE_RULES =
  'LINES: each line = {"text": exact verbatim substring (12-300 chars) copied character-for-character from ONE record, ' +
  '"timestamp": that record\'s exact timestamp from its [#row | timestamp | speaker] header, "row": its row number (digits only)}. ' +
  'ONE contiguous span: no ellipses, no skipped words, no joined sentences, no typo fixes — the person speaks by voice, so keep ' +
  'their disfluencies exactly. "user_lines": 1-2 lines from USER records that are the person\'s OWN spoken words at that moment ' +
  '(their frustration, their clue, their reaction) — NOT text they pasted (reviews, logs, docs, links). "support_lines": 0-2 ' +
  'assistant lines that state the technical fact. Never quote secrets, keys, tokens, emails, client names, or personal details; ' +
  'keep masked tags like [client] as they are.'

export interface ArcPromptOpts {
  mode: 'single' | 'compilation'
  /** Reverse mode: the demand thread the clip must answer. */
  thread?: string
  /** Compilation topic. */
  topic?: string
}

/** Windows labelled A, B, … with dates; transcript first, task after. */
export function arcPrompt(windows: { label: string; records: DbRecord[] }[], o: ArcPromptOpts): string {
  const blocks = windows.map(w => {
    const d0 = w.records[0]?.timestamp.slice(0, 10)
    const d1 = w.records[w.records.length - 1]?.timestamp.slice(0, 10)
    return `<clip id="${w.label}" dates="${d0}${d1 !== d0 ? ` to ${d1}` : ''}">\n${w.records.map(recordView).join('\n\n')}\n</clip>`
  })
  const montage = o.mode === 'single' && windows.length > 1
  const head =
    o.mode === 'single' && !montage
      ? 'Below is one contiguous stretch of a raw, unedited voice work session between a person (user) and their AI coding ' +
        'assistant (assistant), pulled from a much longer session. Read all of it; your task follows.'
      : `Below are ${windows.length} stretches from DIFFERENT points in time (possibly hours or days apart) of ONE long, raw, ` +
        'unedited voice work session between a person (user) and their AI coding assistant. Read all of them; your task follows.'
  const thread = o.thread ? `\n<demand_thread>\n${o.thread.slice(0, 12_000)}\n</demand_thread>` : ''
  const task =
    o.mode === 'single'
      ? 'TASK: like a streamer clipping a highlight, find the ONE human story in this stretch and tell it answer-first. ' +
        `Beats, in order: ${SINGLE_BEATS.join(', ')} — goal (what they were trying to do and why it mattered), obstacle ` +
        '(the symptom), attempts (what was tried, dead ends), turning_point (the clue), fix, payoff. Build each beat around ' +
        'what the PERSON said at that moment; technical facts only support. If a beat truly has no user line, give an empty ' +
        'user_lines array — do not force one.' +
        (montage
          ? ' This is a short MONTAGE of steps ("did this -> did this -> did this") across the stretches: keep the beats in ' +
            'chronological order, give each beat its "clip" id, and make "summary" a one-line step label.'
          : '')
      : `TASK: stitch these clips into ONE coherent, edited episode about: ${o.topic || 'the recurring topic'}. Keep the full ` +
        'message, cut the noise (tangents, interruptions, retries, filler). Beats in chronological order showing how the ' +
        'understanding evolved: first understanding, what was tried first, what failed and why, the re-think, what finally ' +
        'worked, how it was verified. 5-8 beats; each beat names its "clip" id and carries only what serves the through-line. ' +
        'Also list what you cut as noise.'
  const genuine = o.thread
    ? ' The clip must answer the demand_thread above. Add "genuine": {"answers": true|false, "why": one line} — true ONLY if ' +
      'this stretch shows real, first-hand experience that actually addresses the thread\'s core problem (not merely the same keywords).'
    : ''
  const shape =
    o.mode === 'single'
      ? '{"title": short topic title, "question": the one question this clip answers, "beats": [{"beat", ' +
        (montage ? '"clip": "A", ' : '') + '"summary": one line, ' +
        '"user_lines": [...], "support_lines": [...]}]' + (o.thread ? ', "genuine": {...}' : '') + '}'
      : '{"title", "question": the question the episode answers, "beats": [{"beat": short name, "clip": "A", "summary", ' +
        '"user_lines": [...], "support_lines": [...]}], "cut": [{"clip": "A", "what": short description, "why": "tangent|interruption|retry|filler|off-topic"}]}'
  return [head, ...blocks, thread, task + genuine, LINE_RULES, `Output ONLY: ${shape}`].filter(Boolean).join('\n\n')
}

export function readArc(raw: string, records: DbRecord[], clipOf?: (row: number) => string | undefined): Arc | null {
  const o = parseJsonObject(raw)
  if (!o || !Array.isArray(o.beats)) return null
  const v = verifyBeats(o.beats as any[], records, clipOf)
  const g = o.genuine as any
  const cut = Array.isArray(o.cut) ? (o.cut as any[]) : []
  return {
    title: String(o.title ?? '').trim(),
    question: String(o.question ?? '').trim(),
    beats: v.beats,
    genuine: g && typeof g === 'object' ? { answers: g.answers === true, why: String(g.why ?? '').trim() } : null,
    cut: cut.map(c => ({ clip: String(c?.clip ?? ''), what: String(c?.what ?? ''), why: String(c?.why ?? '') })).filter(c => c.what),
    linesDropped: v.dropped,
    demotedPasted: v.demoted,
  }
}
