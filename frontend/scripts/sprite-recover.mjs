// Emergency recovery: restore a known-good checkpoint and re-register the osborn service.
// Usage: node scripts/sprite-recover.mjs <sprite-name> <checkpoint-id>
import { readFileSync } from 'fs'

const envFile = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
function envVar(name) {
  const line = envFile.split('\n').find(l => l.startsWith(name + '='))
  return line ? line.slice(name.length + 1).replace(/^['"]|['"]$/g, '').trim() : null
}
const TOKEN = envVar('SPRITES_API_TOKEN')
if (!TOKEN) { console.error('missing SPRITES_API_TOKEN'); process.exit(2) }

const [, , sprite, ckpt] = process.argv
if (!sprite || !ckpt) { console.error('usage: sprite-recover <sprite> <checkpoint-id>'); process.exit(2) }

const BASE = `https://api.sprites.dev/v1/sprites/${sprite}`
const H = { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

// --- NDJSON stream consumer (same shape as sprites.ts) ---
async function consumeNdjson(res, label) {
  if (!res.body) return { events: [], hasError: false }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', hasError = false, events = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const l of lines) {
      const t = l.trim()
      if (!t) continue
      try {
        const e = JSON.parse(t)
        events.push(e)
        if (e.type === 'error') { hasError = true; console.error(`[${label}] error:`, e.data) }
        else if (e.type === 'stdout' || e.type === 'stderr') process.stdout.write(`[${label}] ${e.data}\n`)
        else console.log(`[${label}] ${e.type}`, e.data ?? '')
      } catch {}
    }
  }
  return { events, hasError }
}

// ---- 1. Restore checkpoint ----
console.log(`\n[1/3] Restoring checkpoint ${ckpt}...`)
const restoreRes = await fetch(`${BASE}/checkpoints/${ckpt}/restore`, { method: 'POST', headers: H })
if (!restoreRes.ok) { console.error('restore failed:', restoreRes.status, await restoreRes.text()); process.exit(1) }
await consumeNdjson(restoreRes, 'restore')
console.log(`[1/3] Restore done`)

// ---- 2. Wait briefly for services manager to come up ----
console.log(`\n[2/3] Waiting 5s for services manager...`)
await new Promise(r => setTimeout(r, 5000))

// Check services endpoint
const svc = await fetch(`${BASE}/services`, { headers: H })
const svcText = await svc.text()
console.log(`services endpoint: http=${svc.status} body=${svcText.slice(0, 200)}`)

// ---- 3. Re-register osborn service (same shape as sprites.ts registerService) ----
// We'll load env from frontend/.env.local and embed as export lines in the bootstrap.
const envNames = [
  'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET',
  'DEEPGRAM_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY', 'SMITHERY_API_KEY', 'RECALL_API_KEY',
]
const exportLines = envNames
  .map(n => [n, envVar(n)])
  .filter(([, v]) => v)
  .map(([n, v]) => `export ${n}='${v.replace(/'/g, "'\\''")}'`)
  .join('\n')

const cmd = `set -e
export PATH="$(npm prefix -g)/bin:/.sprite/bin:\${PATH:-/usr/local/bin:/usr/bin:/bin}"
export OSBORN_API_PORT='8080'
export OSBORN_CWD='/home/sprite/workspace'
export HOME='/home/sprite'
export LIVEKIT_ROOM='osborn-${sprite.split('-').slice(1, 4).join('-').slice(0, 8)}'
${exportLines}
mkdir -p /home/sprite/workspace
if ! command -v osborn >/dev/null 2>&1; then
  echo "[osborn-recover] osborn not installed — installing..."
  npm install -g osborn@latest @anthropic-ai/claude-code > /tmp/npm-install.log 2>&1
fi
echo "[osborn-recover] Starting osborn on port 8080..."
exec osborn >> /tmp/osborn-sprite.log 2>&1
`

const serviceBody = JSON.stringify({ cmd: '/bin/bash', args: ['-c', cmd], needs: [], http_port: 8080 })

console.log(`\n[3/3] Registering osborn service...`)

// Handle 409 (service already exists → delete first)
let putRes = await fetch(`${BASE}/services/osborn`, { method: 'PUT', headers: H, body: serviceBody })
if (putRes.status === 409) {
  console.log('service exists, deleting then re-putting...')
  await putRes.body?.cancel().catch(() => {})
  await fetch(`${BASE}/services/osborn`, { method: 'DELETE', headers: H })
  putRes = await fetch(`${BASE}/services/osborn`, { method: 'PUT', headers: H, body: serviceBody })
}
if (!putRes.ok) { console.error('PUT service failed:', putRes.status, await putRes.text()); process.exit(1) }
const { hasError } = await consumeNdjson(putRes, 'register')
console.log(`[3/3] Service registered${hasError ? ' (with errors)' : ''}`)

// ---- Health poll ----
console.log(`\nPolling /health...`)
for (let i = 0; i < 20; i++) {
  try {
    const h = await fetch(`https://${sprite}-x745.sprites.app/health`, { signal: AbortSignal.timeout(3000) })
    if (h.ok) { console.log(`✅ agent healthy after ${i * 2}s:`, await h.text()); process.exit(0) }
  } catch {}
  await new Promise(r => setTimeout(r, 2000))
}
console.error(`❌ health check never succeeded after 40s`)
process.exit(1)
