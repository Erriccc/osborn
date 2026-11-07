// Pure breakpoint / scroll-lock rules for the landing nav (no DOM / React
// imports so it can be unit-tested with plain tsx).
//
// The landing nav swaps desktop row <-> hamburger sheet at Tailwind `lg`
// (1024px). While the sheet is open the body is scroll-locked. On iPad, rotating
// portrait (834) -> landscape (1194) crosses `lg`: CSS hides the sheet AND the
// hamburger, so if the lock outlived the breakpoint the page was frozen with no
// visible control to release it. The lock must therefore only hold while the
// sheet is open AND the viewport is below `lg`.

export const LANDING_DESKTOP_MIN_WIDTH = 1024
export const LANDING_DESKTOP_QUERY = `(min-width: ${LANDING_DESKTOP_MIN_WIDTH}px)`

/** True when the viewport shows the desktop nav row (Tailwind `lg` and up). */
export function isLandingDesktop(viewportWidth: number): boolean {
  return Number.isFinite(viewportWidth) && viewportWidth >= LANDING_DESKTOP_MIN_WIDTH
}

/** Body scroll is locked only while the mobile sheet is open below `lg`. */
export function shouldLockBodyScroll(open: boolean, isDesktop: boolean): boolean {
  return open && !isDesktop
}
