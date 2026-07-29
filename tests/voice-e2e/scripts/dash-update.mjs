// The agent-status popover is HOVER-triggered. Hover the "Cloud (running)"
// pill with the real mouse to reveal it, then move to + click "Update to
// v0.9.87". Screenshot the hover state and the result.
import { chromium } from '@playwright/test'

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9280'
const dir = new URL('../test-results/session-engine/', import.meta.url).pathname
const browser = await chromium.connectOverCDP(CDP)
const ctx = browser.contexts()[0]
const page = ctx.pages().find((p) => p.url().includes('voice-native')) || ctx.pages()[0]
console.log('url:', page.url())

const pill = page.getByText('Cloud (running)', { exact: true }).first()
const pb = await pill.boundingBox()
console.log('pill box:', JSON.stringify(pb))
if (!pb) { console.log('no pill'); await browser.close(); process.exit(1) }

// Real hover to open the popover.
await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2)
await page.waitForTimeout(900)
await page.screenshot({ path: dir + 'dash-hover.jpg', type: 'jpeg', quality: 68 })

const upd = page.getByText(/Update to v0\.9\.87/i).first()
let box = await upd.boundingBox().catch(() => null)
console.log('update box (after hover):', JSON.stringify(box))
let clicked = false
if (box) {
  // Move along toward the button so the hover-bridge keeps the popover open, then click.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 })
  await page.waitForTimeout(300)
  await page.mouse.down(); await page.mouse.up()
  clicked = true
} else {
  try { await upd.click({ force: true, timeout: 4000 }); clicked = true } catch (e) { console.log('force click failed:', e.message.split('\n')[0]) }
}
console.log('UPDATE_CLICKED:', clicked)
await page.waitForTimeout(3500)
await page.screenshot({ path: dir + 'dash-after-update.jpg', type: 'jpeg', quality: 68 })
const txt = await page.evaluate(() => (document.body.innerText.match(/updat\w*|installing|building|restart\w*|pulling|please wait|in progress|0\.9\.\d+/gi) || []).slice(0, 14))
console.log('status hints:', JSON.stringify(txt))
await browser.close()
