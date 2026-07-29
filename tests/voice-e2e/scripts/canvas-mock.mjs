// Minimal stand-in for the agent's canvas endpoints, to test the frontend
// /meeting-canvas page locally without deploying. Mirrors index.ts exactly:
//   GET  /canvas-stream  → SSE, resync latest 'show' on connect
//   POST /canvas         → broadcast an event to all connected canvases
import { createServer } from 'http'

const clients = new Set()
let latestShow = null

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  if (req.method === 'GET' && req.url === '/canvas-stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(`: canvas connected\n\n`)
    res.write(`data: ${JSON.stringify(latestShow ?? { kind: 'show', mode: 'idle' })}\n\n`)
    clients.add(res)
    const hb = setInterval(() => { try { res.write(`: ping\n\n`) } catch {} }, 10000)
    req.on('close', () => { clearInterval(hb); clients.delete(res) })
    console.log(`[mock] canvas connected (${clients.size})`)
    return
  }
  if (req.method === 'POST' && req.url === '/canvas') {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      try {
        const evt = JSON.parse(b || '{}')
        if (evt.kind === 'show') latestShow = evt
        const line = `data: ${JSON.stringify(evt)}\n\n`
        for (const r of clients) { try { r.write(line) } catch { clients.delete(r) } }
        console.log(`[mock] push ${evt.kind} → ${clients.size} client(s)`)
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, clients: clients.size }))
      } catch (e) { res.writeHead(400); res.end(String(e)) }
    })
    return
  }
  res.writeHead(404); res.end('nope')
}).listen(8799, () => console.log('[mock] canvas agent on http://127.0.0.1:8799'))
