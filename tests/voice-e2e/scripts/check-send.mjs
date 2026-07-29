import { chromium } from '@playwright/test'
const b = await chromium.connectOverCDP('http://127.0.0.1:9280')
const p = b.contexts()[0].pages()[0]
const s = await p.evaluate(() => {
  const btn = document.querySelector('[data-testid="join-meeting-submit"]')
  const inp = document.querySelector('input[placeholder*="Meet URL"], input[placeholder*="Zoom"]')
  return {
    btn: btn ? { disabled: btn.disabled, text: btn.textContent.trim() } : null,
    inputVal: inp ? inp.value : null,
    listening: /Listening|Speaking|Thinking/.test(document.body.innerText),
  }
})
console.log(JSON.stringify(s))
await b.close()
