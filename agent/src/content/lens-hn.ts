/**
 * lens-hn.ts — GAP CHECK via the keyless Hacker News Algolia API.
 * Fail-open: any network error → { reachable: false }, never throws.
 */

const HN_SEARCH = 'https://hn.algolia.com/api/v1/search'
const HN_TIMEOUT_MS = 10_000

export interface HnStory {
  title: string
  points: number
  num_comments: number
  url: string
}

export interface GapEvidence {
  queries: string[]
  reachable: boolean
  stories: HnStory[]
  note: string
}

async function searchHn(query: string): Promise<HnStory[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HN_TIMEOUT_MS)
  try {
    const url = `${HN_SEARCH}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=10`
    const resp = await fetch(url, { signal: ctrl.signal })
    if (!resp.ok) throw new Error(`HN HTTP ${resp.status}`)
    const data: any = await resp.json()
    const hits: any[] = Array.isArray(data?.hits) ? data.hits : []
    return hits
      .filter(h => h?.objectID && typeof h?.title === 'string')
      .map(h => ({
        title: String(h.title),
        points: Number(h.points) || 0,
        num_comments: Number(h.num_comments) || 0,
        url: `https://news.ycombinator.com/item?id=${encodeURIComponent(String(h.objectID))}`,
      }))
  } finally {
    clearTimeout(timer)
  }
}

/** Deterministic demand-vs-supply note from the HN results (no model). */
export function gapNote(stories: HnStory[], totalHits: number): string {
  if (totalHits === 0) return 'Supply: no matching HN stories found — open lane, but demand is unproven.'
  const top = stories[0]
  const demand = top.points >= 200 || top.num_comments >= 100 ? 'high' : top.points >= 30 ? 'moderate' : 'low'
  const supply = totalHits >= 15 ? 'crowded' : totalHits >= 5 ? 'some coverage' : 'thin'
  return (
    `Demand ${demand} (top related story ${top.points} pts / ${top.num_comments} comments); ` +
    `supply ${supply} (${totalHits} related stories across queries). ` +
    (supply !== 'crowded' && demand !== 'low'
      ? 'Likely gap: interest exists, few first-hand build write-ups.'
      : supply === 'crowded'
        ? 'Needs a distinct first-hand angle to stand out.'
        : 'Niche: post for credibility rather than reach.')
  )
}

export async function gapCheck(queries: string[]): Promise<GapEvidence> {
  const qs = queries.map(q => q.trim()).filter(Boolean).slice(0, 2)
  if (qs.length === 0) return { queries: [], reachable: false, stories: [], note: 'No search queries emitted.' }
  const seen = new Map<string, HnStory>()
  let ok = false
  for (const q of qs) {
    try {
      for (const s of await searchHn(q)) if (!seen.has(s.url)) seen.set(s.url, s)
      ok = true
    } catch {
      /* fail-open */
    }
  }
  if (!ok) return { queries: qs, reachable: false, stories: [], note: 'HN unreachable — gap not checked.' }
  // Keep Algolia relevance order (sorting by points surfaces loosely-related hits);
  // the demand note reads the strongest of the top-3 relevant stories.
  const all = [...seen.values()]
  const top = all.slice(0, 3)
  return { queries: qs, reachable: true, stories: top, note: gapNote([...top].sort((a, b) => b.points - a.points), all.length) }
}
