import { chromium } from '@playwright/test'
const b = await chromium.connectOverCDP('http://127.0.0.1:9280')
const p = b.contexts()[0].pages()[0]
const dir = new URL('../test-results/session-engine/', import.meta.url).pathname

// 1) Open the join popover (video-camera icon in the top toolbar).
await p.evaluate(() => {
  const inTop = [...document.querySelectorAll('button')].filter(e => { const r = e.getBoundingClientRect(); return r.y < 60 && r.width < 60 && r.width > 10 })
  inTop.sort((a, c) => a.getBoundingClientRect().x - c.getBoundingClientRect().x)
  const cam = inTop.find(e => /rect|polygon|23 7|m23 7/i.test(e.innerHTML)) || inTop[0]
  cam?.click()
})
await p.waitForTimeout(1000)

// 2) Fill the URL (Playwright fill → fires React onChange).
const input = p.locator('input[placeholder*="Meet URL"], input[placeholder*="Zoom"]').first()
await input.fill('https://meet.google.com/ase-keoo-kpc')
console.log('filled:', await input.inputValue())
await p.waitForTimeout(400)

// 3) Fire the submit handler directly (bypasses visibility timeout).
const sent = await p.evaluate(() => {
  const btn = document.querySelector('[data-testid="join-meeting-submit"]')
  if (!btn) return { ok: false, why: 'no button' }
  if (btn.disabled) return { ok: false, why: 'disabled' }
  btn.click()
  return { ok: true }
})
console.log('submit:', JSON.stringify(sent))
await p.waitForTimeout(3500)
await p.screenshot({ path: dir + 'ja-sent.jpg', type: 'jpeg', quality: 66 })
await b.close()
