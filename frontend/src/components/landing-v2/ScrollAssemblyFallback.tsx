'use client'

import { useEffect } from 'react'

/**
 * ScrollAssemblyFallback — Tier-2 of the scroll technique.
 *
 * It does NOTHING when the browser supports native CSS scroll-driven animations
 * (`animation-timeline: view()`) — in that case the parts assemble purely in CSS
 * on the compositor thread, and this island stays dormant (bails in the first
 * line of the effect).
 *
 * When native support is absent, it wires a single IntersectionObserver that
 * adds `.vn2-inview` to each `[data-vn2-part]` as it scrolls into view, which
 * triggers the same keyframes (see V2Styles) via a normal one-shot animation.
 *
 * It renders no DOM — it's a behavior-only island mounted once by ScrollAssembly.
 */
export default function ScrollAssemblyFallback() {
  useEffect(() => {
    // Native scroll-driven animations handle everything — stay out of the way.
    const supportsNative =
      typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' &&
      CSS.supports('animation-timeline: view()')

    if (supportsNative) return

    // Reduced-motion users get the static assembled state from CSS; reveal
    // immediately and skip the observer entirely.
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const parts = Array.from(
      document.querySelectorAll<HTMLElement>('[data-vn2-part]'),
    )

    if (reduce) {
      parts.forEach((el) => el.classList.add('vn2-inview'))
      return
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('vn2-inview')
            io.unobserve(entry.target) // assemble once, then release
          }
        }
      },
      { threshold: 0.2, rootMargin: '0px 0px -12% 0px' },
    )

    parts.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])

  return null
}
