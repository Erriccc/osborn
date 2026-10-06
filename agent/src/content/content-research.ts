/**
 * content-research.ts — per-topic research for Stage A (rules §4, §8, §8a).
 *
 * Two layers, both grounded in REAL, cited threads (no invented people):
 *   1. Demand — what performs: the keyless HN Algolia gap check (lens-hn.ts).
 *   2. Problem research (§8a) — conventions, the common problems / failure
 *      points people hit, concrete scenarios, tradeoffs. Raw material: HN
 *      comments (keyless Algolia) + GitHub issue search (keyless; GITHUB_TOKEN
 *      is used when present, never logged). One OpenRouter call synthesises
 *      them; every finding must cite source ids that were actually fetched —
 *      uncited / unknown-cite findings are dropped deterministically.
 *
 * Cache: 7 days per topic under <project>/.content-research-cache/<hash>.json.
 * --research-refresh bypasses it. Search queries are scrubbed, then must pass
 * the deterministic outbound gate (content-query-gate.ts) before leaving the
 * machine; if none survive, no search runs (status no-threads). Fail-open: network errors give fewer sources, never a throw —
 * EXCEPT a spend-cap hit (CapError), which the run turns into status "capped".
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gapCheck, type HnStory } from './lens-hn.js'
import { CapError, llmJson, type ContentLlmOptions } from './content-llm.js'
import { writeAtomic } from './content-manifest.js'
import { gateQueries } from './content-query-gate.js'

export const RESEARCH_CACHE_DIR = '.content-research-cache'
export const RESEARCH_TTL_MS = 7 * 86_400_000
const FETCH_TIMEOUT_MS = 10_000
const SNIPPET = 420

export interface ResearchTopic {
  /** Short subtopic, e.g. "context loss at Claude Code compaction". */
  subtopic: string
  /** 1-3 short search queries (2-5 words). */
  queries: string[]
}
export interface Citation {
  id: string
  source: 'hn-story' | 'hn-comment' | 'github-issue'
  url: string
  title: string
  snippet: string
  points?: number
  comments?: number
}
export interface Finding {
  text: string
  /** Citation URLs (only ones actually fetched). */
  cites: string[]
}
export interface TopicResearch {
  key: string
  topic: ResearchTopic
  at: string
  status: 'ok' | 'no-threads' | 'model-error'
  demand: { note: string; reachable: boolean; stories: HnStory[] }
  /** Who is living through this (feeds the brief's viewer, rules §4). */
  viewers: Finding[]
  conventions: Finding[]
  problems: Finding[]
  scenarios: Finding[]
  tradeoffs: Finding[]
  citations: Citation[]
  costUsd: number
  cached?: boolean
}

export interface ResearchOptions {
  projectDir: string | null
  llm: ContentLlmOptions
  refresh?: boolean
  now?: number
  /** Project basename / cwd paths: queries naming any of their segments never leave the machine. */
  privateTerms?: string[]
}

export function researchKey(t: ResearchTopic): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(JSON.stringify([norm(t.subtopic), t.queries.map(norm).sort()])).digest('hex').slice(0, 24)
}

const stripHtml = (s: string) =>
  String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&#x2F;/g, '/')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
const clip = (s: string, n = SNIPPET) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

/** `ok` = the source answered (HTTP 2xx + JSON), even with zero hits. */
async function getJson(url: string, headers: Record<string, string> = {}): Promise<{ ok: boolean; data: any }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers })
    if (!r.ok) return { ok: false, data: null }
    return { ok: true, data: await r.json() }
  } catch {
    return { ok: false, data: null }
  } finally {
    clearTimeout(timer)
  }
}

interface Fetched {
  reachable: boolean
  cites: Citation[]
}

/** HN comments matching the query: where people describe what broke for them. */
export async function hnComments(q: string): Promise<Citation[]> {
  return (await hnCommentsR(q)).cites
}
async function hnCommentsR(q: string): Promise<Fetched> {
  const { ok, data: d } = await getJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=comment&hitsPerPage=8`)
  const hits: any[] = Array.isArray(d?.hits) ? d.hits : []
  const cites = hits
    .filter(h => h?.objectID && h?.comment_text)
    .map(h => ({
      id: '',
      source: 'hn-comment' as const,
      url: `https://news.ycombinator.com/item?id=${encodeURIComponent(String(h.objectID))}`,
      title: clip(stripHtml(h.story_title || 'HN comment'), 140),
      snippet: clip(stripHtml(h.comment_text)),
      points: Number(h.points) || undefined,
    }))
    .filter(c => c.snippet.length >= 60)
  return { reachable: ok, cites }
}

