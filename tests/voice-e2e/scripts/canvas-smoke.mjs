// Local smoke test for the meeting canvas: open the page, push a 'show notes'
// and a 'say', screenshot the result. Proves the SSE → render pipe end-to-end.
import { chromium } from '@playwright/test'

const FRONTEND = process.env.CANVAS_FRONTEND || 'http://localhost:3010'
const AGENT = process.env.CANVAS_AGENT || 'http://127.0.0.1:8799'
const OUT = new URL('../test-results/canvas-smoke.jpg', import.meta.url).pathname

const post = (body) => fetch(`${AGENT}/canvas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const url = `${FRONTEND}/meeting-canvas?agent=${encodeURIComponent(AGENT)}`
console.log('opening', url)
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }) // SSE keeps network open → don't wait for idle
await page.waitForTimeout(3000) // let EventSource connect

console.log('push show notes:', await post({ kind: 'show', mode: 'notes', title: 'Q3 pricing — key points', items: ['Enterprise tier lands at $2k/mo', 'Annual commit unlocks 20% off', 'Pilot: 3 seats free for 30 days', 'Decision owner: Dana (needs security review)'] }))
console.log('push say:', await post({ kind: 'say', text: 'Here are the three pricing points we just discussed.' }))
await page.waitForTimeout(2000)

await page.screenshot({ path: OUT, type: 'jpeg', quality: 70 })
console.log('screenshot →', OUT)
// Verify the DOM actually rendered the notes (not just a blank canvas).
const bodyText = await page.evaluate(() => document.body.innerText)
console.log('RENDERED_OK:', bodyText.includes('Q3 pricing') && bodyText.includes('Enterprise tier'))
console.log('CAPTION_OK:', bodyText.includes('three pricing points'))
await browser.close()
