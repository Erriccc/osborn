'use client'

import { useLayoutEffect, useState, type RefObject } from 'react'

// The chat column's own width, not the window's. With Rooms and Outputs open a
// 1280px window leaves the conversation ~440px, so the header and the Activity
// log row size themselves on `pane-sm|md|lg:` variants (tailwind.config.ts),
// which match the min-widths below against the column's data-pane attribute.
export const PANE_BREAKPOINTS = { sm: 512, md: 640, lg: 768 } as const

/** Space-separated list of the breakpoints `width` reaches ('' below sm). */
export function paneSizes(width: number): string {
  return (Object.keys(PANE_BREAKPOINTS) as (keyof typeof PANE_BREAKPOINTS)[])
    .filter((k) => width >= PANE_BREAKPOINTS[k])
    .join(' ')
}

export function usePaneSize(ref: RefObject<HTMLElement>): string {
  const [sizes, setSizes] = useState('')
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setSizes(paneSizes(el.getBoundingClientRect().width))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return sizes
}