/** GitHub issues matching the query, best match first (sort=comments surfaced bot status boards). Keyless unless GITHUB_TOKEN is set. */
export async function githubIssues(q: string): Promise<Citation[]> {
  return (await githubIssuesR(q)).cites
}
async function githubIssuesR(q: string): Promise<Fetched> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'osborn-content-research' }
  const tok = (process.env.GITHUB_TOKEN || '').trim()
  if (tok) headers.Authorization = `Bearer ${tok}`
  const { ok, data: d } = await getJson(`https://api.github.com/search/issues?q=${encodeURIComponent(`${q} is:issue`)}&per_page=6`, headers)
  const items: any[] = Array.isArray(d?.items) ? d.items : []
  const cites = items
    .filter(i => typeof i?.html_url === 'string' && /^https:\/\/github\.com\//.test(i.html_url) && i?.title)
    .map(i => ({
      id: '',
      source: 'github-issue' as const,
      url: String(i.html_url),
      title: clip(stripHtml(i.title), 160),
      snippet: clip(stripHtml(i.body || '')),
      comments: Number(i.comments) || 0,
    }))
  return { reachable: ok, cites }
}

function readCache(projectDir: string | null, key: string, now: number): TopicResearch | null {
  if (!projectDir) return null
  try {
    const c = JSON.parse(readFileSync(join(projectDir, RESEARCH_CACHE_DIR, `${key}.json`), 'utf-8')) as TopicResearch
    if (c?.key === key && now - Date.parse(c.at) < RESEARCH_TTL_MS && c.status !== 'model-error') return { ...c, cached: true, costUsd: 0 }
  } catch {
    /* miss */
  }
  return null
}

function writeCache(projectDir: string | null, r: TopicResearch): void {
  if (!projectDir) return
  try {
    const dir = join(projectDir, RESEARCH_CACHE_DIR)
    mkdirSync(dir, { recursive: true })
    writeAtomic(join(dir, `${r.key}.json`), JSON.stringify(r, null, 2) + '\n')
  } catch {
    /* cache is best-effort */
  }
}

export const RESEARCH_SYSTEM =
  'You are a developer-audience researcher. You are given REAL threads (Hacker News stories/comments, GitHub issues), each with an id like S3. ' +
  'Summarise the PROBLEM SPACE of the subtopic for someone about to make a short video about it. Use ONLY what the threads say. ' +
  'Never invent people, quotes, numbers, products or threads. Never name individual commenters — say "an HN commenter" or "a GitHub issue". ' +
  'Every finding must cite 1-3 thread ids it is drawn from. Reply with ONE JSON object only.'

export function researchPrompt(t: ResearchTopic, demandNote: string, cites: Citation[]): string {
  const src = cites.map(c => `[${c.id}] (${c.source}${c.points ? `, ${c.points} pts` : ''}${c.comments ? `, ${c.comments} comments` : ''}) ${c.title}\n${c.snippet}`).join('\n\n')
  return [
    `SUBTOPIC: ${t.subtopic}`,
    `DEMAND (HN stories): ${demandNote}`,
    '<threads>',
    src,
    '</threads>',
    'TASK (problem research): from the threads above, extract',
    '- "viewers": who is living through this (role + situation), e.g. "solo devs running long Claude Code sessions"',
    '- "conventions": the approaches people conventionally use',
    '- "problems": the most common problems and failure points they actually hit',
    '- "scenarios": concrete situations people are stuck in',
    '- "tradeoffs": what they weigh against what',
    'Each list 0-5 items, each item {"text": one plain sentence, "cites": ["S1", ...]}. Skip anything the threads do not support. ' +
      'If the threads are off-topic, return empty lists.',
    'Output ONLY: {"viewers": [...], "conventions": [...], "problems": [...], "scenarios": [...], "tradeoffs": [...]}',
  ].join('\n\n')
}

/** Keep only findings whose cites are real fetched ids; map ids → URLs. */
export function groundFindings(raw: unknown, cites: Citation[]): Finding[] {
  const byId = new Map(cites.map(c => [c.id.toUpperCase(), c.url]))
  const out: Finding[] = []
  for (const it of Array.isArray(raw) ? raw.slice(0, 5) : []) {
    const text = String((it as any)?.text ?? '').replace(/\s+/g, ' ').trim()
    const ids: unknown[] = Array.isArray((it as any)?.cites) ? (it as any).cites : []
    const urls = [...new Set(ids.map(i => byId.get(String(i).replace(/[\[\]\s]/g, '').toUpperCase())).filter((u): u is string => !!u))]
    if (text.length >= 8 && urls.length) out.push({ text: clip(text, 300), cites: urls })
  }
  return out
}

