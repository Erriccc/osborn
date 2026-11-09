/**
 * /library/[id] — a single library item at its own shareable route.
 *
 * Renders the same <LibraryView> as /library but pre-opens the item whose id is
 * in the path, so a library detail has a real, copyable URL (bug B17). The
 * in-place modal open from the list keeps working and reflects back here.
 */
import LibraryView from '../library-view'

export default function LibraryItemPage({ params }: { params: { id: string } }) {
  return <LibraryView initialId={params.id} />
}
