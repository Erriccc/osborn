// Attach to the running session-engine browser over CDP and dump what the
// blanked page actually IS: empty body (null render) vs an overlay covering
// content (z-index). Non-destructive — read-only inspection.
import { chromium } from '@playwright/test'

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9280'
const browser = await chromium.connectOverCDP(CDP)
const ctx = browser.contexts()[0]
const page = ctx.pages().find((p) => p.url().includes('voice-native')) || ctx.pages()[0]
console.log('URL:', page.url())

const info = await page.evaluate(() => {
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2
  const atCenter = document.elementFromPoint(cx, cy)
  // Enumerate full-screen-ish elements with high stacking that could cover.
  const covers = []
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    const bigW = r.width >= window.innerWidth * 0.9
    const bigH = r.height >= window.innerHeight * 0.9
    const positioned = s.position === 'fixed' || s.position === 'absolute'
    if (bigW && bigH && positioned && s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0.01) {
      covers.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 80), z: s.zIndex, bg: s.backgroundColor, pos: s.position })
    }
  }
  const bodyTxt = (document.body?.innerText || '').trim()
  return {
    bodyHTMLLen: document.body?.innerHTML.length || 0,
    bodyText: bodyTxt.slice(0, 300),
    bodyTextLen: bodyTxt.length,
    childCount: document.body?.childElementCount || 0,
    centerEl: atCenter ? { tag: atCenter.tagName.toLowerCase(), cls: (atCenter.className || '').toString().slice(0, 80) } : null,
    fullScreenCovers: covers,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    title: document.title,
  }
})
console.log(JSON.stringify(info, null, 2))
await browser.close() // detaches CDP, does NOT close the engine's browser
