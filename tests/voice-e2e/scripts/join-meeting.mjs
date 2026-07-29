// Drive the engine browser back to voice-native chat (0.9.87 agent), reconnect,
// and submit the Meet URL via the join-meeting input so the agent joins with the
// default canvas cast. Screenshots at each stage.
import { chromium } from '@playwright/test'

const CDP = 'http://127.0.0.1:9280'
const MEET = process.env.MEET_URL || 'https://meet.google.com/ase-keoo-kpc'
const CHAT = 'https://www.voice-native.com/chat?provider=gemini&voiceArch=pipeline&agent=claude&agentUrl=' + encodeURIComponent('https://osborn-d4f24f46-v2.fly.dev')
const dir = new URL('../test-results/session-engine/', import.meta.url).pathname
const shot = (p, n) => p.screenshot({ path: dir + n, type: 'jpeg', quality: 66 })

const b = await chromium.connectOverCDP(CDP)
const ctx = b.contexts()[0]
const page = ctx.pages()[0]
console.log('navigating to chat...')
await page.goto(CHAT, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForTimeout(6000)
await shot(page, 'mt-1-arrive.jpg')

// Resume modal → Start Fresh (avoid resuming a stale session).
const fresh = page.getByText(/Start Fresh/i).first()
if (await fresh.count()) { try { await fresh.click({ timeout: 5000 }); console.log('clicked Start Fresh') } catch {} }
await page.waitForTimeout(9000) // allow connect + agent_ready
await shot(page, 'mt-2-connected.jpg')

// Find the join-meeting affordance. Prefer testid; fall back to the camera icon.
async function openJoin() {
  const byId = page.locator('[data-testid="join-meeting"]')
  if (await byId.count()) { console.log('join input via testid'); return byId.first() }
  // else click a "join meeting" control to reveal the input
  const trigger = page.getByRole('button').filter({ hasText: /meeting/i }).first()
  if (await trigger.count()) { try { await trigger.click({ timeout: 3000 }) } catch {} }
  return page.locator('[data-testid="join-meeting"]').first()
}
const input = await openJoin()
console.log('join input count:', await input.count())
if (await input.count()) {
  await input.fill(MEET)
  await page.waitForTimeout(500)
  const submit = page.locator('[data-testid="join-meeting-submit"]').first()
  if (await submit.count()) { await submit.click(); console.log('submitted meeting URL') }
  else { await input.press('Enter'); console.log('pressed Enter to submit') }
} else {
  console.log('NO join input found — dumping interactive controls')
  const ctrls = await page.evaluate(() => [...document.querySelectorAll('button,input,[role=button],[data-testid]')].map(e => (e.getAttribute('data-testid') || e.getAttribute('placeholder') || e.textContent || '').trim().slice(0,40)).filter(Boolean).slice(0,40))
  console.log(JSON.stringify(ctrls))
}
await page.waitForTimeout(4000)
await shot(page, 'mt-3-after-join.jpg')
console.log('done')
await b.close()
