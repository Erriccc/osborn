// Pure viewport clamp for anchored popovers (no DOM / React imports so it can
// be unit-tested with plain tsx).
//
// Given the popover's natural (unshifted) horizontal box and the viewport
// width, return the horizontal shift in px that keeps it on screen with a
// `margin` gutter. A right-anchored menu whose trigger wraps to the left side
// of the toolbar (iPad portrait) gets a positive shift; a left-anchored one
// near the right edge gets a negative shift. A popover that already spans the
// viewport (mobile bottom sheets: inset-x-0) is centred, i.e. left alone.
export function clampPopoverShift(
  left: number,
  width: number,
  viewportWidth: number,
  margin = 8,
): number {
  if (!(viewportWidth > 0) || !(width > 0)) return 0
  // Too wide to fit with gutters: centre it (a full-width sheet => shift 0).
  if (width >= viewportWidth - 2 * margin) {
    return Math.round((viewportWidth - width) / 2 - left)
  }
  const minLeft = margin
  const maxLeft = viewportWidth - margin - width
  if (left < minLeft) return Math.round(minLeft - left)
  if (left > maxLeft) return Math.round(maxLeft - left)
  return 0
}
