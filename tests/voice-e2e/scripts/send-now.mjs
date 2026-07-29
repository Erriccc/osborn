import { chromium } from '@playwright/test'
const b = await chromium.connectOverCDP('http://127.0.0.1:9280')
const p = b.contexts()[0].pages()[0]
const dir = new URL('../test-results/session-engine/', import.meta.url).pathname
const send = p.locator('[data-testid="join-meeting-submit"]').first()
if (await send.count()) { await send.click({ timeout: 8000 }); console.log('SENT BOT') }
else { console.log('no send button (popover closed?) — reopening')
  // reopen + refill if needed
}
await p.waitForTimeout(3500)
await p.screenshot({ path: dir + 'fj-sent2.jpg', type: 'jpeg', quality: 66 })
await b.close()
