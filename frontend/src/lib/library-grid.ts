/**
 * library-grid — which cards the /library grid shows.
 *
 * A rendition (a Refine studio draft: a content_items row with parent_source_id,
 * migration 009) is not its own card. It is reached from its source's card
 * ("N renditions" → the source's Refine studio). A source card is shown when the
 * source OR any of its renditions passes the status filter and the search, so a
 * published rendition or a search hit on a rendition's title still surfaces the
 * source it belongs to. A rendition whose source is not in the list stays a card.
 */

export type StatusFilter = 'all' | 'published' | 'draft'

export interface GridItem {
  id: string
  status: string
  title: string | null
  hook: string | null
  body: string | null
  slug: string | null
  type: string | null
  parent_source_id?: string | null
}

export interface LibraryGrid<T extends GridItem> {
  visible: T[]
  counts: Record<StatusFilter, number>
  /** Number of renditions per source id. */
  renditions: Map<string, number>
}

const matchesQuery = (i: GridItem, q: string) =>
  !q || [i.title, i.hook, i.body, i.slug, i.type].some(f => (f ?? '').toLowerCase().includes(q))

export function libraryGrid<T extends GridItem>(items: T[], filter: StatusFilter, query: string): LibraryGrid<T> {
  const ids = new Set(items.map(i => i.id))
  const isCardRendition = (i: T) => !!i.parent_source_id && ids.has(i.parent_source_id)
  const family = new Map<string, T[]>()
  for (const i of items) {
    if (!isCardRendition(i)) continue
    const list = family.get(i.parent_source_id!) ?? []
    list.push(i)
    family.set(i.parent_source_id!, list)
  }
  const cards = items.filter(i => !isCardRendition(i))
  const members = (c: T) => [c, ...(family.get(c.id) ?? [])]
  const passes = (c: T, f: StatusFilter, q: string) => members(c).some(m => (f === 'all' || m.status === f) && matchesQuery(m, q))
  const q = query.trim().toLowerCase()
  return {
    visible: cards.filter(c => passes(c, filter, q)),
    counts: {
      all: cards.length,
      published: cards.filter(c => passes(c, 'published', '')).length,
      draft: cards.filter(c => passes(c, 'draft', '')).length,
    },
    renditions: new Map(Array.from(family, ([id, list]) => [id, list.length])),
  }
}
