// Drive the running session-engine browser (over CDP, logged in as osbornojure)
// to the voice-native dashboard, screenshot it, and dump update-related controls.
// Non-destructive: connectOverCDP + close() only detaches, doesn't close the engine.
import { chromium } from '@playwright/test'

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9280'
const GOTO = process.env.GOTO || 'https://www.voice-native.com/dashboard'
const OUT = new URL('../test-results/session-engine/dash.jpg', import.meta.url).pathname

const browser = await chromium.connectOverCDP(CDP)
const ctx = browser.contexts()[0]
const page = ctx.pages().find((p) => p.url().includes('voice-native')) || ctx.pages()[0]
console.log('before:', page.url())
await page.goto(GOTO, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForTimeout(4000)
console.log('after:', page.url())
await page.screenshot({ path: OUT, type: 'jpeg', quality: 65 })
console.log('screenshot →', OUT)

// Surface anything update/version related.
const hits = await page.evaluate(() => {
  const out = []
  for (const el of Array.from(document.querySelectorAll('button, a, [role="button"]'))) {
    const t = (el.textContent || '').trim().replace(/\s+/g, ' ')
    if (t && /updat|upgrad|version|0\.9\.|latest|restart|resume|agent|machine|health/i.test(t)) {
      const r = el.getBoundingClientRect()
      out.push({ t: t.slice(0, 60), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), vis: r.width > 0 && r.height > 0 })
    }
  }
  const bodyHits = (document.body.innerText.match(/0\.9\.\d+|update available|up to date|latest/gi) || []).slice(0, 10)
  return { controls: out.slice(0, 25), bodyHits }
})
console.log(JSON.stringify(hits, null, 2))
await browser.close()
