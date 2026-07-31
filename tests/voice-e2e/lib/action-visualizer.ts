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
    // BOLD ON PURPOSE: the capture pipeline can run as slow as ~2fps
    // (heartbeat frames on static pages), so a subtle 620ms/46px ripple landed
    // on zero or one frame and was invisible in clips. Big, bright, and slow
    // (1.8s) guarantees several captured frames show the action.
    const style = document.createElement('style')
    style.textContent = `
      @keyframes osb-ripple { from { transform: translate(-50%,-50%) scale(0.25); opacity: 1 }
                              to   { transform: translate(-50%,-50%) scale(2.6); opacity: 0 } }
      .osb-ripple { position: fixed; z-index: 2147483647; width: 130px; height: 130px; border-radius: 50%;
        border: 6px solid #ffb300; background: rgba(255,179,0,0.28); pointer-events: none;
        box-shadow: 0 0 30px 8px rgba(255,179,0,0.55);
        animation: osb-ripple 1800ms ease-out forwards; }
      .osb-flash { outline: 5px solid #ffb300 !important; outline-offset: 3px !important;
        box-shadow: 0 0 24px 4px rgba(255,179,0,0.65) !important;
        transition: outline-color 1200ms ease-out; }
    `
    const attach = () => document.head?.appendChild(style)
    if (document.head) attach(); else document.addEventListener('DOMContentLoaded', attach)

    const ripple = (x: number, y: number) => {
      const el = document.createElement('div')
      el.className = 'osb-ripple'
      el.style.left = x + 'px'; el.style.top = y + 'px'
      document.body?.appendChild(el)
      setTimeout(() => el.remove(), 1850)
    }
    window.addEventListener('pointerdown', (e) => {
      ripple((e as PointerEvent).clientX, (e as PointerEvent).clientY)
      const t = e.target as HTMLElement
      if (t?.classList) { t.classList.add('osb-flash'); setTimeout(() => t.classList.remove('osb-flash'), 1400) }
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
