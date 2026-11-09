/**
 * /library — the user's content library.
 *
 * The view itself lives in ./library-view (a client component) so the sibling
 * /library/[id] route can render the SAME view pre-opened to one item, giving
 * every library page its own shareable URL while the in-place modal open keeps
 * working (bug B17 — detail used to open as a modal stuck at /library).
 */
import LibraryView from './library-view'

export default function LibraryPage() {
  return <LibraryView />
}
