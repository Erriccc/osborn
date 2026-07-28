import { chromium } from '@playwright/test'
const b = await chromium.launch({ channel: 'chrome', headless: true })
const p = await b.newPage()
await p.goto('https://www.voice-native.com', { waitUntil: 'networkidle', timeout: 45000 })
await p.waitForTimeout(2000)
await p.getByRole('button', { name: 'Connect without account' }).click()
await p.waitForTimeout(3000)
console.log('URL after click:', p.url())
const els = await p.$$eval('button, input, a[href]', els => els.map(e => ({
  tag: e.tagName, text: (e.textContent || e.getAttribute('placeholder') || '').trim().slice(0, 60), type: e.getAttribute('type'), testid: e.getAttribute('data-testid'),
})).filter(x => x.text))
console.log(JSON.stringify(els).slice(0, 1800))
await p.screenshot({ path: '/tmp/vn-guest.png' })
await b.close()
