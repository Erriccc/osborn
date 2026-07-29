import { chromium } from '@playwright/test'
const b = await chromium.connectOverCDP('http://127.0.0.1:9280')
const p = b.contexts()[0].pages()[0]
const dir = new URL('../test-results/session-engine/', import.meta.url).pathname
const shot = (n) => p.screenshot({ path: dir + n, type: 'jpeg', quality: 66 })

// Start Fresh
const fresh = p.getByText(/Start Fresh/i).first()
if (await fresh.count()) { await fresh.click(); console.log('clicked Start Fresh') }
await p.waitForTimeout(11000) // connect + agent_ready
await shot('fj-1-connected.jpg')

// Open the Join-a-meeting popover: click the video-camera icon. Find the button
// whose SVG is a video/camera glyph (has a <rect> or path with polygon) in the
// top toolbar; fall back to the first toolbar icon button.
const opened = await p.evaluate(() => {
  const inTop = [...document.querySelectorAll('button')].filter(e => { const r = e.getBoundingClientRect(); return r.y < 60 && r.width < 60 && r.width > 10 })
  // the join/camera icon is typically the left-most icon of the right cluster
  inTop.sort((a, bb) => a.getBoundingClientRect().x - bb.getBoundingClientRect().x)
  const cam = inTop.find(e => /rect|polygon|23 7|m23 7/i.test(e.innerHTML)) || inTop[0]
  if (cam) { cam.click(); return { clicked: true, n: inTop.length } }
  return { clicked: false, n: inTop.length }
})
console.log('open join:', JSON.stringify(opened))
await p.waitForTimeout(1200)
await shot('fj-2-joinpopover.jpg')

const input = p.locator('input[placeholder*="Meet URL"], input[placeholder*="Zoom"]').first()
if (await input.count()) {
  await input.fill('https://meet.google.com/ase-keoo-kpc')
  console.log('filled:', await input.inputValue())
  await p.getByText(/Send bot to meeting/i).first().click()
  console.log('SENT BOT')
} else {
  console.log('no join input yet')
}
await p.waitForTimeout(3000)
await shot('fj-3-sent.jpg')
await b.close()
