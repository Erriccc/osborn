/**
 * pipeline-e2e.ts — THIN end-to-end walking skeleton of the content pipeline.
 *
 * Chains the PROVEN front door (transcript-sanitizer) onto the next legs and
 * ACTUALLY RUNS them on one real session JSONL — no stubs:
 *
 *   sanitize (real file)  ->  condense to a cheap-model-sized sample
 *                         ->  OpenRouter cheap model: extract 3-5 topics
 *                         ->  OpenRouter cheap model: draft ONE LinkedIn post
 *                         ->  write results to the session workspace
 *
 * Run:  npx tsx agent/src/content/pipeline-e2e.ts [path-to-session.jsonl]
 *
 * Credentials: OPENROUTER_API_KEY (native OpenRouter endpoint). If absent/
 * unreachable, the script STOPS and reports plainly — it never fabricates
 * model output.
 */

import fs from 'node:fs'
import path from 'node:path'
import { sessionJsonlAdapter, sanitizeTranscriptDetailed } from './transcript-sanitizer.js'

const DEFAULT_FILE =
  '/workspace/.claude/projects/-workspace/c97588f4-5760-4b5b-b789-ab5f65aaed29.jsonl'
const OUT_FILE =
  '/workspace/.claude/projects/-workspace/osb/c97588f4-5760-4b5b-b789-ab5f65aaed29/content-e2e-run-2.md'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
// Cheap workhorse, verified reachable live from this machine's session history.
const MODEL = process.env.OSBORN_E2E_MODEL || 'deepseek/deepseek-chat'

interface Topic {
  topic: string
  why: string
}

type SampleRecord = { text: string; timestamp: string; speaker?: 'user' | 'assistant' }

/**
 * Evenly span-sample up to `max` records across the ENTIRE record set.
 *
 * The old sampler used floor-division stride (`floor(total/max)`), which on
 * shorter sessions collapses to stride=1 and only grabs the first ~max records —
 * never reaching the end of the session. We map the i-th sample to the source
 * index `round(i * (total - 1) / (n - 1))` (n > 1) so the picks are spread
 * uniformly from the first record to the LAST record, regardless of length.
 */
function spanSample(records: SampleRecord[], max: number, perRecord: number): SampleRecord[] {
  const kept = records.filter((r) => r.text.trim().length > 0)
  const total = kept.length
  if (total === 0) return []
  const n = Math.min(max, total)
  const out: SampleRecord[] = []
  const seen = new Set<number>()
  for (let i = 0; i < n; i++) {
    // Endpoint-inclusive: i=0 -> first record, i=n-1 -> LAST record.
    const idx = n > 1 ? Math.round((i * (total - 1)) / (n - 1)) : 0
    if (seen.has(idx)) continue
    seen.add(idx)
    out.push({
      text: kept[idx].text.replace(/\s+/g, ' ').trim().slice(0, perRecord),
      timestamp: kept[idx].timestamp,
      speaker: kept[idx].speaker,
    })
  }
  return out
}

/** Format a sampled record set as a speaker-labeled bullet list for the model. */
function formatSample(sample: SampleRecord[]): string {
  return sample
    .map((r) => `- [${r.speaker === 'assistant' ? 'assistant' : 'user'}] ${r.text}`)
    .filter((l) => l.trim().length > 4)
    .join('\n')
}

async function callOpenRouter(apiKey: string, system: string, user: string): Promise<string> {
  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.4,
      max_tokens: 900,
    }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`OpenRouter HTTP ${resp.status}: ${body.slice(0, 300)}`)
  }
  const json: any = await resp.json()
  const content = json?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(`OpenRouter returned no content: ${JSON.stringify(json).slice(0, 300)}`)
  }
  return content.trim()
}

/** Strip markdown code fences and parse a JSON array of topics. */
function parseTopics(raw: string): Topic[] {
  let s = raw.trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  if (start >= 0 && end > start) s = s.slice(start, end + 1)
  const arr = JSON.parse(s)
  if (!Array.isArray(arr)) throw new Error('topics JSON is not an array')
  return arr
    .map((t: any) => ({ topic: String(t?.topic ?? '').trim(), why: String(t?.why ?? '').trim() }))
    .filter((t) => t.topic)
}

/** Strip fences and parse a JSON array of strings (the truth-check output). */
function parseStringArray(raw: string): string[] {
  let s = raw.trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  if (start >= 0 && end > start) s = s.slice(start, end + 1)
  const arr = JSON.parse(s)
  if (!Array.isArray(arr)) throw new Error('truth-check JSON is not an array')
  return arr.map((x: any) => String(x ?? '').trim()).filter(Boolean)
}

