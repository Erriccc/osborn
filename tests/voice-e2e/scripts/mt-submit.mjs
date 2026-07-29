import { chromium } from '@playwright/test'
const b = await chromium.connectOverCDP('http://127.0.0.1:9280')
const p = b.contexts()[0].pages()[0]
const input = p.locator('input[placeholder*="Meet URL"], input[placeholder*="Zoom"]').first()
await input.fill('https://meet.google.com/ase-keoo-kpc')
console.log('filled:', await input.inputValue())
const btn = p.getByText(/Send bot to meeting/i).first()
await btn.click()
console.log('clicked Send bot to meeting')
await p.waitForTimeout(3500)
await p.screenshot({ path: new URL('../test-results/session-engine/mt-sent.jpg', import.meta.url).pathname, type: 'jpeg', quality: 66 })
await b.close()
