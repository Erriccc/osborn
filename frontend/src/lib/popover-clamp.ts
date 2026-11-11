// Pure viewport clamp for anchored popovers (no DOM / React imports so it can
// be unit-tested with plain tsx).
//
// Given the popover's natural (unshifted) horizontal box and the viewport
// width, return the horizontal shift in px that keeps it on screen with a
// `margin` gutter. A right-anchored menu whose trigger wraps to the left side
// of the toolbar (iPad portrait) gets a positive shift; a left-anchored one
// near the right edge gets a negative shift. A popover that already spans the
// viewport (mobile bottom sheets: inset-x-0) is centred, i.e. left alone.
//
// `regionLeft`/`regionRight` bound the VISIBLE region the popover must stay
// inside; they default to the whole viewport. When a side panel (Outputs) or
// the Rooms rail is open the usable chat column is a narrow strip between them,
// so a popover can satisfy the viewport clamp yet still sit half under the
// rail/pane edge (issue #85). Passing the chat pane's edges as the region keeps
// the popover inside that strip. The region is clamped to the viewport so an
// off-screen or oversized region can never push the popover out of view.
export function clampPopoverShift(
  left: number,
  width: number,
  viewportWidth: number,
  margin = 8,
  regionLeft = 0,
  regionRight = viewportWidth,
): number {
  if (!(viewportWidth > 0) || !(width > 0)) return 0
  const lo = Math.max(0, Math.min(regionLeft, viewportWidth))
  const hi = Math.min(viewportWidth, Math.max(regionRight, lo))
  const region = hi - lo
  if (!(region > 0)) return 0
  // Too wide to fit with gutters: centre it in the region (a full-width sheet => shift 0).
  if (width >= region - 2 * margin) {
    return Math.round((lo + hi - width) / 2 - left)
  }
  const minLeft = lo + margin
  const maxLeft = hi - margin - width
  if (left < minLeft) return Math.round(minLeft - left)
  if (left > maxLeft) return Math.round(maxLeft - left)
  return 0
}
