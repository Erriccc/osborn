import { chromium } from '@playwright/test'
const b = await chromium.connectOverCDP('http://127.0.0.1:9280')
const p = b.contexts()[0].pages()[0]
const dir = new URL('../test-results/session-engine/', import.meta.url).pathname
const shot = (n) => p.screenshot({ path: dir + n, type: 'jpeg', quality: 66 })

// Start Fresh if the resume modal is up
const fresh = p.getByText(/Start Fresh/i).first()
if (await fresh.count()) { await fresh.click().catch(()=>{}); console.log('Start Fresh') }
await p.waitForTimeout(9000)
await shot('fu-1.jpg')

// Open Join popover (video-camera icon), fill URL, fire submit via DOM click.
await p.evaluate(() => {
  const t = [...document.querySelectorAll('button')].filter(e => { const r = e.getBoundingClientRect(); return r.y < 60 && r.width < 60 && r.width > 10 })
  t.sort((a,c)=>a.getBoundingClientRect().x-c.getBoundingClientRect().x)
  ;(t.find(e => /rect|polygon|23 7/i.test(e.innerHTML)) || t[0])?.click()
})
await p.waitForTimeout(1000)
const input = p.locator('input[placeholder*="Meet URL"], input[placeholder*="Zoom"]').first()
await input.fill('https://meet.google.com/ase-keoo-kpc')
console.log('filled:', await input.inputValue())
await p.waitForTimeout(400)
const sent = await p.evaluate(() => { const bt = document.querySelector('[data-testid="join-meeting-submit"]'); if (!bt) return 'no-btn'; if (bt.disabled) return 'disabled'; bt.click(); return 'clicked' })
console.log('submit:', sent)
await p.waitForTimeout(4000)
await shot('fu-2-sent.jpg')
await b.close()
