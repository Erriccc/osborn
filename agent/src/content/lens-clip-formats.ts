/**
 * lens-clip-formats.ts — pass two, step 4-5: cut the verified arc into formats,
 * then check them. Topic-only voice by default; first-person only in the post
 * variants, flagged. The user's VERIFIED lines are the on-screen quotes.
 *
 * Checks never block, they FLAG: deterministic (on-screen quote must be a
 * verified user line, asset paths must appear in the source rows, first person
 * in topic-only formats, length targets) + the pipeline-e2e truth-check (draft +
 * source rows → list of ungrounded claims) on every format.
 */

import { recordView, type DbRecord } from './lens-db.js'
import { looseText, parseJsonObject } from './lens-quotes.js'
import type { Arc, ArcLine } from './lens-clip-arc.js'

export interface ScriptBeat {
  label: string
  seconds: number
  voiceover: string
  onScreenQuote: { row: number; text: string } | null
  timeJump?: string
  assets: { kind: string; ref: string; note: string }[]
}
export interface Formats {
  hook: string
  script: ScriptBeat[]
  /** Compilation only: derived cuts of the long script. */
  medium: ScriptBeat[]
  short: ScriptBeat[]
  linkedin: string
  linkedinFirstPerson: string
  x: string
  xFirstPerson: string
  comment: string
  flags: string[]
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const lineJson = (l: ArcLine) => ({ row: l.row, date: l.timestamp.slice(0, 10), text: l.text, ...(l.clip ? { clip: l.clip } : {}) })

export function arcForPrompt(arc: Arc): string {
  return JSON.stringify(
    {
      title: arc.title,
      question: arc.question,
      beats: arc.beats.map(b => ({
        beat: b.beat,
        clip: b.clip,
        summary: b.summary,
        user_lines: b.userLines.map(lineJson),
        support_lines: b.supportLines.map(lineJson),
        ...(b.noUserVoice ? { note: 'no user voice' } : {}),
      })),
    },
    null,
    1,
  )
}

export function formatsPrompt(sources: { label: string; records: DbRecord[] }[], arc: Arc, o: { mode: 'single' | 'compilation'; thread?: string }): string {
  const src = sources.map(s => `<clip id="${s.label}">\n${s.records.map(recordView).join('\n\n')}\n</clip>`).join('\n\n')
  const script =
    o.mode === 'single'
      ? '"script": EXACTLY 4 beats, 30-50 seconds total, answer-first (the payoff/clue up front, then how). If the arc spans ' +
        'several clips it is a montage of steps: chronological, each beat "label" a one-line step label.'
      : '"script": the LONG-FORM episode, 2-4 minutes total (6-10 beats, chronological); every beat whose clip is days/weeks after ' +
        'the previous one gets "time_jump" (e.g. "two weeks later") computed from the clip dates. "medium": 60-90s cut derived ' +
        'from the long script (4-6 beats); "short": 30-45s cut (3-4 beats). Medium/short reuse long-script beats and quotes.'
  const beatShape =
    '{"label", "seconds", "voiceover": TOPIC-ONLY narration (no I/we/my), "on_screen_quote": {"row", "text"} copied EXACTLY from ' +
    'one of the arc user_lines (or null), ' +
    (o.mode === 'compilation' ? '"time_jump": "" or e.g. "two weeks later", ' : '') +
    '"assets": [{"kind": "code"|"diagram"|"screen"|"log"|"reenactment", "ref": real file path / log line / thing to draw that ' +
    'appears in the source, "note"}]}. Any reenactment MUST be kind "reenactment".'
  return [
    'Below are the SOURCE rows (ground truth) and then a VERIFIED story arc built from them. Your task follows.',
    src,
    `<arc>\n${arcForPrompt(arc)}\n</arc>`,
    o.thread ? `<demand_thread>\n${o.thread.slice(0, 12_000)}\n</demand_thread>` : '',
    'TASK: cut the arc into publishable formats. The person\'s own verified lines carry the story; technical facts support it. ' +
      'Use ONLY facts present in the source rows — no invented numbers, timings, names or outcomes. Client details stay masked ' +
      '([client] etc.). No hype, no emoji, no clickbait.',
    `FORMATS: "hook": one line, topic-only. ${script} Script beat = ${beatShape} ` +
      '"linkedin": 120-200 words, topic-only voice (no I/we/my). "linkedin_first_person": the same post in first person ' +
      '(it will be flagged for the person\'s approval). "x": <= 280 characters, topic-only. "x_first_person": <= 280, first person. ' +
      (o.thread
        ? '"comment": a GitHub/HN reply to the demand_thread: answer ONLY what the thread asks, from this grounded experience, ' +
          'concrete and short (80-180 words). No promotion, no product plug; if mentioning the tool is unavoidable, prefix that ' +
          'sentence with "[disclosure]".'
        : '"comment": "".'),
    'Output ONLY: {"hook", "script": [...], ' + (o.mode === 'compilation' ? '"medium": [...], "short": [...], ' : '') +
      '"linkedin", "linkedin_first_person", "x", "x_first_person", "comment"}',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function readBeats(v: unknown): ScriptBeat[] {
  if (!Array.isArray(v)) return []
  return (v as any[]).map(b => ({
    label: str(b?.label),
    seconds: Number(b?.seconds) || 0,
    voiceover: str(b?.voiceover),
    onScreenQuote: b?.on_screen_quote && str(b.on_screen_quote.text) ? { row: Number(String(b.on_screen_quote.row).replace(/^#/, '')) || 0, text: str(b.on_screen_quote.text) } : null,
    timeJump: str(b?.time_jump) || undefined,
    assets: Array.isArray(b?.assets) ? b.assets.map((a: any) => ({ kind: str(a?.kind), ref: str(a?.ref), note: str(a?.note) })).filter((a: any) => a.ref) : [],
  }))
}

export function readFormats(raw: string): Formats | null {
  const o = parseJsonObject(raw)
  if (!o) return null
  return {
    hook: str(o.hook), script: readBeats(o.script), medium: readBeats(o.medium), short: readBeats(o.short),
    linkedin: str(o.linkedin), linkedinFirstPerson: str(o.linkedin_first_person), x: str(o.x), xFirstPerson: str(o.x_first_person),
    comment: str(o.comment), flags: [],
  }
}

const FIRST_PERSON = /\b(I|I'm|I've|I'd|my|me|mine|we|we're|we've|our|ours|us)\b/
/** First-person words outside quoted spans. */
export function hasFirstPerson(text: string): boolean {
  return FIRST_PERSON.test(text.replace(/"[^"]*"|“[^”]*”/g, ' '))
}

/** Deterministic checks. Mutates nothing in place except removing unverified on-screen quotes; returns flags. */
export function checkFormats(f: Formats, arc: Arc, sourceText: string): string[] {
  const flags: string[] = []
  const verified = arc.beats.flatMap(b => b.userLines)
  const src = looseText(sourceText)
  for (const [name, beats] of [['script', f.script], ['medium', f.medium], ['short', f.short]] as const) {
    for (const b of beats) {
      if (b.onScreenQuote) {
        const q = looseText(b.onScreenQuote.text)
        const hit = verified.find(l => looseText(l.text).includes(q) || q.includes(looseText(l.text)))
        if (!hit || q.length < 12) {
          flags.push(`${name} "${b.label}": on-screen quote is not a verified user line — removed`)
          b.onScreenQuote = null
        } else b.onScreenQuote = { row: hit.row, text: hit.text }
      }
      if (hasFirstPerson(b.voiceover)) flags.push(`${name} "${b.label}": first person in topic-only narration`)
      for (const a of b.assets) {
        const pathLike = /[\w-]+\/[\w./-]+|\b[\w-]+\.(?:ts|js|tsx|json|md|sh|yml|yaml|toml|py)\b/.exec(a.ref)
        if (pathLike && !src.includes(looseText(pathLike[0]))) flags.push(`${name} "${b.label}": asset "${pathLike[0]}" not found in source rows`)
        if (/reenact|recreat|mock/i.test(`${a.ref} ${a.note}`) && a.kind !== 'reenactment') flags.push(`${name} "${b.label}": unlabeled reenactment "${a.ref}"`)
      }
    }
    if (beats.length) {
      const secs = beats.reduce((s, b) => s + b.seconds, 0)
      const words = beats.reduce((s, b) => s + b.voiceover.split(/\s+/).filter(Boolean).length, 0)
      flags.push(`${name}: ${beats.length} beats, ${secs}s stated, ~${Math.round(words / 2.5)}s at 150 wpm`)
    }
  }
  if (hasFirstPerson(f.hook)) flags.push('hook: first person in topic-only format')
  if (hasFirstPerson(f.linkedin)) flags.push('linkedin: first person in topic-only post')
  if (hasFirstPerson(f.x)) flags.push('x: first person in topic-only post')
  const wc = f.linkedin.split(/\s+/).filter(Boolean).length
  if (wc && (wc < 120 || wc > 200)) flags.push(`linkedin: ${wc} words (target 120-200)`)
  for (const [n, t] of [['x', f.x], ['x_first_person', f.xFirstPerson]] as const) if ([...t].length > 280) flags.push(`${n}: ${[...t].length} chars (> 280)`)
  if (f.linkedinFirstPerson) flags.push('linkedin_first_person: FIRST-PERSON variant — needs the person\'s approval')
  if (f.xFirstPerson) flags.push('x_first_person: FIRST-PERSON variant — needs the person\'s approval')
  if (/\[disclosure\]/i.test(f.comment)) flags.push('comment: contains a [disclosure] product mention — check it is directly relevant')
  return flags
}

/** Plain-text renderings fed to the truth-check, one per format. */
export function formatTexts(f: Formats): [string, string][] {
  const beats = (bs: ScriptBeat[]) => bs.map(b => `${b.timeJump ? `(${b.timeJump}) ` : ''}${b.voiceover}${b.onScreenQuote ? ` [on screen: "${b.onScreenQuote.text}"]` : ''}`).join('\n')
  const out: [string, string][] = [['hook', f.hook], ['script', beats(f.script)], ['medium', beats(f.medium)], ['short', beats(f.short)],
    ['linkedin', f.linkedin], ['linkedin_first_person', f.linkedinFirstPerson], ['x', f.x], ['x_first_person', f.xFirstPerson], ['comment', f.comment]]
  return out.filter(([, t]) => t.trim())
}

/** The pipeline-e2e truth-check prompt (same wording), source FIRST, instructions after. */
export function truthCheckPrompt(sourceText: string, draft: string): string {
  return [
    `SOURCE RECORDS (ground truth, speaker-tagged):\n${sourceText}`,
    `DRAFT POST:\n${draft}`,
    'You are a strict fact-checking editor. You are given a DRAFT post and the SOURCE records (the ONLY ground truth). Identify ' +
      'every factual claim, event, metric, or specific detail in the draft that is NOT directly supported by the source records. ' +
      'Treat invented stories, numbers, or named mechanisms as unsupported. Do NOT rewrite or soften the post. Return ONLY a JSON ' +
      'array of strings — each string one specific ungrounded claim (quote or tight paraphrase from the draft). If every claim is grounded, return [].',
  ].join('\n\n')
}

export function parseStringArray(raw: string): string[] | null {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const a = s.indexOf('[')
  const b = s.lastIndexOf(']')
  if (a === -1 || b < a) return null
  try {
    const arr = JSON.parse(s.slice(a, b + 1))
    return Array.isArray(arr) ? arr.map(x => String(x ?? '').trim()).filter(Boolean) : null
  } catch {
    return null
  }
}
