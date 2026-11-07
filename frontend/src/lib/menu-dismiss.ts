// Pure dismissal rules for anchored menus / sheets (no DOM or React imports, so
// it can be unit-tested with plain tsx). The React wiring is in
// lib/use-menu-dismiss.ts.
//
// Bug 1ae9496a: the chat menus could only be closed by picking an item. Escape
// and click-outside did nothing, and a full-screen backdrop sat above the
// toggle so re-clicking it was blocked. The rules here:
//   - Escape closes the menu (and focus goes back to the toggle).
//   - A pointerdown outside every container closes it (focus is left alone so
//     we don't steal it from whatever the user clicked).
//   - A pointerdown inside a container (the menu itself, or the toggle) is
//     ignored here; the toggle's own onClick does the toggling.

export type DismissReason = 'escape' | 'outside'

export function isDismissKey(key: string | undefined | null): boolean {
  return key === 'Escape' || key === 'Esc'
}

export interface ContainsLike<N> {
  contains(node: N): boolean
}

/** True when `target` is outside every non-null container. A null target
 *  (e.g. the event came from a detached node) counts as outside. With no
 *  containers mounted at all, nothing is treated as outside: we can't tell
 *  where the menu is, so we must not close it. */
export function isOutsideTarget<N>(
  target: N | null | undefined,
  containers: ReadonlyArray<ContainsLike<N> | null | undefined>,
): boolean {
  const live = containers.filter((c): c is ContainsLike<N> => !!c)
  if (live.length === 0) return false
  if (target == null) return true
  return !live.some(c => c.contains(target))
}
