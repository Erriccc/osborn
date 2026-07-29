import { chromium } from '@playwright/test'
const b = await chromium.connectOverCDP('http://127.0.0.1:9280')
const p = b.contexts()[0].pages()[0]
const before = await p.evaluate(() => localStorage.getItem('osborn-connection-mode'))
await p.evaluate(() => localStorage.setItem('osborn-connection-mode', 'local'))
console.log('connection-mode was:', before, '-> now local')
await p.reload({ waitUntil: 'domcontentloaded' })
await p.waitForTimeout(14000)
const txt = await p.evaluate(() => document.body.innerText.replace(/\s+/g,' ').slice(0,120))
console.log('after reload:', txt)
await p.screenshot({ path: new URL('../test-results/session-engine/localmode.jpg', import.meta.url).pathname, type:'jpeg', quality:66 })
await b.close()
