/**
 * lens-clip-search.ts — REVERSE direction + compilation topic search.
 *
 * demand thread (or topic) → a few search queries (one cheap model call) → the
 * recall store's OWN search (session-store.ts recall(): FTS5 BM25 + vector, RRF,
 * read-only) over session.db → keep only conversation rows the lens may read
 * (sanitized user/assistant main rows) → cluster nearby hits → anchors.
 * A weak cluster (few distinct queries / few hits) is reported as such; the
 * caller then refuses to force a draft.
 */

import { openStore, recall } from '../session-store.js'
import { getEmbedder } from '../embedder.js'
import type { DbRecord } from './lens-db.js'
import { clusterAnchors } from './lens-clip-window.js'
import { parseJsonObject } from './lens-quotes.js'

const FETCH_TIMEOUT_MS = 15_000

async function getJson(url: string): Promise<any> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'osborn-content-lens', Accept: 'application/json' } })
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`)
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

/** Public thread → plain text. GitHub issues/PRs and HN items via their JSON APIs; anything else as stripped HTML. */
export async function fetchThread(url: string, maxComments = 15): Promise<{ title: string; text: string }> {
  const gh = url.match(/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/)
  if (gh) {
    const base = `https://api.github.com/repos/${gh[1]}/${gh[2]}/issues/${gh[3]}`
    const issue = await getJson(base)
    const comments: any[] = issue?.comments ? await getJson(`${base}/comments?per_page=${maxComments}`).catch(() => []) : []
    const parts = [`# ${issue?.title ?? ''}`, String(issue?.body ?? ''), ...comments.map(c => `--- comment by ${c?.user?.login ?? '?'}:\n${c?.body ?? ''}`)]
    return { title: String(issue?.title ?? ''), text: parts.join('\n\n').slice(0, 20_000) }
  }
  const hn = url.match(/news\.ycombinator\.com\/item\?id=(\d+)/)
  if (hn) {
    const it = await getJson(`https://hn.algolia.com/api/v1/items/${hn[1]}`)
    const strip = (s: string) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    const kids = (it?.children ?? []).slice(0, maxComments).map((c: any) => `--- ${c?.author ?? '?'}: ${strip(c?.text)}`)
    return { title: String(it?.title ?? ''), text: [`# ${it?.title ?? ''}`, strip(it?.text), ...kids].join('\n\n').slice(0, 20_000) }
  }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`)
    const html = await r.text()
    const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? ''
    const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    return { title, text: body.slice(0, 20_000) }
  } finally {
    clearTimeout(t)
  }
}

/** Short prompt: demand thread / topic → core problem + 3-5 search queries (instructions after the material). */
export function queriesPrompt(material: string, kind: 'thread' | 'topic'): string {
  return [
    kind === 'thread' ? `<demand_thread>\n${material.slice(0, 12_000)}\n</demand_thread>` : `<topic>\n${material}\n</topic>`,
    'TASK: state the core problem in one line, then write 3-5 short search queries (2-6 words each) to find where a developer ' +
      'talked through THIS problem with their AI coding assistant in a voice session. Mix symptom words (what they would ' +
      'have seen/complained about) and mechanism words (what the cause or fix would be called). Plain words, no operators.',
    'Output ONLY: {"problem": "...", "queries": ["...", "..."]}',
  ].join('\n\n')
}

export function readQueries(raw: string): { problem: string; queries: string[] } | null {
  const o = parseJsonObject(raw)
  if (!o || !Array.isArray(o.queries)) return null
  const queries = (o.queries as unknown[]).map(q => String(q ?? '').trim()).filter(Boolean).slice(0, 5)
  return queries.length ? { problem: String(o.problem ?? '').trim(), queries } : null
}

export interface SearchCluster {
  rows: number[]
  score: number
  hits: number
  queries: string[]
  firstTs: string
  lastTs: string
}
export interface SearchResult {
  clusters: SearchCluster[]
  mode: 'hybrid' | 'keyword'
  weak: boolean
  weakWhy: string
}

/** Group hits into clusters of nearby conversation rows and rank them. Pure. */
export function rankClusters(records: DbRecord[], hits: Map<number, { score: number; queries: Set<string> }>, mergeRows = 40): SearchCluster[] {
  const byId = new Map(records.map(r => [r.id, r]))
  return clusterAnchors(records, [...hits.keys()], mergeRows)
    .map(rows => {
      const qs = new Set<string>()
      let score = 0
      for (const id of rows) {
        const h = hits.get(id)!
        score += h.score
        for (const q of h.queries) qs.add(q)
      }
      const sorted = [...rows].sort((a, b) => a - b)
      return {
        rows: sorted, score: +(score * qs.size).toFixed(4), hits: rows.length, queries: [...qs],
        firstTs: byId.get(sorted[0])?.timestamp ?? '', lastTs: byId.get(sorted[sorted.length - 1])?.timestamp ?? '',
      }
    })
    .sort((a, b) => b.score - a.score)
}

/** Weak = the best cluster is matched by < 2 distinct queries or has < 3 hits. */
export function isWeak(c: SearchCluster | undefined, nQueries: number): { weak: boolean; why: string } {
  if (!c) return { weak: true, why: 'no conversation rows matched any query' }
  const minQ = Math.min(2, nQueries)
  if (c.queries.length < minQ) return { weak: true, why: `best cluster matched only ${c.queries.length}/${nQueries} queries` }
  if (c.hits < 3) return { weak: true, why: `best cluster has only ${c.hits} matching row(s)` }
  return { weak: false, why: '' }
}

/**
 * Run each query through recall() (hybrid when an embedder is available, else
 * keyword), keep only rows present in `records` (the sanitized conversation view).
 */
export async function searchSession(dbPath: string, records: DbRecord[], queries: string[], topK = 60): Promise<SearchResult> {
  const allowed = new Set(records.map(r => r.id))
  const embed = await getEmbedder().catch(() => null)
  const db = openStore(dbPath, { readonly: true })
  const hits = new Map<number, { score: number; queries: Set<string> }>()
  try {
    for (const q of queries) {
      const res = await recall(db, q, { mode: embed ? 'hybrid' : 'keyword', topK, embed: embed ?? undefined })
      for (const h of res) {
        if (!allowed.has(h.id)) continue
        const cur = hits.get(h.id) ?? { score: 0, queries: new Set<string>() }
        cur.score += h.score
        cur.queries.add(q)
        hits.set(h.id, cur)
      }
    }
  } finally {
    db.close()
  }
  const clusters = rankClusters(records, hits)
  const w = isWeak(clusters[0], queries.length)
  return { clusters, mode: embed ? 'hybrid' : 'keyword', weak: w.weak, weakWhy: w.why }
}
