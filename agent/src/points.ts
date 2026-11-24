/**
 * points.ts — points raised in one long spoken turn (#455). Pure, no model: split a long
 * transcript into its separate points, and later mark which ones the reply covered.
 */
import { HIDDEN_CHARS } from './dispatch.js'
import { SPEECH_STOPWORDS } from './stopwords.js'
import { clip } from './content/lens-ingest.js'
import { cleanTurnText } from './content/transcript-sanitizer.js'

/** A turn must be at least this many words and yield at least this many points. */
const POINTS_MIN_WORDS = 60
const POINTS_MIN_COUNT = 3
/** Checklist cap, and the cap on points recorded in the ledger (the filing cap). */
const POINTS_CHECKLIST_CAP = 6
export const POINTS_FILE_CAP = 4
export const POINT_MAX_CHARS = 160
const MIN_FRAGMENT_WORDS = 6

// A bare ordinal or "also" splits only after punctuation ("every second" must not); the longer phrases split anywhere.
const MARKER = /(?<=[,;.!?])\s+(?=(?:also|second(?:ly)?|third(?:ly)?|next|oh and)\b)|\s+(?=(?:and another thing|another thing|one more thing|and then there'?s)\b)/i
const LEAD_MARKER = /^(?:and another thing|another thing|one more thing|oh and|and then there'?s|also|second(?:ly)?|third(?:ly)?|next|first(?:ly)?|and|so|okay|ok|well|um|uh|right|alright|yeah|anyway)\b[\s,:-]*/i
const CHIT_CHAT = /^(?:(?:okay|ok|so|yeah|yes|no|right|alright|anyway|hmm+|um+|uh+|well|cool|great|thanks|thank you|sounds good|you know|i mean|got it|sure|please|and)\b[\s,.!?-]*)+$/i

/** Lowercase content words, stopwords out, a trailing plural s folded. */
function contentWords(text: string): string[] {
  const out: string[] = []
  for (const w of String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []) {
    const s = w.replace(/'s$/, '').replace(/(?<=[a-z]{3})s$/, '')
    if (s.length >= 3 && !SPEECH_STOPWORDS.has(s) && !SPEECH_STOPWORDS.has(w)) out.push(s)
  }
  return out
}

const wordCount = (s: string) => (s.match(/\S+/g) ?? []).length

/**
 * The separate points of a long turn, in order, or [] when the turn is short or has fewer than
 * POINTS_MIN_COUNT points. Only the person's own words count (injected blocks such as a session tail
 * are stripped). Drops chit-chat and fragments, folds a short follow-up into the previous point,
 * keeps the LAST restatement of a repeated point.
 */
export function splitPoints(text: string): string[] {
  const clean = (cleanTurnText(String(text || '')) ?? '').replace(HIDDEN_CHARS, ' ').replace(/\s+/g, ' ').trim()
  if (wordCount(clean) < POINTS_MIN_WORDS) return []
  const segs: string[] = []
  for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
    for (const part of sentence.split(MARKER)) {
      let s = part
      for (let i = 0; i < 4 && LEAD_MARKER.test(s); i++) s = s.replace(LEAD_MARKER, '')
      s = s.replace(/^[\s,;:-]+|[\s,;:-]+$/g, '')
      if (!s || CHIT_CHAT.test(s)) continue
      if (wordCount(s) < MIN_FRAGMENT_WORDS) {
        if (segs.length) segs[segs.length - 1] += ' ' + s
        continue
      }
      segs.push(s)
    }
  }
  // A repeated point: the later restatement replaces the earlier one.
  const kept: Array<{ s: string; w: Set<string> }> = []
  for (const s of segs) {
    const w = new Set(contentWords(s))
    const dup = kept.findIndex((k) => {
      const inter = [...w].filter((x) => k.w.has(x)).length
      return inter >= 3 && inter / Math.min(w.size, k.w.size) >= 0.6
    })
    if (dup >= 0) kept.splice(dup, 1)
    kept.push({ s, w })
  }
  if (kept.length < POINTS_MIN_COUNT) return []
  return kept.slice(0, POINTS_CHECKLIST_CAP).map((k) => clip(k.s, POINT_MAX_CHARS))
}

/**
 * The points the reply (spoken text plus the turn's dispatch/tool inputs) covered. A point is
 * answered only when at least two of its content words appear and they are half of them or two are
 * long words; anything unsure stays open.
 */
export function addressedPoints(points: string[], reply: string): string[] {
  const have = new Set(contentWords(reply))
  return points.filter((p) => {
    const words = [...new Set(contentWords(p))]
    const hit = words.filter((w) => have.has(w))
    const rare = hit.filter((w) => w.length >= 7).length
    return hit.length >= 2 && (hit.length / words.length >= 0.5 || rare >= 2)
  })
}