/** Research one topic (cached 7 days). Throws only CapError. */
export async function researchTopic(topic: ResearchTopic, o: ResearchOptions): Promise<TopicResearch> {
  const now = o.now ?? Date.now()
  const key = researchKey(topic)
  if (!o.refresh) {
    const hit = readCache(o.projectDir, key, now)
    if (hit) return hit
  }
  const log = o.llm.log ?? (() => {})
  const scrubbed = topic.queries.map(q => o.llm.scrub(q).replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim()).filter(q => q.length >= 3)
  // Deterministic outbound gate: only plain, non-project-specific queries ever reach HN / GitHub.
  const queries = gateQueries(scrubbed, o.privateTerms ?? []).slice(0, 2)
  if (scrubbed.length > queries.length) log(`research "${clip(topic.subtopic, 60)}": ${scrubbed.length - queries.length} query(ies) held back by the outbound gate`)
  const base: TopicResearch = {
    key, topic: { subtopic: topic.subtopic, queries }, at: new Date(now).toISOString(), status: 'no-threads',
    demand: { note: 'No search queries.', reachable: false, stories: [] },
    viewers: [], conventions: [], problems: [], scenarios: [], tradeoffs: [], citations: [], costUsd: 0,
  }
  if (!queries.length) return base
  const gap = await gapCheck(queries).catch(() => null)
  if (gap) base.demand = { note: gap.note, reachable: gap.reachable, stories: gap.stories }
  let reachable = !!gap?.reachable
  const seen = new Set<string>()
  const cites: Citation[] = []
  const add = (c: Citation) => {
    if (seen.has(c.url) || cites.length >= 16) return
    seen.add(c.url)
    cites.push({ ...c, id: `S${cites.length + 1}`, title: o.llm.scrub(c.title), snippet: o.llm.scrub(c.snippet) })
  }
  for (const s of base.demand.stories) add({ id: '', source: 'hn-story', url: s.url, title: s.title, snippet: s.title, points: s.points, comments: s.num_comments })
  const none: Fetched = { reachable: false, cites: [] }
  for (const q of queries) {
    for (const f of [await hnCommentsR(q).catch(() => none), await githubIssuesR(q).catch(() => none)]) {
      reachable ||= f.reachable
      for (const c of f.cites) add(c)
    }
  }
  base.citations = cites
  log(`research "${clip(topic.subtopic, 60)}": ${cites.length} thread(s) (${cites.filter(c => c.source === 'github-issue').length} GitHub)`)
  if (cites.length < 2) {
    writeCache(o.projectDir, base)
    return base
  }
  try {
    const r = await llmJson(o.llm, { what: 'research', system: RESEARCH_SYSTEM, user: researchPrompt(topic, base.demand.note, cites), maxOut: 1800, temperature: 0.1 })
    base.costUsd = r.costUsd
    const j = r.json ?? {}
    for (const k of ['viewers', 'conventions', 'problems', 'scenarios', 'tradeoffs'] as const) base[k] = groundFindings(j[k], cites)
    base.status = 'ok'
  } catch (e: any) {
    if (e instanceof CapError) throw e
    base.status = 'model-error'
    log(`research "${clip(topic.subtopic, 60)}": synthesis failed (${e?.message ?? e}); demand data kept`)
  }
  writeCache(o.projectDir, base)
  return base
}

/** Compact, citation-tagged text block of one topic's research (for briefs, scripts and truth-check sources). */
export function researchDigest(r: TopicResearch): string {
  const sec = (label: string, fs: Finding[]) => (fs.length ? `${label}:\n${fs.map(f => `- ${f.text} (${f.cites.join(', ')})`).join('\n')}` : '')
  return [
    `RESEARCH — ${r.topic.subtopic}`,
    `Demand: ${r.demand.note}`,
    ...r.demand.stories.map(s => `- HN story: "${s.title}" ${s.points} pts / ${s.num_comments} comments (${s.url})`),
    sec('Who is living through it', r.viewers),
    sec('Conventional approaches', r.conventions),
    sec('Common problems / failure points', r.problems),
    sec('Concrete scenarios', r.scenarios),
    sec('Tradeoffs', r.tradeoffs),
  ].filter(Boolean).join('\n')
}

/** Every URL a piece's research actually cites (for source_anchors). */
export function researchCitations(r: TopicResearch): { url: string; title: string; source: Citation['source'] }[] {
  const used = new Set([r.viewers, r.conventions, r.problems, r.scenarios, r.tradeoffs].flat().flatMap(f => f.cites))
  for (const s of r.demand.stories) used.add(s.url)
  return r.citations.filter(c => used.has(c.url)).map(c => ({ url: c.url, title: c.title, source: c.source }))
}
