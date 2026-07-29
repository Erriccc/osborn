import type { Page } from '@playwright/test'

/**
 * Action visualizer — bakes click/action effects into the recorded video so
 * replays are legible: a pulsing ripple wherever a pointer-down lands, plus a
 * brief outline flash on the focused/clicked element. Pure DOM overlay
 * injected at page load; no post-processing, no external tool, no vendor.
 *
 * Because Stagehand drives via a separate CDP session, real pointer events
 * still dispatch to the page, so the pointerdown listener catches them.
 */
export async function installActionVisualizer(page: Page) {
  await page.addInitScript(() => {
    const style = document.createElement('style')
    style.textContent = `
      @keyframes osb-ripple { from { transform: translate(-50%,-50%) scale(0.2); opacity: 0.9 }
                              to   { transform: translate(-50%,-50%) scale(2.4); opacity: 0 } }
      .osb-ripple { position: fixed; z-index: 2147483647; width: 46px; height: 46px; border-radius: 50%;
        border: 3px solid #f5b301; background: rgba(245,179,1,0.18); pointer-events: none;
        animation: osb-ripple 620ms ease-out forwards; }
      .osb-flash { outline: 3px solid #f5b301 !important; outline-offset: 2px !important;
        transition: outline-color 500ms ease-out; }
    `
    const attach = () => document.head?.appendChild(style)
    if (document.head) attach(); else document.addEventListener('DOMContentLoaded', attach)

    const ripple = (x: number, y: number) => {
      const el = document.createElement('div')
      el.className = 'osb-ripple'
      el.style.left = x + 'px'; el.style.top = y + 'px'
      document.body?.appendChild(el)
      setTimeout(() => el.remove(), 640)
    }
    window.addEventListener('pointerdown', (e) => {
      ripple((e as PointerEvent).clientX, (e as PointerEvent).clientY)
      const t = e.target as HTMLElement
      if (t?.classList) { t.classList.add('osb-flash'); setTimeout(() => t.classList.remove('osb-flash'), 550) }
    }, true)

    // Expose a hook so the harness can flash an element the BRAIN is about to
    // act on (before the synthetic click), e.g. window.__osbFlash(selector).
    ;(window as any).__osbFlash = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null
      if (!el) return
      const r = el.getBoundingClientRect()
      ripple(r.left + r.width / 2, r.top + r.height / 2)
      el.classList.add('osb-flash'); setTimeout(() => el.classList.remove('osb-flash'), 550)
    }
  })
}
