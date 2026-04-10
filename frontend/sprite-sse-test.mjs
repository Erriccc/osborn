// SSE validation test: replace osborn with a minimal Node HTTP server that
// also serves /events as SSE. Open a persistent SSE connection. Watch whether
// the sprite stays in `running` state (vs transitioning to `warm`).
//
// This isolates the platform-level question: does an open TCP connection
// actually keep Sprites from hibernating? The docs claim yes, but the
// keepalive-pinging test showed short HTTP requests don't count as activity.
//
// Success = sprite status stays `running` for the whole 2 minutes of SSE open.
// Failure = sprite transitions to `warm` even with the SSE connection open.

import { readFileSync } from 'node:fs'

const ENV_PATH = '/Users/newupgrade/Desktop/Developer/osborn/frontend/.env.local'
const env = readFileSync(ENV_PATH, 'utf-8')
const get = (k) => {
  const line = env.split('\n').find(l => l.startsWith(k + '='))
  if (!line) return ''
  return line.slice(k.length + 1).trim().replace(/^"|"$/g, '')
}

const TOKEN = get('SPRITES_API_TOKEN')
const SPRITE = 'osborn-e5a77be1-2f1'
const BASE = 'https://api.sprites.dev'

// Minimal Node HTTP+SSE server, written as a bash heredoc so we avoid nested JSON escaping.
// Responds on /health (plain JSON) and /events (SSE stream that just pings every 15s).
const bootstrap = `
set -e
cat > /tmp/sse-server.mjs << 'SCRIPTEOF'
import http from 'node:http'
http.createServer((req, res) => {
  const u = req.url || ''
  if (u === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"status":"ok","test":"sse"}')
    return
  }
  if (u === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': sse connected at ' + new Date().toISOString() + '\\n\\n')
    const iv = setInterval(() => {
      try { res.write(': ping ' + Date.now() + '\\n\\n') } catch {}
    }, 15000)
    req.on('close', () => { clearInterval(iv); console.log('[sse-test] client closed') })
    return
  }
  res.writeHead(404)
  res.end()
}).listen(8080, '0.0.0.0', () => console.log('[sse-test] listening on 8080 at ' + new Date().toISOString()))
SCRIPTEOF
exec node /tmp/sse-server.mjs >> /tmp/sse-server.log 2>&1
`.trim()

const serviceBody = {
  cmd: '/bin/bash',
  args: ['-c', bootstrap],
  needs: [],
  http_port: 8080,
}

const hdr = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

async function consumeStream(res, label, maxEvents = 20) {
  if (!res.body) return
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let count = 0
  while (count < maxEvents) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const p of parts) {
      if (!p.trim()) continue
      count++
      try {
        const e = JSON.parse(p)
        console.log(`  [${label}] ${e.type}${e.data ? ': ' + e.data.substring(0, 80) : ''}`)
      } catch {}
    }
  }
  try { await reader.cancel() } catch {}
}

async function checkSpriteState(tag) {
  const r = await fetch(`${BASE}/v1/sprites/${SPRITE}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  const d = await r.json()
  console.log(`  ${tag}  sprite status=${d.status}, last_running_at=${d.last_running_at}, last_warming_at=${d.last_warming_at}`)
  return d.status
}

async function main() {
  const t0 = Date.now()
  const tag = () => `[T+${Math.floor((Date.now() - t0) / 1000).toString().padStart(3, '0')}s]`

  console.log(`=== SSE VALIDATION TEST at ${new Date().toISOString()} ===\n`)

  // Step 1: DELETE existing service
  console.log(`${tag()} Step 1: DELETE existing service`)
  const del = await fetch(`${BASE}/v1/sprites/${SPRITE}/services/osborn`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` },
  })
  console.log(`  status: ${del.status}`)
  try { await del.body?.cancel() } catch {}

  // Step 2: PUT new service with SSE server
  console.log(`\n${tag()} Step 2: PUT SSE service`)
  const put = await fetch(`${BASE}/v1/sprites/${SPRITE}/services/osborn`, {
    method: 'PUT', headers: hdr, body: JSON.stringify(serviceBody),
  })
  console.log(`  status: ${put.status}`)
  await consumeStream(put, 'PUT', 5)

  // Step 3: POST start
  console.log(`\n${tag()} Step 3: POST start`)
  const startRes = await fetch(`${BASE}/v1/sprites/${SPRITE}/services/osborn/start`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` },
  })
  console.log(`  status: ${startRes.status}`)
  await consumeStream(startRes, 'START', 5)

  // Step 4: Poll /health
  console.log(`\n${tag()} Step 4: Poll /health`)
  let healthy = false
  for (let i = 0; i < 20; i++) {
    try {
      const h = await fetch(`https://${SPRITE}-x745.sprites.app/health`, { signal: AbortSignal.timeout(4000) })
      if (h.ok) {
        const body = await h.text()
        console.log(`  health 200: ${body}`)
        healthy = true
        break
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2000))
  }
  if (!healthy) {
    console.log('  HEALTH NEVER PASSED — bailing')
    process.exit(1)
  }

  // Step 5: open SSE and hold it
  console.log(`\n${tag()} Step 5: open SSE to /events`)
  const ac = new AbortController()
  const sseRes = await fetch(`https://${SPRITE}-x745.sprites.app/events`, {
    signal: ac.signal,
    headers: { 'Accept': 'text/event-stream' },
  })
  console.log(`  SSE status: ${sseRes.status}`)
  if (!sseRes.body) {
    console.log('  SSE no body — bailing')
    process.exit(1)
  }

  // Read SSE in background so the connection stays open
  const reader = sseRes.body.getReader()
  let sseMsgs = 0
  let sseOpen = true
  const sseReadLoop = (async () => {
    const dec = new TextDecoder()
    try {
      while (sseOpen) {
        const { done, value } = await reader.read()
        if (done) { console.log(`  SSE reader done (T+${Math.floor((Date.now() - t0) / 1000)}s)`); break }
        const chunk = dec.decode(value)
        if (chunk.includes('ping') || chunk.includes('sse connected')) sseMsgs++
      }
    } catch (e) {
      console.log(`  SSE reader error: ${e.message}`)
    }
  })()

  await new Promise(r => setTimeout(r, 2000))
  console.log(`  ${tag()} SSE connected, messages received so far: ${sseMsgs}`)

  // Step 6: periodic state checks while SSE is open
  console.log(`\n${tag()} Step 6: watch sprite state with SSE held open (120s)`)
  for (const cp of [15, 30, 60, 90, 120]) {
    const target = t0 + (cp * 1000)
    while (Date.now() < target) await new Promise(r => setTimeout(r, 500))
    console.log(`${tag()} checkpoint`)
    await checkSpriteState(tag())
    console.log(`  ${tag()} SSE messages received: ${sseMsgs}`)
  }

  // Step 7: close SSE and check state after
  console.log(`\n${tag()} Step 7: close SSE`)
  sseOpen = false
  ac.abort()
  try { await reader.cancel() } catch {}
  await sseReadLoop.catch(() => {})

  console.log(`\n${tag()} Step 8: wait 45s after SSE close`)
  await new Promise(r => setTimeout(r, 45000))
  console.log(`${tag()} final state`)
  await checkSpriteState(tag())

  console.log(`\n=== DONE in ${Math.floor((Date.now() - t0) / 1000)}s, total SSE messages: ${sseMsgs} ===`)
}

main().catch(e => { console.error('ERROR:', e); process.exit(1) })
