'use client'

import { useLayoutEffect, useState } from 'react'
import { paneSizes } from './pane-size'

/** A callback ref for the chat column plus its data-pane value. A callback ref,
 *  because the column mounts only once the agent connects (VoiceRoom renders its
 *  waiting screen first) and remounts after a reconnect. */
export function usePaneSize(): [(el: HTMLElement | null) => void, string] {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [sizes, setSizes] = useState('')
  useLayoutEffect(() => {
    if (!el) return
    const update = () => setSizes(paneSizes(el.getBoundingClientRect().width))
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, sizes]
}
