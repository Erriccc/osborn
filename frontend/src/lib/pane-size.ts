// Chat column widths for the `pane-sm|md|lg|xl:` Tailwind variants
// (tailwind.config.ts), matched against the column's data-pane attribute, which
// use-pane-size.ts keeps current. The thresholds are the column's width, not the
// window's: Rooms and Outputs narrow it (docs/design-direction.md header tiers).
export const PANE_BREAKPOINTS = { sm: 512, md: 640, lg: 768, xl: 1024 } as const

/** Space-separated list of the breakpoints `width` reaches ('' below sm). */
export function paneSizes(width: number): string {
  return (Object.keys(PANE_BREAKPOINTS) as (keyof typeof PANE_BREAKPOINTS)[])
    .filter((k) => width >= PANE_BREAKPOINTS[k])
    .join(' ')
}
