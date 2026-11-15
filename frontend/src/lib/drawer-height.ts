// Activity-log drawer height rules (LogsDrawer). Pure so they can be tested.
export const DRAWER_MIN_HEIGHT = 120
export const DRAWER_DEFAULT_HEIGHT = 256
const OPEN_FRACTION = 0.4 // opens at most ~40% of the viewport, so a phone keeps its chat
const MAX_FRACTION = 0.65 // never taller than this, so a readable slice of chat stays above

/** The largest height allowed in this viewport; the minimum gives way on a very short screen. */
export function clampDrawerHeight(height: number, viewportHeight: number): number {
  const max = Math.floor(viewportHeight * MAX_FRACTION)
  return Math.max(Math.min(DRAWER_MIN_HEIGHT, max), Math.min(max, Math.round(height)))
}

/** The height the drawer opens at in this viewport. */
export function defaultDrawerHeight(viewportHeight: number): number {
  return clampDrawerHeight(Math.min(DRAWER_DEFAULT_HEIGHT, viewportHeight * OPEN_FRACTION), viewportHeight)
}
