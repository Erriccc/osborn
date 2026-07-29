import { chromium } from '@playwright/test'
const b = await chromium.connectOverCDP('http://127.0.0.1:9280')
const p = b.contexts()[0].pages()[0]
const logs = []
p.on('console', m => logs.push(`[${m.type()}] ${m.text()}`.slice(0,180)))
// trigger a fresh reload to capture connect logs
await p.reload({ waitUntil: 'domcontentloaded' }).catch(()=>{})
await p.waitForTimeout(12000)
console.log('URL:', p.url())
console.log('--- console (connect/livekit/room/error) ---')
logs.filter(l => /connect|livekit|room|token|error|fail|agent|sandbox|429|401|403|500/i.test(l)).slice(-25).forEach(l => console.log(l))
await b.close()
