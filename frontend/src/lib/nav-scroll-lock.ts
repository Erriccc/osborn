// Pure breakpoint rules (the shared `lg` check) and the landing nav's scroll lock (no DOM / React
// imports so it can be unit-tested with plain tsx).
//
// The landing nav swaps desktop row <-> hamburger sheet at Tailwind `lg`
// (1024px). While the sheet is open the body is scroll-locked. On iPad, rotating
// portrait (834) -> landscape (1194) crosses `lg`: CSS hides the sheet AND the
// hamburger, so if the lock outlived the breakpoint the page was frozen with no
// visible control to release it. The lock must therefore only hold while the
// sheet is open AND the viewport is below `lg`.

/** Tailwind's `lg` breakpoint, where phone/tablet layouts give way to desktop ones. */
export const LG_MIN_WIDTH = 1024

/** True at Tailwind `lg` and up. */
export function isLgViewport(viewportWidth: number): boolean {
  return Number.isFinite(viewportWidth) && viewportWidth >= LG_MIN_WIDTH
}

export const LANDING_DESKTOP_QUERY = `(min-width: ${LG_MIN_WIDTH}px)`

/** Body scroll is locked only while the mobile sheet is open below `lg`. */
export function shouldLockBodyScroll(open: boolean, isDesktop: boolean): boolean {
  return open && !isDesktop
}
