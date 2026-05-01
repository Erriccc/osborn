// Recovery: re-register the osborn service WITHOUT restoring any checkpoint.
// Preserves the current sprite filesystem exactly as-is. Only revives the
// services manager by registering osborn fresh.
//
// Usage: node scripts/sprite-register-only.mjs <sprite-name>
import { readFileSync } from 'fs'

const envFile = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
function envVar(name) {
  const line = envFile.split('\n').find(l => l.startsWith(name + '='))
  return line ? line.slice(name.length + 1).replace(/^['"]|['"]$/g, '').trim() : null
}
const TOKEN = envVar('SPRITES_API_TOKEN')
if (!TOKEN) { console.error('missing SPRITES_API_TOKEN'); process.exit(2) }

const sprite = process.argv[2]
if (!sprite) { console.error('usage: sprite-register-only <sprite-name>'); process.exit(2) }

const BASE = `https://api.sprites.dev/v1/sprites/${sprite}`
const H = { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

async function consumeNdjson(res, label) {
  if (!res.body) return { hasError: false, events: [] }
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
        if (e.type === 'error') { hasError = true; console.error(`[${label}] ❌`, e.data) }
        else if (e.type === 'stdout' || e.type === 'stderr') console.log(`[${label}] ${e.data}`)
        else console.log(`[${label}] ${e.type}`, e.data ?? '')
      } catch {}
    }
  }
  return { hasError, events }
}

// Derive per-user room slug from sprite name: "osborn-d4f24f46-6e3" → "osborn-d4f24f46"
const roomName = sprite.split('-').slice(0, 3).join('-').replace(/-[^-]+$/, '')

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
export LIVEKIT_ROOM='${roomName}'
${exportLines}
mkdir -p /home/sprite/workspace
if ! command -v osborn >/dev/null 2>&1; then
  echo "[osborn-recover] osborn missing — installing fresh (bg) ..."
  npm install -g osborn@latest @anthropic-ai/claude-code > /tmp/npm-install.log 2>&1 &
  NPM_PID=$!
  START=$SECONDS
  while kill -0 $NPM_PID 2>/dev/null; do
    sleep 20
    echo "[osborn-recover] install t=$((SECONDS-START))s lines=$(wc -l < /tmp/npm-install.log 2>/dev/null || echo 0)"
    if [ $((SECONDS-START)) -gt 600 ]; then
      kill -9 $NPM_PID 2>/dev/null || true
      break
    fi
  done
  wait $NPM_PID 2>/dev/null || true
fi
echo "[osborn-recover] Starting osborn on port 8080..."
exec osborn >> /tmp/osborn-sprite.log 2>&1
`

const body = JSON.stringify({
  cmd: '/bin/bash',
  args: ['-c', cmd],
  needs: [],
  http_port: 8080,
})

console.log(`[1/3] Sprite state...`)
const stRes = await fetch(BASE, { headers: H })
const st = await stRes.json()
console.log(`      sprite=${st.status} last_running=${st.last_running_at}`)

console.log(`\n[2/3] PUT /services/osborn (no checkpoint restore)...`)
let putRes = await fetch(`${BASE}/services/osborn`, { method: 'PUT', headers: H, body })
console.log(`      HTTP ${putRes.status}`)

if (putRes.status === 409) {
  console.log(`      409 = already exists, DELETE + re-PUT`)
  await putRes.body?.cancel().catch(() => {})
  const del = await fetch(`${BASE}/services/osborn`, { method: 'DELETE', headers: H })
  console.log(`      DELETE ${del.status}`)
  await del.text()
  putRes = await fetch(`${BASE}/services/osborn`, { method: 'PUT', headers: H, body })
  console.log(`      second PUT HTTP ${putRes.status}`)
}

if (putRes.status === 500) {
  const t = await putRes.text()
  console.error(`      500: ${t.slice(0, 300)}`)
  if (t.includes('services manager not started')) {
    console.error(`\n❌ Services manager is dead and can't be revived via PUT alone.`)
    console.error(`   Sprite needs a stop+start (keeps filesystem, reinitializes manager).`)
    console.error(`   Next step: POST /v1/sprites/${sprite}/stop, then POST /start — decide with user first.`)
    process.exit(3)
  }
  process.exit(1)
}

if (!putRes.ok) { console.error(`PUT failed: ${await putRes.text()}`); process.exit(1) }

await consumeNdjson(putRes, 'register')

console.log(`\n[3/3] Health poll...`)
const previewUrl = st.url
for (let i = 0; i < 30; i++) {
  try {
    const h = await fetch(`${previewUrl}/health`, { signal: AbortSignal.timeout(3000) })
    if (h.ok) { console.log(`✅ Healthy after ${i * 2}s:`, await h.text()); process.exit(0) }
  } catch {}
  await new Promise(r => setTimeout(r, 2000))
}
console.error(`❌ health check never succeeded (60s)`)
process.exit(1)
