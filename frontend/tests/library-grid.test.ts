// Run: cd frontend && npx --yes tsx tests/library-grid.test.ts
// /library grid: Refine studio renditions (parent_source_id set) are not cards of
// their own. They count on their source's card, and a filter or search that
// matches only a rendition still shows that source.
import { libraryGrid, type GridItem } from '../src/lib/library-grid'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) } catch (e: any) { fail++; console.log('FAIL', name, String(e?.message || e).slice(0, 400)) }
}
const eq = (a: any, b: any, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const item = (id: string, o: Partial<GridItem> = {}): GridItem =>
  ({ id, status: 'draft', title: id, hook: null, body: null, slug: null, type: 'text_post', parent_source_id: null, ...o })

// The live case: one period page and four drafts generated from it.
const items = [
  item('p12', { title: 'Period 12: Build a content library' }),
  item('r1', { title: 'Automated AI Session Content Library', type: 'x_thread', parent_source_id: 'p12' }),
  item('r2', { title: 'Building an Automated AI-Driven Content Library', type: 'blog', parent_source_id: 'p12' }),
  item('r3', { title: 'How We Built an Automated AI-Driven Content Library', type: 'blog', parent_source_id: 'p12', status: 'published' }),
  item('r4', { title: 'Automated Content Library – Case Study', type: 'x_thread', parent_source_id: 'p12' }),
  item('p13', { title: 'Period 13: Ship the ingest', status: 'published' }),
]
const ids = (xs: GridItem[]) => xs.map(x => x.id)

t('renditions are not cards; the source carries their count', () => {
  const g = libraryGrid(items, 'all', '')
  eq(ids(g.visible), ['p12', 'p13'], 'visible')
  eq(g.renditions.get('p12'), 4, 'p12 renditions')
  eq(g.renditions.get('p13'), undefined, 'p13 renditions')
})
t('counts are cards, and a published rendition counts its source as published', () => {
  eq(libraryGrid(items, 'all', '').counts, { all: 2, published: 2, draft: 1 }, 'counts')
})
t('published filter shows the draft source of a published rendition', () => {
  eq(ids(libraryGrid(items, 'published', '').visible), ['p12', 'p13'], 'published')
  eq(ids(libraryGrid(items, 'draft', '').visible), ['p12'], 'draft')
})
t('search finds a rendition by title and shows its source card', () => {
  eq(ids(libraryGrid(items, 'all', 'case study').visible), ['p12'], 'search')
  eq(ids(libraryGrid(items, 'all', 'ingest').visible), ['p13'], 'search source')
  eq(ids(libraryGrid(items, 'all', 'nothing like this').visible), [], 'no match')
})
t('filter and search apply to the same member', () => {
  // "case study" matches r4, a draft; the published filter must not show p12 for it.
  eq(ids(libraryGrid(items.filter(i => i.id !== 'r3'), 'published', 'case study').visible), [], 'mixed')
})
t('a rendition whose source is gone stays a card', () => {
  const g = libraryGrid([item('r9', { parent_source_id: 'missing', type: 'blog' })], 'all', '')
  eq(ids(g.visible), ['r9'], 'orphan')
  eq(g.counts.all, 1, 'orphan count')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
