import { chromium } from '@playwright/test'
const b = await chromium.connectOverCDP('http://127.0.0.1:9280')
const p = b.contexts()[0].pages()[0]
console.log('URL:', p.url())
const txt = await p.evaluate(() => document.body.innerText.replace(/\s+/g,' ').slice(0,300)).catch(()=>'(eval failed)')
console.log('TEXT:', txt)
await p.screenshot({ path: new URL('../test-results/session-engine/peek.jpg', import.meta.url).pathname, type: 'jpeg', quality: 66 })
await b.close()
