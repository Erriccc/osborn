import { chromium } from '@playwright/test'
const b = await chromium.connectOverCDP('http://127.0.0.1:9280')
const p = b.contexts()[0].pages()[0]
const reqs = []
p.on('response', r => { const u = r.url(); if (/token|connect-room|room-code|sandbox|api\//.test(u)) reqs.push(`${r.status()} ${r.request().method()} ${u.slice(0,110)}`) })
await p.reload({ waitUntil: 'domcontentloaded' }).catch(()=>{})
await p.waitForTimeout(12000)
console.log('--- token/room/api requests ---')
reqs.slice(-20).forEach(l => console.log(l))
await b.close()
