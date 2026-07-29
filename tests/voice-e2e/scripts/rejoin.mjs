import { chromium } from '@playwright/test'
const b = await chromium.connectOverCDP('http://127.0.0.1:9280')
const p = b.contexts()[0].pages()[0]
const dir = new URL('../test-results/session-engine/', import.meta.url).pathname
const shot = (n) => p.screenshot({ path: dir + n, type: 'jpeg', quality: 66 })

// 1) Hang up the stale meeting. The leave control is a red button in the top
//    bar; find the reddish one, else a button titled/aria "leave".
const left = await p.evaluate(() => {
  const btns = [...document.querySelectorAll('header button, button')]
  // prefer explicit label
  let b = btns.find(e => /leave|hang ?up/i.test((e.getAttribute('title') || '') + (e.getAttribute('aria-label') || '')))
  if (!b) {
    // fallback: a top-bar button whose icon stroke is red-ish
    b = btns.find(e => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e.querySelector('svg') || e).color || ''; return r.y < 60 && /rgb\((2\d\d|1[5-9]\d),\s*\d?\d,/.test(c) })
  }
  if (b) { b.click(); return { clicked: true, t: (b.getAttribute('title') || b.getAttribute('aria-label') || '') } }
  return { clicked: false }
})
console.log('leave:', JSON.stringify(left))
await p.waitForTimeout(2500)
await shot('rq-2-afterleave.jpg')

// 2) Open the join popover (video camera icon), fill URL, send bot.
const opened = await p.evaluate(() => {
  const btns = [...document.querySelectorAll('header button, button')]
  const cam = btns.find(e => e.querySelector('svg') && /video|camera|meeting/i.test((e.getAttribute('title') || '') + (e.getAttribute('aria-label') || '')))
  if (cam) { cam.click(); return true }
  return false
})
console.log('camera opened:', opened)
await p.waitForTimeout(1000)
const input = p.locator('input[placeholder*="Meet URL"], input[placeholder*="Zoom"]').first()
if (await input.count()) {
  await input.fill('https://meet.google.com/ase-keoo-kpc')
  console.log('filled:', await input.inputValue())
  const send = p.getByText(/Send bot to meeting/i).first()
  await send.click()
  console.log('sent bot')
} else {
  console.log('NO join input — need camera click; dumping top buttons')
  const t = await p.evaluate(() => [...document.querySelectorAll('header button')].map(e => (e.getAttribute('title')||e.getAttribute('aria-label')||e.textContent||'').trim().slice(0,30)))
  console.log(JSON.stringify(t))
}
await p.waitForTimeout(3000)
await shot('rq-3-sent.jpg')
await b.close()
