/**
 * library-grid — which cards the /library grid shows.
 *
 * A rendition (a Refine studio draft: a content_items row with parent_source_id,
 * migration 009) is not its own card. It is reached from its source's card
 * ("N renditions" → the source's Refine studio). The status filter and counts use
 * the card's own status (the pill it shows), so All = Published + Draft; search
 * also matches its renditions, so a hit on a rendition's title surfaces its
 * source. A rendition whose source is not in the list stays a card.
 */

/** The content_items columns the library page and the content API routes read. */
export const CONTENT_ITEM_COLUMNS =
  'id, type, status, title, hook, body, source_session_id, source_kind, slug, published_at, created_at, updated_at, parent_source_id'

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

/** Search match on a card's text fields; `q` is already trimmed and lower-cased. */
export const matchesQuery = (i: Pick<GridItem, 'title' | 'hook' | 'body' | 'slug' | 'type'>, q: string) =>
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
  // The status filter reads the card's own status (its pill); search also reaches its renditions.
  const passes = (c: T, f: StatusFilter, q: string) => (f === 'all' || c.status === f) && members(c).some(m => matchesQuery(m, q))
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
