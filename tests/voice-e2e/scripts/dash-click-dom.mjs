// Invoke the "Update to v0.9.87" button's onClick directly in the DOM,
// bypassing the hover-gated visibility. Then watch for a confirm dialog and
// report status.
import { chromium } from '@playwright/test'
const b = await chromium.connectOverCDP('http://127.0.0.1:9280')
const p = b.contexts()[0].pages().find((x) => x.url().includes('voice-native'))
const dir = new URL('../test-results/session-engine/', import.meta.url).pathname
console.log('url:', p.url())

const r = await p.evaluate(() => {
  const els = [...document.querySelectorAll('button,a,[role=button]')]
  const btn = els.find((e) => /Update to v0\.9\.87/i.test(e.textContent || ''))
  if (!btn) return { found: false }
  const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true'
  btn.scrollIntoView()
  btn.click()
  return { found: true, disabled, text: (btn.textContent || '').trim().slice(0, 40) }
})
console.log('click result:', JSON.stringify(r))
await p.waitForTimeout(1500)
await p.screenshot({ path: dir + 'dash-clicked.jpg', type: 'jpeg', quality: 68 })

// A confirm dialog may appear — surface its buttons.
const confirm = await p.evaluate(() => {
  const btns = [...document.querySelectorAll('button,[role=button]')].map((e) => (e.textContent || '').trim()).filter(Boolean)
  return { buttons: btns.slice(0, 20), hasConfirm: /confirm|yes|update|proceed/i.test(document.body.innerText) }
})
console.log('post-click buttons:', JSON.stringify(confirm))
await p.waitForTimeout(2000)
const after = await p.evaluate(() => (document.body.innerText.match(/updat\w*|installing|building|pulling|restart\w*|in progress|please wait|0\.9\.\d+/gi) || []).slice(0, 14))
console.log('after text:', JSON.stringify(after))
await b.close()
