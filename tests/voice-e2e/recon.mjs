import { chromium } from '@playwright/test'
const b = await chromium.launch({ channel: 'chrome', headless: true })
const p = await b.newPage()
await p.goto('https://www.voice-native.com', { waitUntil: 'networkidle', timeout: 45000 })
await p.waitForTimeout(3000)
const buttons = await p.$$eval('button, a[href], input', els => els.map(e => ({
  tag: e.tagName, text: (e.textContent || e.getAttribute('placeholder') || '').trim().slice(0, 50), href: e.getAttribute('href'), id: e.id, testid: e.getAttribute('data-testid'),
})).filter(x => x.text || x.href))
console.log(JSON.stringify(buttons, null, 1).slice(0, 2500))
await p.screenshot({ path: '/tmp/vn-landing.png', fullPage: false })
await b.close()