async function main(): Promise<number> {
  const file = process.argv[2] || DEFAULT_FILE
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    console.error('STOP: OPENROUTER_API_KEY is not set. No model route reachable — not fabricating output.')
    return 2
  }
  if (!fs.existsSync(file)) {
    console.error(`STOP: session file not found: ${file}`)
    return 2
  }

  // LEG 1 — sanitize the real session (reuse the proven front door).
  // Now includes assistant TEXT turns (default) — the sharpest findings often
  // live in assistant replies; they go through the SAME secret redaction.
  const raws = sessionJsonlAdapter(file)
  const { records, stats } = sanitizeTranscriptDetailed(raws)
  const userCount = records.filter((r) => r.speaker === 'user').length
  const asstCount = records.filter((r) => r.speaker === 'assistant').length
  console.log(
    `[1] sanitized: ${records.length} clean records (user=${userCount}, assistant=${asstCount}, input=${stats.input}, dropped=${stats.dropped})`
  )
  if (records.length === 0) {
    console.error('STOP: sanitizer produced 0 records.')
    return 1
  }

  // LEG 2 — evenly span-sample across the WHOLE session (fixed sampler).
  const topicSample = spanSample(records, 60, 320)
  const sample = formatSample(topicSample)
  // A broader span feeds the truth-check so claims aren't flagged merely for
  // falling outside the small topic sample.
  const groundingSample = spanSample(records, 160, 400)
  const grounding = formatSample(groundingSample)
  const lastSampled = topicSample[topicSample.length - 1]
  const lastKept = records.filter((r) => r.text.trim().length > 0).slice(-1)[0]
  console.log(
    `[2] sampled ${topicSample.length} utterances (~${sample.length} chars); ` +
      `last sampled ts=${lastSampled?.timestamp || 'n/a'} vs last record ts=${lastKept?.timestamp || 'n/a'} ` +
      `(coverage reaches end of session)`
  )

  // LEG 3 — extract 3-5 candidate topics (strongest first), each with a why.
  const extractSystem =
    'You are a skeptical content strategist for a technical builder. From a work-session transcript, ' +
    'surface genuinely postable topics — concrete engineering lessons, surprising findings, honest ' +
    'negatives. No hype, no clickbait. Return ONLY a JSON array of 3-5 objects {"topic","why"}, ordered ' +
    'strongest-first. "why" is one line on why it is postable to a practitioner audience.'
  const extractUser =
    'These are sampled utterances from a session building an automated content pipeline for the ' +
    '"Osborn" voice-AI project (meta/build-in-public is intended). Each line is tagged [user] or ' +
    '[assistant]. Extract the topics:\n\n' + sample
  const topicsRaw = await callOpenRouter(apiKey, extractSystem, extractUser)
  let topics: Topic[]
  try {
    topics = parseTopics(topicsRaw)
  } catch (e) {
    console.error('STOP: could not parse topics JSON from model. Raw was:\n' + topicsRaw)
    return 1
  }
  if (topics.length === 0) {
    console.error('STOP: model returned no usable topics.')
    return 1
  }
  console.log(`[3] extracted ${topics.length} candidate topics`)

  // LEG 4 — draft ONE LinkedIn post for the strongest topic, using the proven arc.
  const pick = topics[0]
  const draftSystem =
    'You write as a skeptical practitioner, first person, no hype, no clickbait, no emoji. Voice: an ' +
    'engineer reporting what they actually found. Follow this arc EXACTLY: (1) a concrete, falsifiable ' +
    'claim; (2) how I confirmed it; (3) the mechanism (why it happens); (4) the lesson; (5) one honest ' +
    'question. 150-200 words. Return ONLY the post text.'
  const draftUser =
    `Draft a LinkedIn post on this topic from the session:\nTOPIC: ${pick.topic}\nWHY POSTABLE: ${pick.why}\n\n` +
    'Ground it in the actual work (building an automated, build-in-public content pipeline for a voice-AI ' +
    'project). Keep specifics honest; do not invent metrics you were not given.'
  const post = await callOpenRouter(apiKey, draftSystem, draftUser)
  console.log(`[4] drafted post (~${post.split(/\s+/).length} words)`)

  // LEG 5 — TRUTH-CHECK GUARD. Send the draft + the actual sanitized source
  // records to the cheap model and ask it to FLAG (not rewrite) any factual
  // claim in the draft that the source does not support. This directly targets
  // the run-1 hallucination (an invented iCloud recovery story).
  const checkSystem =
    'You are a strict fact-checking editor. You are given a DRAFT post and the SOURCE records (the ONLY ' +
    'ground truth). Identify every factual claim, event, metric, or specific detail in the draft that is ' +
    'NOT directly supported by the source records. Treat invented stories, numbers, or named mechanisms as ' +
    'unsupported. Do NOT rewrite or soften the post. Return ONLY a JSON array of strings — each string one ' +
    'specific ungrounded claim (quote or tight paraphrase from the draft). If every claim is grounded, return [].'
  const checkUser =
    `SOURCE RECORDS (ground truth, speaker-tagged):\n${grounding}\n\n` +
    `DRAFT POST:\n${post}\n\nList the ungrounded claims as a JSON array of strings.`
  // The guard must FAIL LOUD but must NOT lose the draft: on any failure (HTTP,
  // empty content, unparseable JSON) ungrounded=null, the draft is still
  // written under an UNVERIFIED banner, and the run exits non-zero.
  let ungrounded: string[] | null = null
  let truthCheckError = ''
  try {
    const checkRaw = await callOpenRouter(apiKey, checkSystem, checkUser)
    try {
      ungrounded = parseStringArray(checkRaw)
    } catch (e: any) {
      truthCheckError = `could not parse truth-check JSON (${e?.message || e})`
    }
  } catch (e: any) {
    truthCheckError = `truth-check call failed (${e?.message || e})`
  }
  const truthCheckFailed = ungrounded === null
  if (truthCheckFailed) {
    console.error(`[5] TRUTH-CHECK FAILED — UNVERIFIED: ${truthCheckError}`)
  } else {
    console.log(
      `[5] truth-check: ${ungrounded.length} ungrounded claim(s) flagged` +
        (ungrounded.length ? '' : ' (draft appears grounded in source)')
    )
  }

  const truthCheckMd = truthCheckFailed
    ? `**TRUTH-CHECK FAILED — UNVERIFIED.** ${truthCheckError}. No claim in the draft has been ` +
      `checked against the source; treat every specific as unverified.\n`
    : ungrounded.length
      ? `These claims in the draft are NOT supported by the sanitized source records — ` +
        `**verify before posting**:\n\n` +
        ungrounded.map((c, i) => `${i + 1}. ${c}`).join('\n') + '\n'
      : `The guard found no ungrounded claims against the sampled source records. ` +
        `(Absence of a flag is not proof of truth — the guard only sees the sampled subset.)\n`
  const banner = truthCheckFailed
    ? `> **TRUTH-CHECK FAILED — UNVERIFIED.** The draft below was NOT fact-checked. Do not post as-is.\n\n`
    : ''
  const ungroundedLabel = truthCheckFailed ? 'FAILED' : String(ungrounded.length)

  // Persist the REAL run to the session workspace.
  const md =
    `# Content pipeline E2E — run 2 (REAL model output)\n\n` +
    banner +
    `Three changes vs run-1: (1) sanitizer now includes assistant TEXT turns (redacted, speaker-tagged); ` +
    `(2) sampler spans the whole session evenly (fixed floor-division head bias); ` +
    `(3) a truth-check guard flags ungrounded claims in the draft.\n\n` +
    `- **Source session**: \`${path.basename(file)}\`\n` +
    `- **Clean records in**: ${records.length} (user=${userCount}, assistant=${asstCount}; ` +
    `sanitizer input=${stats.input}, dropped=${stats.dropped}, unwrapped=${stats.unwrapped})\n` +
    `- **Run-1 clean records (user-only)**: 1110 — the assistant turns are the new, wider input.\n` +
    `- **Sampled utterances sent to extractor**: ${topicSample.length} (truth-check grounding span: ${groundingSample.length})\n` +
    `- **Last sampled ts**: ${lastSampled?.timestamp || 'n/a'} vs **last record ts**: ${lastKept?.timestamp || 'n/a'} ` +
    `(even span reaches end of session)\n` +
    `- **Model**: \`${MODEL}\` via OpenRouter native endpoint\n\n` +
    `## Candidate topics (model, strongest-first)\n\n` +
    topics.map((t, i) => `${i + 1}. **${t.topic}**\n   - why: ${t.why}`).join('\n') +
    `\n\n## Picked\n\n**#1 — ${pick.topic}** (chosen as strongest-first per the extractor's ranking).\n\n` +
    `## Drafted LinkedIn post (verbatim model output)\n\n` +
    banner +
    post +
    `\n\n## Truth-check guard — ungrounded claims (${ungroundedLabel})\n\n` +
    truthCheckMd +
    `\n## Honest weaknesses\n\n` +
    `- The draft's specifics are only as verified as the sampled source; the truth-check sees a span-sample, ` +
    `not the full session, so it can miss claims that are false but outside the sample.\n` +
    `- "Strongest" = the model's own ranking, not an independent signal (no outlier/engagement data).\n` +
    `- Assistant turns widen coverage but also add model self-talk; some "findings" are the assistant's own ` +
    `claims, which the truth-check treats as source — grounding is only as honest as the transcript.\n`

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, md, 'utf8')
  console.log(`[done] wrote ${OUT_FILE}`)

  console.log('\n' + '='.repeat(64) + '\nCANDIDATE TOPICS\n' + '='.repeat(64))
  topics.forEach((t, i) => console.log(`${i + 1}. ${t.topic}\n   why: ${t.why}`))
  console.log('\n' + '='.repeat(64) + `\nDRAFTED POST (pick: ${pick.topic})\n` + '='.repeat(64) + '\n' + post)
  console.log('\n' + '='.repeat(64) + `\nTRUTH-CHECK — UNGROUNDED CLAIMS (${ungroundedLabel})\n` + '='.repeat(64))
  if (truthCheckFailed) {
    console.error(`TRUTH-CHECK FAILED — UNVERIFIED (${truthCheckError}); draft written with banner.`)
    return 1
  }
  if (ungrounded.length) ungrounded.forEach((c, i) => console.log(`${i + 1}. ${c}`))
  else console.log('(none flagged against the sampled source)')
  return 0
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('STOP: unexpected error — ' + (e?.message || String(e)))
  process.exit(1)
})
